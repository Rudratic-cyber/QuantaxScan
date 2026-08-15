import { assetsTable, observationsTable, collectionRunsTable, networkFlowsTable } from "@workspace/db/schema";
import type { ScopedTx } from "@workspace/db/org-scope";
import {
  collectSourceObservations,
  collectDependencyObservations,
  collectCertificateObservations,
  certificatesIn,
  collectDataAtRestObservations,
  computeFingerprint,
  dependencyLocationPrefix,
  ecosystemsIn,
  fingerprintForObservation,
  lockfilesIn,
  observationsFromTlsHandshake,
  type DataAtRestStoreInput,
  type DataAtRestStoreResult,
  type RawObservation,
  type Surface,
  type TlsHandshakeResult,
  collectProtocolConfigObservations,
  protocolConfigLocation,
  protocolConfigsIn,
  classifyKmsKeys,
  collectNetworkFlowObservations,
  type NetworkFlowCollectionResult,
  type NetworkFlowRecordInput,
  observationsFromOtFleet,
  OT_FLEET_LOCATION_PREFIX,
  type OtFleetInput,
  type RecognisedProtocolConfig,
  type KmsKeyDescription,
  type KmsKeyOutcome,
  collectEndpointObservations,
  type EndpointHostReport,
  type EndpointHostResult,
} from "@workspace/collectors";
import type { DataClassification } from "@workspace/db/classification";
import type { RetentionMode } from "@workspace/db/schema";
import { and, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";

/**
 * Dual-write step of the A1/A2 migration (docs/Claude/04-architecture.md
 * §"Migration path", step 3): alongside the existing `scans`/`findings`
 * writes, also persist the same detection as `assets`/`observations`/
 * `collection_runs`. Both tables are written from every `POST /scans` and
 * `POST /scans/multi` call during the transition; reads have not been cut
 * over yet (see docs/Claude/04-architecture.md for why that is a
 * deliberately separate follow-up, not done in this change).
 *
 * Since B2 this module also serves `POST /projects/:id/dependencies`, and the
 * surface is no longer hardcoded. It used to be: the fingerprint call read
 * `surface: "source"` as a literal, which is the single reason a fully
 * built and tested `DependencyCollector` had nowhere to write for a whole
 * release. The surface is now derived per observation by
 * `fingerprintForObservation()` in `@workspace/collectors`, from the
 * `locationDetail` discriminator the collector already sets — so a third
 * collector needs a fingerprint rule and a run descriptor, not an edit here.
 * B4's `ingestCertificateObservations()` below is exactly that: a fourth
 * `IngestSpec` shape reusing the same shared `ingestObservations()`, proving
 * the claim rather than repeating it.
 *
 * Takes the caller's already-scoped transaction and uses it directly rather
 * than opening one of its own. That is not a style preference: a second scope
 * opened inside an existing one is the single failure mode in the isolation
 * mechanism that returns another tenant's rows rather than none, so `withOrg`
 * refuses to nest and this function must be handed the `ScopedTx` instead.
 *
 * `organizationId` is required, with no default. A hardcoded organisation
 * default is exactly the bug the whole mechanism exists to prevent — and the
 * policies' `WITH CHECK` would reject a wrong value here anyway.
 */

export interface IngestResult {
  collectionRunId: number;
  assetsCreated: number;
  assetsUpdated: number;
  observationsCreated: number;
  assetsMarkedGone: number;
}

/**
 * What this run actually looked at, and therefore the only assets it is
 * entitled to declare `gone`.
 *
 * This is the highest-consequence input to the whole module. The predicate
 * used to be "every active asset at a scanned location, surface = source",
 * with `source` written inline; generalising it without also generalising the
 * *scope* would let a dependency submission mark every source asset in the
 * project gone — a silent mass false remediation, and one that a test with
 * only dependency fixtures would never notice. So the scope is always paired
 * with the surface it belongs to and is never open-ended.
 *
 *  - `locations` — the exact `<repo>:<path>` values a source run rescanned.
 *    Files it was not given say nothing about themselves.
 *  - `prefixes` — the `<repo>:pkg:<ecosystem>/` families a dependency run
 *    read a lockfile for. A submission of only `requirements.txt` has
 *    observed nothing about the npm tree and must leave it alone.
 */
type ReobservationScope =
  | { kind: "locations"; locations: string[] }
  | { kind: "prefixes"; prefixes: string[] };

interface IngestSpec {
  organizationId: number;
  /** Stable target identity — `project:<id>` today. The run's `target`, and the fingerprint's `repo`. */
  repo: string;
  collector: string;
  collectorVersion: string;
  /** The run's surface. Every observation must fingerprint to this surface; one that does not is a collector/ingest mismatch and throws. */
  surface: Surface;
  observations: RawObservation[];
  reobserved: ReobservationScope;
  /**
   * B7 — per-asset data classification, keyed by `RawObservation.location`.
   *
   * **Deliberately not a field on `RawObservation`.** A collector observes
   * cryptography and has no idea whether the data behind it is Regulated —
   * that is why `DATA_CLASSIFICATION_VALUES` lives in `@workspace/db` rather
   * than in the dependency-free collector contract (see
   * `lib/db/src/classification.ts`'s own comment on the deviation). The
   * classification is a statement the *caller* makes about their data in the
   * same request body, so it is carried here, on the ingest spec, rather than
   * smuggled through the collector.
   *
   * Only the data-at-rest ingest supplies this today, and the upsert only
   * touches those two columns when it is present — so the four collectors that
   * do not supply it run through provably unchanged SQL.
   */
  classificationByLocation?: ReadonlyMap<string, AssetClassificationInput>;
  /**
   * F4 — whether this run may persist source-bearing evidence.
   *
   * `observations.evidence` is an unconstrained `jsonb` blob that collectors
   * fill in and several routes return verbatim, and the source collector puts
   * the matched line in it as `codeSnippet`. So a submission processed under
   * `ephemeral` retention that did not thread this flag through would leave the
   * customer's source sitting in `evidence` while the product told them nothing
   * was retained — a false statement of exactly the class this codebase treats
   * as worse than a missing feature.
   *
   * Defaults to `retained`, which is every caller that does not pass it and
   * every collector other than source: a TLS handshake, a certificate and a
   * lockfile line are not the customer's proprietary source, and the mode is
   * only offered on the two routes that accept source bodies.
   */
  evidenceRetention?: RetentionMode;
}

/**
 * Evidence keys that are verbatim fragments of a customer's submitted source.
 *
 * A denylist rather than an allowlist, and that is a real trade-off: a future
 * collector adding a second source-bearing key without adding it here would
 * leak. The alternative — allowlisting the safe keys — breaks every collector
 * whenever one of them adds a field, and would have silently dropped evidence
 * rather than silently kept it, which is the failure that goes unnoticed. The
 * mitigation is the boundary test, which greps the whole database for the
 * submitted source rather than asserting on this list.
 */
const SOURCE_BEARING_EVIDENCE_KEYS = ["codeSnippet"] as const;

function evidenceFor(
  raw: RawObservation,
  extras: { algorithm: string; keySize: number | null; location: string },
  retention: RetentionMode,
): Record<string, unknown> {
  const evidence: Record<string, unknown> = { ...raw.evidence, ...extras };
  if (retention === "ephemeral") {
    for (const key of SOURCE_BEARING_EVIDENCE_KEYS) delete evidence[key];
  }
  return evidence;
}

/** The two A3 columns a caller may supply per asset. Null/absent means "not supplied" and stays null — never a default. */
export interface AssetClassificationInput {
  dataClassification?: DataClassification | null;
  secrecyLifetimeYears?: number | null;
}

function reobservationPredicate(scope: ReobservationScope): SQL | undefined {
  if (scope.kind === "locations") {
    return scope.locations.length === 0 ? undefined : inArray(assetsTable.location, scope.locations);
  }
  // The prefixes are built from `projectRepoId()` (an integer) and a fixed
  // ecosystem string, so neither `%` nor `_` can appear in them and no LIKE
  // escaping is required. Anything user-supplied must not be spliced in here.
  const clauses = scope.prefixes.map((prefix) => like(assetsTable.location, `${prefix}%`));
  return clauses.length === 0 ? undefined : or(...clauses);
}

async function ingestObservations(tx: ScopedTx, spec: IngestSpec): Promise<IngestResult> {
  const { organizationId, observations } = spec;

  // Collapse the run's observations to one row per asset before touching the
  // database: a file legitimately matches the same (repo, path, algorithm,
  // symbol) on many lines, and those are many observations of ONE asset.
  // Later lines win, so the asset reflects the last state the collector saw —
  // including a key size going back to undetermined. Deduplicating here is
  // also what makes the batched upsert legal: Postgres rejects an ON CONFLICT
  // DO UPDATE that would touch the same row twice in one statement.
  const assetValuesByFingerprint = new Map<string, typeof assetsTable.$inferInsert>();
  const pendingObservations: Array<{ fingerprint: string; values: Omit<typeof observationsTable.$inferInsert, "assetId" | "collectionRunId"> }> = [];

  for (const raw of observations) {
    const fingerprintInput = fingerprintForObservation(raw, { repo: spec.repo });
    if (fingerprintInput === undefined) {
      // No `locationDetail` this can turn into an identity. Guessing a
      // surface here is precisely the bug this refactor removed, so the run
      // fails loudly instead — a collector emitting unfingerprintable
      // observations is a bug in the collector.
      throw new Error(`observation at ${raw.location} carries no fingerprintable locationDetail`);
    }
    if (fingerprintInput.surface !== spec.surface) {
      throw new Error(`observation at ${raw.location} fingerprints as '${fingerprintInput.surface}' in a '${spec.surface}' run`);
    }
    // Undetermined stays undetermined here — `raw.keySize` is `undefined`
    // when the collector couldn't determine it; this is the one place that
    // becomes `null` for the nullable DB column. Never a guessed default —
    // see docs/Claude/09-open-gaps.md G-05.
    const keySize = raw.keySize ?? null;

    const fingerprint = computeFingerprint(fingerprintInput);

    // Null when the caller supplied nothing — the same "not supplied stays
    // null" rule as `keySize` above, and load-bearing for the same reason:
    // it is what lets `resolveSecrecyLifetime()` report an X as assumed.
    const classification = spec.classificationByLocation?.get(raw.location);

    assetValuesByFingerprint.set(fingerprint, {
      organizationId,
      fingerprint,
      surface: fingerprintInput.surface,
      algorithm: raw.algorithm,
      keySize,
      location: raw.location,
      locationDetail: raw.locationDetail,
      status: "active",
      dataClassification: classification?.dataClassification ?? null,
      secrecyLifetimeYears: classification?.secrecyLifetimeYears ?? null,
    });

    pendingObservations.push({
      fingerprint,
      values: {
        organizationId,
        collector: spec.collector,
        collectorVersion: spec.collectorVersion,
        confidence: raw.confidence,
        discoveryModality: raw.discoveryModality,
        evidence: evidenceFor(
          raw,
          { algorithm: raw.algorithm, keySize, location: raw.location },
          spec.evidenceRetention ?? "retained",
        ),
      },
    });
  }

  // Fingerprints touched by an observation in this run — used below to find
  // previously-active assets in scope that this run did NOT reobserve, i.e.
  // the vulnerable line was removed or the package was dropped.
  const touchedFingerprints = new Set(assetValuesByFingerprint.keys());

  // A fixed number of statements regardless of how many detections the run
  // produced — `POST /scans/multi` submits a whole repo at once, and this runs
  // inside the request. Atomicity now comes from the caller's scope: the whole
  // request is one transaction, so a failure part-way cannot leave a run row
  // claiming more observations than were written.
  const [run] = await tx
    .insert(collectionRunsTable)
    .values({
      organizationId,
      collector: spec.collector,
      collectorVersion: spec.collectorVersion,
      surface: spec.surface,
      status: "completed",
      target: spec.repo,
      observationCount: observations.length,
      completedAt: new Date(),
    })
    .returning();

  let assetsCreated = 0;
  let assetsUpdated = 0;
  const assetIdByFingerprint = new Map<string, number>();

  if (assetValuesByFingerprint.size > 0) {
    const fingerprints = [...assetValuesByFingerprint.keys()];
    const existing = await tx
      .select({ fingerprint: assetsTable.fingerprint })
      .from(assetsTable)
      .where(and(eq(assetsTable.organizationId, organizationId), inArray(assetsTable.fingerprint, fingerprints)));
    assetsUpdated = existing.length;
    assetsCreated = fingerprints.length - existing.length;

    // `COALESCE`, not `excluded.*`, and only for an ingest that actually
    // carries classifications. Two failures avoided, in order of severity:
    //
    //   1. Writing `excluded.data_classification` unconditionally would null
    //      out a classification on every re-ingest of *any* other surface,
    //      since none of them supply one. That is why this is spread in
    //      conditionally rather than merged into the set below.
    //   2. Within this ingest, a resubmission that omits the classification
    //      would still null out what a human previously asserted. "Not
    //      supplied" is not "no longer classified", and silently erasing an
    //      assertion because a nightly config export left a field blank is a
    //      worse failure than being unable to clear it from here. Clearing is
    //      a per-asset edit that does not exist yet.
    const classificationSet =
      spec.classificationByLocation === undefined
        ? {}
        : {
            dataClassification: sql`COALESCE(excluded.data_classification, ${assetsTable.dataClassification})`,
            secrecyLifetimeYears: sql`COALESCE(excluded.secrecy_lifetime_years, ${assetsTable.secrecyLifetimeYears})`,
          };

    const conflictSet = {
      lastSeen: new Date(),
      keySize: sql`excluded.key_size`,
      location: sql`excluded.location`,
      locationDetail: sql`excluded.location_detail`,
      // Reactivation is only ever gone -> active. `waived` (a human
      // explicitly accepted the risk) and `remediated` are decisions
      // about the asset, not observations of it, so re-seeing the same
      // line must not silently undo them. The gone-reconciliation below
      // is already one-directional in the same way: it only ever moves
      // `active` assets.
      status: sql`CASE WHEN ${assetsTable.status} = 'gone' THEN 'active' ELSE ${assetsTable.status} END`,
      // M3 — stamp the lifecycle transition, and ONLY when one happens.
      //
      // The same `CASE` as `status` above, deliberately: a plain
      // `statusChangedAt: new Date()` here would stamp every re-observation of
      // an unchanged asset, so a nightly schedule would report the entire
      // estate as having changed every night. The signal is the transition, not
      // the visit — `lastSeen` above already records the visit.
      //
      // `now()` rather than a JS timestamp so both branches of the statement
      // agree on one instant (transaction start) with no round-trip.
      // `statusChangedByRunId` records the run that saw it again, which is what
      // lets the drift feed show a reappearance with real evidence behind it
      // rather than an unexplained status flip.
      statusChangedAt: sql`CASE WHEN ${assetsTable.status} = 'gone' THEN now() ELSE ${assetsTable.statusChangedAt} END`,
      statusChangedByRunId: sql`CASE WHEN ${assetsTable.status} = 'gone' THEN ${run.id} ELSE ${assetsTable.statusChangedByRunId} END`,
      ...classificationSet,
    };

    const upserted = await tx
      .insert(assetsTable)
      .values([...assetValuesByFingerprint.values()])
      .onConflictDoUpdate({
        target: [assetsTable.organizationId, assetsTable.fingerprint],
        set: conflictSet,
      })
      .returning({ id: assetsTable.id, fingerprint: assetsTable.fingerprint });
    // Keyed by fingerprint, never by position: the order rows come back
    // from an upsert's RETURNING is not the order they were supplied in.
    for (const row of upserted) assetIdByFingerprint.set(row.fingerprint, row.id);
  }

  if (pendingObservations.length > 0) {
    await tx.insert(observationsTable).values(
      pendingObservations.map((pending) => {
        const assetId = assetIdByFingerprint.get(pending.fingerprint);
        if (assetId === undefined) {
          throw new Error(`asset upsert returned no row for fingerprint ${pending.fingerprint}`);
        }
        return { assetId, collectionRunId: run.id, ...pending.values };
      }),
    );
  }

  // Lifecycle: mark "gone" any previously-active asset this run's scope
  // covered but did not reobserve — the vulnerable line was removed, or the
  // package left the lockfile. docs/Claude/03-features.md A1 acceptance:
  // "Removing the vulnerable line marks the asset `gone`, and it stays in
  // history" (the row is updated in place, never deleted).
  //
  // The `surface` filter is load-bearing in both directions: a dependency run
  // must not reach a source asset, and vice versa.
  let assetsMarkedGone = 0;
  const scopePredicate = reobservationPredicate(spec.reobserved);
  if (scopePredicate !== undefined) {
    const priorActiveAssets = await tx
      .select({ id: assetsTable.id, fingerprint: assetsTable.fingerprint })
      .from(assetsTable)
      .where(
        and(
          eq(assetsTable.organizationId, organizationId),
          eq(assetsTable.surface, spec.surface),
          scopePredicate,
          eq(assetsTable.status, "active"),
        ),
      );

    const goneAssetIds = priorActiveAssets.filter((a) => !touchedFingerprints.has(a.fingerprint)).map((a) => a.id);
    if (goneAssetIds.length > 0) {
      // lastSeen is deliberately left as-is — it records when the asset
      // was last actually observed, not when we last failed to find it.
      //
      // M3 stamps the transition instead, with the id of the run whose scope
      // covered this asset and did not find it. That pairing is what makes the
      // drift feed auditable: `GET /api/drift` reports a disappearance only
      // alongside the collection run behind it, so a reader can check that a
      // real examination happened rather than taking an absence on trust.
      await tx
        .update(assetsTable)
        .set({ status: "gone", statusChangedAt: new Date(), statusChangedByRunId: run.id })
        .where(inArray(assetsTable.id, goneAssetIds));
      assetsMarkedGone = goneAssetIds.length;
    }
  }

  return { collectionRunId: run.id, assetsCreated, assetsUpdated, observationsCreated: observations.length, assetsMarkedGone };
}

export async function ingestSourceObservations(
  tx: ScopedTx,
  params: {
    /** A stable target identity for the collection run and the fingerprint's `repo` component — this project has no real git-repo concept yet, so callers pass e.g. `project:<id>`. */
    repo: string;
    files: Array<{ path: string; content: string; language: string }>;
    /** Must match the organisation the caller's `withOrg` scope was opened at; RLS rejects anything else. */
    organizationId: number;
    /** F4 — `ephemeral` drops `evidence.codeSnippet`, so no fragment of the submission is written. Defaults to `retained`. */
    retentionMode?: RetentionMode;
  },
): Promise<IngestResult> {
  const target = { kind: "source" as const, repo: params.repo, files: params.files };
  return ingestObservations(tx, {
    organizationId: params.organizationId,
    repo: params.repo,
    collector: "source-regex",
    collectorVersion: "1.0.0",
    surface: "source",
    observations: collectSourceObservations(target),
    evidenceRetention: params.retentionMode ?? "retained",
    // Scoped per scanned FILE, not per `repo`: a call that only submits a
    // subset of a repo's files (e.g. POST /scans submitting one file) has no
    // information about files it wasn't given, so those files' assets must be
    // left untouched rather than wrongly marked gone.
    reobserved: { kind: "locations", locations: [...new Set(params.files.map((f) => `${params.repo}:${f.path}`))] },
  });
}

export interface DependencyIngestResult extends IngestResult {
  /** The submitted files this collector could actually read, so the caller can report what was and was not understood. */
  lockfiles: Array<{ path: string; kind: string }>;
}

/**
 * B2 — persist a dependency/SBOM collection (docs/Claude/03-features.md §B2).
 *
 * Callers must not invoke this when the submission contains no recognised
 * lockfile: it would write a `completed` collection run, and the D3 meter
 * would then report the dependency surface as "examined, nothing found" when
 * the truth is that nothing readable was submitted. `lockfilesIn()` is
 * exported from `@workspace/collectors` so the route can check first, and the
 * assertion below keeps the rule from depending on the route remembering it.
 */
export async function ingestDependencyObservations(
  tx: ScopedTx,
  params: {
    repo: string;
    files: Array<{ path: string; content: string }>;
    organizationId: number;
  },
): Promise<DependencyIngestResult> {
  // `language` is part of the shared `CollectionTarget` shape and means
  // nothing for a lockfile; the dependency collector selects files by
  // basename and never reads it.
  const target = {
    kind: "source" as const,
    repo: params.repo,
    files: params.files.map((f) => ({ ...f, language: "lockfile" })),
  };
  const lockfiles = lockfilesIn(target);
  if (lockfiles.length === 0) {
    throw new Error("dependency ingest was given no recognised lockfile — a run must not be recorded");
  }

  const result = await ingestObservations(tx, {
    organizationId: params.organizationId,
    repo: params.repo,
    collector: "dependency-lockfile",
    collectorVersion: "1.0.0",
    surface: "dependency",
    observations: collectDependencyObservations(target),
    reobserved: {
      kind: "prefixes",
      prefixes: ecosystemsIn(target).map((ecosystem) => dependencyLocationPrefix(params.repo, ecosystem)),
    },
  });

  return { ...result, lockfiles };
}

export interface CertificateIngestResult extends IngestResult {
  /** The submitted files this collector could actually read at least one certificate from, and how many. */
  certificateFiles: Array<{ path: string; certificateCount: number }>;
  /** One entry per certificate this run parsed — the route's material for building a response and evaluating Q-Day, without re-parsing. */
  certificates: CertificateSummary[];
}

export interface CertificateSummary {
  location: string;
  algorithm: string;
  keySize: number | null;
  issuer: string;
  serialNumber: string;
  subject: string | null;
  notBefore: string;
  notAfter: string;
  signatureAlgorithm: string | null;
}

function toCertificateSummary(observation: RawObservation): CertificateSummary {
  const detail = observation.locationDetail;
  if (detail?.kind !== "certificate") {
    // Cannot happen: every observation reaching here came from
    // collectCertificateObservations(), which always sets this. Guarded
    // rather than cast, so a future change to the collector fails loudly
    // here instead of producing a summary with the wrong shape.
    throw new Error(`certificate observation at ${observation.location} carries no certificate locationDetail`);
  }
  return {
    location: observation.location,
    algorithm: observation.algorithm,
    keySize: observation.keySize ?? null,
    issuer: detail.certificate.issuer,
    serialNumber: detail.certificate.serialNumber,
    subject: detail.certificate.subject ?? null,
    notBefore: detail.certificate.notBefore,
    notAfter: detail.certificate.notAfter,
    signatureAlgorithm: detail.certificate.signatureAlgorithm ?? null,
  };
}

/**
 * B4 — persist a certificate collection (docs/Claude/03-features.md §B4).
 *
 * Same "examine nothing, record nothing" discipline as
 * `ingestDependencyObservations`: a submission with no parseable certificate
 * must not write a `completed` collection run, or the D3 meter would report
 * the certificate surface as examined-and-empty when nothing readable was
 * submitted at all.
 */
export async function ingestCertificateObservations(
  tx: ScopedTx,
  params: {
    repo: string;
    files: Array<{ path: string; content: string }>;
    organizationId: number;
  },
): Promise<CertificateIngestResult> {
  // `language` means nothing for a certificate file; the collector reads
  // content, never the extension or this field.
  const target = {
    kind: "source" as const,
    repo: params.repo,
    files: params.files.map((f) => ({ ...f, language: "certificate" })),
  };
  const certificateFiles = certificatesIn(target);
  if (certificateFiles.length === 0) {
    throw new Error("certificate ingest was given no parseable certificate — a run must not be recorded");
  }

  const observations = collectCertificateObservations(target);
  const certificates = observations.map(toCertificateSummary);

  const result = await ingestObservations(tx, {
    organizationId: params.organizationId,
    repo: params.repo,
    collector: "certificate-x509",
    collectorVersion: "1.0.0",
    surface: "certificate",
    observations,
    /**
     * Scoped to the exact certificates this submission actually parsed — the
     * same per-file discipline `ingestSourceObservations` uses (see
     * `ReobservationScope` above), one level finer, because each
     * certificate's `location` already encodes its full identity (issuer +
     * serial: `fingerprint.ts`'s `certificate` variant), not a stable slot
     * the way a source file path or a dependency's ecosystem prefix is.
     *
     * The consequence is worth stating explicitly, because it differs from
     * both existing surfaces: renewing a certificate mints a new serial, so
     * the renewed certificate is a NEW `location`, outside this round's
     * scope. A submission that omits the old (superseded) certificate does
     * NOT mark it `gone` — there is no shared slot for the two to occupy,
     * unlike a source file being edited in place or a package version bump.
     * A specific issued certificate is a permanent historical fact once
     * observed; retiring one is a lifecycle decision (`waived`/
     * `remediated`) or a project deletion, not something a later, unrelated
     * submission can infer by its absence. What this scope DOES correctly
     * do is reactivate a certificate marked `gone` if its exact bytes are
     * resubmitted — the mechanism scheduled re-collection (roadmap M3) would
     * rely on for an unchanged certificate.
     */
    reobserved: { kind: "locations", locations: [...new Set(observations.map((o) => o.location))] },
  });

  return { ...result, certificateFiles, certificates };
}

/**
 * B3 — persist a TLS/cipher-suite collection (docs/Claude/03-features.md
 * §B3). `POST /projects/:id/tls` is the caller: it does the actual `node:tls`
 * connection and the SSRF-guarded resolve-then-pin (`tls-probe.ts`,
 * `tls-ssrf-guard.ts`), then hands this function only the handshakes that
 * *completed*.
 *
 * Mirrors B2's rule exactly, and for the identical reason: callers must not
 * invoke this when `params.probed` is empty. A submission where every target
 * was refused by the SSRF guard or simply did not answer has examined
 * nothing, so recording a `completed` collection run would make the D3 meter
 * report the `tls` surface as "examined, nothing found" — the same false
 * statement B2's assertion below guards against, now guarding a second
 * collector against it.
 *
 * `reobserved` is scoped to exactly the targets in `params.probed` — not
 * every target the caller submitted. A target the guard refused or that timed
 * out was not observed, so it must not be eligible to have its prior assets
 * marked `gone`; the caller (`routes/projects.ts`) must filter to
 * `outcome === "probed"` before calling this, the same discipline
 * `ingestSourceObservations` applies per scanned file.
 */
export async function ingestTlsObservations(
  tx: ScopedTx,
  params: {
    repo: string;
    probed: Array<{ host: string; port: number; handshake: TlsHandshakeResult }>;
    organizationId: number;
  },
): Promise<IngestResult> {
  if (params.probed.length === 0) {
    throw new Error("TLS ingest was given no completed handshake — a run must not be recorded");
  }

  const observations = params.probed.flatMap((p) => observationsFromTlsHandshake(params.repo, p.handshake));

  return ingestObservations(tx, {
    organizationId: params.organizationId,
    repo: params.repo,
    collector: "tls-handshake",
    collectorVersion: "1.0.0",
    surface: "tls",
    observations,
    reobserved: {
      kind: "locations",
      locations: [...new Set(params.probed.map((p) => `${params.repo}:${p.host}:${p.port}`))],
    },
  });
}

/**
 * B7 — persist a data-at-rest collection (docs/Claude/03-features.md §B7).
 *
 * The fifth `IngestSpec` shape through the same shared `ingestObservations()`,
 * and the first to carry `classificationByLocation`. That is what makes this
 * surface reach the risk engine rather than just the inventory: `GET
 * /api/inventory/assets` resolves each asset's X with `resolveSecrecyLifetime()`
 * and runs Mosca over it, so a store submitted as Regulated arrives at the risk
 * calculation with X = 25 and `xAssumed: false`, while one submitted with no
 * classification arrives with the product default and says so. Data at rest is
 * where that distinction is worth the most — the ciphertext can be copied today
 * and decrypted after Q-Day, so X is the whole question.
 *
 * Same "examine nothing, record nothing" discipline as its four siblings: a
 * submission that produced no observation *and* stated nothing to reconcile
 * must not write a `completed` collection run, or the D3 meter would report
 * data-at-rest as examined-and-empty. Note the *and*: a submission of stores
 * that are all `not-encrypted` produces zero observations but is a real
 * examination with a real result, so it does record a run.
 */
export interface DataAtRestIngestResult extends IngestResult {
  stores: DataAtRestStoreResult[];
}

export async function ingestDataAtRestObservations(
  tx: ScopedTx,
  params: {
    repo: string;
    stores: DataAtRestStoreInput[];
    organizationId: number;
    /** Per-store A3 classification, keyed by `storeId`. Absent = not supplied, which stays null on the row. */
    classificationByStoreId?: ReadonlyMap<string, AssetClassificationInput>;
  },
): Promise<DataAtRestIngestResult> {
  const stores = collectDataAtRestObservations(params.repo, params.stores);
  const observations = stores.flatMap((store) => store.observations);
  const reobservedLocations = [...new Set(stores.flatMap((store) => store.reobservedLocations))];

  if (observations.length === 0 && reobservedLocations.length === 0) {
    throw new Error("data-at-rest ingest was given no store it could say anything about — a run must not be recorded");
  }

  // The classification is supplied per *store*, but the upsert needs it per
  // *asset*, and one store produces up to two assets (its bulk cipher and its
  // key wrapping). Both inherit the store's classification: X is a property of
  // the data in the store, and both halves of the key hierarchy protect the
  // same data.
  const classificationByLocation = new Map<string, AssetClassificationInput>();
  if (params.classificationByStoreId !== undefined) {
    for (const store of stores) {
      const classification = params.classificationByStoreId.get(store.storeId);
      if (classification === undefined) continue;
      for (const observation of store.observations) classificationByLocation.set(observation.location, classification);
    }
  }

  const result = await ingestObservations(tx, {
    organizationId: params.organizationId,
    repo: params.repo,
    collector: "data-at-rest-config",
    collectorVersion: "1.0.0",
    surface: "data-at-rest",
    observations,
    /**
     * Scoped to exactly the slots this submission made an observation-producing
     * statement about — see `observationsFromDataAtRestStore`'s reobservation
     * rule, which is where the three-way split lives. The case that rule exists
     * for: a store resubmitted as encrypted but with the cipher field left
     * blank is NOT in scope, so its previously recorded cipher stays `active`.
     * Putting it in scope would mark it `gone` because a field was blank, which
     * is the silent false remediation `ReobservationScope` above warns about.
     */
    reobserved: { kind: "locations", locations: reobservedLocations },
    // Passed even when empty, because its presence is what switches the upsert
    // to preserving these two columns; an ingest on this surface must never
    // reach the `excluded.*` path meant for the other four.
    classificationByLocation,
  });

  return { ...result, stores };
}

export interface ProtocolConfigIngestResult extends IngestResult {
  /** The submitted files this collector recognised as a protocol configuration, and how much each declared. A file here with `declarationCount: 0` was read and states no crypto. */
  configFiles: RecognisedProtocolConfig[];
  /** One entry per declaration this run read — the route's material for a response, without re-parsing. */
  declarations: ProtocolConfigDeclarationSummary[];
}

export interface ProtocolConfigDeclarationSummary {
  path: string;
  format: string;
  directive: string;
  declaredValue: string;
  algorithm: string;
  keySize: number | null;
  strength: string;
  /** The enclosing `Match`/`Host` block, when the directive applies conditionally. Null when it applies globally. */
  condition: string | null;
  confidence: number;
}

function toProtocolConfigSummary(observation: RawObservation): ProtocolConfigDeclarationSummary {
  const detail = observation.locationDetail;
  if (detail?.kind !== "config") {
    // Cannot happen: every observation reaching here came from
    // collectProtocolConfigObservations(), which always sets this. Guarded
    // rather than cast, so a future change to the collector fails loudly here
    // instead of producing a summary with the wrong shape.
    throw new Error(`protocol-config observation at ${observation.location} carries no config locationDetail`);
  }
  return {
    path: detail.config.path,
    format: detail.config.format,
    directive: detail.config.directive,
    declaredValue: detail.config.declaredValue,
    algorithm: observation.algorithm,
    keySize: observation.keySize ?? null,
    strength: detail.config.strength,
    condition: detail.config.condition ?? null,
    confidence: observation.confidence,
  };
}

/**
 * B6 — persist a protocol-configuration collection (docs/Claude/03-features.md
 * §B6).
 *
 * **The "examined nothing" gate is on recognised *files*, not on
 * observations**, and that is the one place this differs from its three
 * predecessors in a way that matters. A valid `sshd_config` that leaves every
 * algorithm directive at the compiled-in default is *examined and found
 * nothing* — a real, useful answer, and a collection run must be recorded for
 * it, exactly as a `package-lock.json` full of non-crypto packages records a
 * run with zero observations. Only a submission where **no** file is a
 * configuration this collector understands has examined nothing, and that is
 * what must not write a run. So this function throws on
 * `configFiles.length === 0` and deliberately does not throw when the
 * observation list is empty.
 *
 * **`reobserved` is built from the recognised files, not from the
 * observations** — the opposite of `ingestCertificateObservations` above, and
 * for a reason worth stating rather than inferring. A certificate's `location`
 * *is* its identity, so a certificate absent from a submission is outside the
 * scope by construction. A configuration file is a *slot*: deleting the last
 * `HostKeyAlgorithms` line and resubmitting produces zero observations for
 * that file, and if the scope were derived from observations the file's
 * location would never enter it — the removed declaration's asset would stay
 * `active` forever, breaking the A1 acceptance criterion ("removing the
 * vulnerable line marks the asset `gone`") for precisely the edit the feature
 * is meant to detect. Deriving it from the files that were read makes the
 * removal visible.
 */
export async function ingestProtocolConfigObservations(
  tx: ScopedTx,
  params: {
    repo: string;
    files: Array<{ path: string; content: string }>;
    organizationId: number;
  },
): Promise<ProtocolConfigIngestResult> {
  // `language` is part of the shared `CollectionTarget` shape and means
  // nothing here; the collector selects files by basename and structure.
  const target = {
    kind: "source" as const,
    repo: params.repo,
    files: params.files.map((f) => ({ ...f, language: "config" })),
  };

  const configFiles = protocolConfigsIn(target);
  if (configFiles.length === 0) {
    throw new Error("protocol-config ingest was given no recognised configuration file — a run must not be recorded");
  }

  const observations = collectProtocolConfigObservations(target);
  const declarations = observations.map(toProtocolConfigSummary);

  const result = await ingestObservations(tx, {
    organizationId: params.organizationId,
    repo: params.repo,
    collector: "protocol-config",
    collectorVersion: "1.0.0",
    surface: "config",
    observations,
    reobserved: {
      kind: "locations",
      locations: [...new Set(configFiles.map((file) => protocolConfigLocation(params.repo, file.path)))],
    },
  });

  return { ...result, configFiles, declarations };
}

export interface KmsIngestResult extends IngestResult {
  /** Every submitted key and what the collector concluded about it — including the ones that produced no observation, which are most of the interesting ones. */
  outcomes: KmsKeyOutcome[];
}

/**
 * B5 — persist a KMS / secret-store collection (docs/Claude/03-features.md
 * §B5). `POST /projects/:id/kms` is the caller.
 *
 * **The gate for recording a run differs from B2/B3/B4's, deliberately, and
 * getting it backwards would misreport coverage in one direction or the
 * other.** Those three refuse to write a run when nothing *readable* was
 * submitted — no recognised lockfile, no completed handshake, no parseable
 * certificate. The equivalent here is "no key entries at all", NOT "no
 * observations": a key store that holds only HMAC and AES-wrapping keys was
 * genuinely examined, and every one of its keys was genuinely classified —
 * there is simply nothing on this product's list of reportable algorithms in
 * it. That is `examined, nothing found`, the state `collection_runs` exists
 * to make sayable, and it is the same shape as a lockfile that parses
 * cleanly and contains no crypto package (which B2 records as a run, not as
 * an absence). Refusing the run would tell a CISO their key store had never
 * been looked at, which is false and is the more damaging of the two errors.
 *
 * So the caller must not invoke this with an empty `keys` array — that is
 * the genuine "we were sent nothing" case — and the assertion below keeps
 * the rule from depending on the route remembering it.
 */
export async function ingestKmsObservations(
  tx: ScopedTx,
  params: {
    repo: string;
    keys: KmsKeyDescription[];
    organizationId: number;
  },
): Promise<KmsIngestResult> {
  if (params.keys.length === 0) {
    throw new Error("KMS ingest was given no key entries — a run must not be recorded");
  }

  const outcomes = classifyKmsKeys(params.repo, params.keys);
  const observations = outcomes.flatMap((outcome) => (outcome.kind === "observed" ? [outcome.observation] : []));

  const result = await ingestObservations(tx, {
    organizationId: params.organizationId,
    repo: params.repo,
    collector: "kms-inventory",
    collectorVersion: "1.0.0",
    surface: "kms",
    observations,
    /**
     * Scoped to the exact keys this submission classified — never a
     * `<repo>:kms:<provider>:` prefix family, which is the shape that looks
     * natural here and is wrong.
     *
     * A prefix scope would only be correct if this route knew the submission
     * was a *complete* enumeration of that provider's keys. It cannot know
     * that, and every realistic export is partial: one page of a paginated
     * `list-keys`, one region, one Vault mount, one subscription. Marking
     * every other key in the provider `gone` because it was absent from one
     * page is the silent mass false remediation `ReobservationScope` at the
     * top of this file exists to prevent — B3's rule, applied to pagination
     * instead of a firewall. A key we were not shown was not observed.
     *
     * The consequence, stated plainly because it is a real limitation and
     * not a subtlety: a key genuinely deleted from a key store is never
     * inferred as `gone` by a later submission that omits it. Same practical
     * position as B4's certificates, reached by a different route, and the
     * fix is the same shape — a caller that can *declare* its export
     * complete for a provider could earn a prefix scope. Nothing declares
     * that today.
     *
     * What the scope does do correctly is reactivate a `gone` key when it is
     * resubmitted, and keep a resubmitted key's assets untouched.
     */
    reobserved: { kind: "locations", locations: [...new Set(observations.map((o) => o.location))] },
  });

  return { ...result, outcomes };
}

export interface NetworkFlowIngestResult extends IngestResult, NetworkFlowCollectionResult {
  /** Conversations this submission had never seen before. */
  flowsCreated: number;
  /** Conversations already on record that this submission saw again. */
  flowsUpdated: number;
  /**
   * Conversations recorded with **no cryptography determined**, after this
   * submission. Surfaced as a first-class number rather than left to be
   * inferred, because `GET /projects/:id/coverage` cannot express it: a
   * submission of a thousand cipher-free VPC-flow rows writes a completed run
   * with zero observations, and the coverage meter renders that as
   * `examined-nothing-found` — which reads as *clean*. It is not clean; it is a
   * thousand conversations nobody has determined the cryptography of. This is
   * the number that says so, and both network-flow routes return it.
   */
  flowsWithUndeterminedCryptography: number;
}

/**
 * B11 — persist a network-flow collection (docs/Claude/03-features.md §B11).
 * `POST /projects/:id/network-flows` is the caller.
 *
 * Two things are written, and the split is the point of the lane:
 *
 *  1. **Every conversation**, into `network_flows`, with both endpoints —
 *     including the ones whose cryptography nothing named. See that table's
 *     header for why a conversation is not an `assets` row (`assets.algorithm`
 *     is `NOT NULL`, and a sentinel algorithm would be a fabricated value).
 *  2. **The cryptography**, into `assets`/`observations` on the `network-flow`
 *     surface, only for conversations where a record actually named a cipher
 *     suite.
 *
 * **The gate for recording a run is parseable *records*, not observations** —
 * B6's rule, not B7's, and for B6's reason. A thousand VPC-flow rows that name
 * no cipher are a genuine examination with a genuine result: a thousand
 * conversations now on record, none of whose cryptography is known. Refusing
 * the run would tell a CISO the surface had never been looked at, which is
 * false. What must not write a run is a submission where *no* record could be
 * turned into a conversation at all — garbage, or every row missing an endpoint
 * — and that is what the throw below covers.
 *
 * **The reobservation scope carries only the slots a cipher was actually named
 * at.** The rule and the failure it prevents live in
 * `collectNetworkFlowObservations`; the short version is that a nightly
 * cipher-free export would otherwise mark every asset a load-balancer log
 * established `gone`, on a schedule.
 */
export async function ingestNetworkFlowObservations(
  tx: ScopedTx,
  params: {
    repo: string;
    /** Confirmed visible inside the caller's scope before this is called — a foreign key is not subject to RLS. */
    projectId: number;
    records: NetworkFlowRecordInput[];
    organizationId: number;
  },
): Promise<NetworkFlowIngestResult> {
  const collected = collectNetworkFlowObservations(params.repo, params.records);
  if (collected.conversations.length === 0) {
    throw new Error("network-flow ingest was given no record it could read as a conversation — a run must not be recorded");
  }

  const now = new Date();
  const flowValues = collected.conversations.map((conversation) => ({
    organizationId: params.organizationId,
    projectId: params.projectId,
    flowKey: conversation.flowKey,
    sourceIdentity: conversation.sourceIdentity,
    sourceAddress: conversation.source.address ?? null,
    sourceHostname: conversation.source.hostname ?? null,
    sourceWorkload: conversation.source.workload ?? null,
    destinationIdentity: conversation.destinationIdentity,
    destinationAddress: conversation.destination.address ?? null,
    destinationHostname: conversation.destination.hostname ?? null,
    destinationWorkload: conversation.destination.workload ?? null,
    destinationPort: conversation.destinationPort,
    transport: conversation.transport,
    applicationProtocol: conversation.applicationProtocol,
    cryptoState: conversation.cryptoState,
    reportedCipherSuite: conversation.reportedCipherSuite,
    reportedTlsVersion: conversation.reportedTlsVersion,
    cryptoReportedAt: conversation.cryptoState === "observed" ? now : null,
    recordFormat: conversation.recordFormat,
    recordCount: conversation.recordCount,
  }));

  const existing = await tx
    .select({ flowKey: networkFlowsTable.flowKey })
    .from(networkFlowsTable)
    .where(
      and(
        eq(networkFlowsTable.organizationId, params.organizationId),
        inArray(networkFlowsTable.flowKey, flowValues.map((f) => f.flowKey)),
      ),
    );
  const flowsUpdated = existing.length;
  const flowsCreated = flowValues.length - flowsUpdated;

  await tx
    .insert(networkFlowsTable)
    .values(flowValues)
    .onConflictDoUpdate({
      target: [networkFlowsTable.organizationId, networkFlowsTable.flowKey],
      set: {
        lastSeen: now,
        // Cumulative across submissions: this column counts how many raw
        // records have ever collapsed into this conversation.
        recordCount: sql`${networkFlowsTable.recordCount} + excluded.record_count`,
        // COALESCE, never `excluded.*`, for every descriptive field. A VPC flow
        // log carries addresses and no hostnames; a mesh export carries
        // workloads and no addresses. Whichever arrives second must not blank
        // what the first one established — "this export did not carry a
        // hostname" is not "this endpoint has no hostname".
        sourceAddress: sql`COALESCE(excluded.source_address, ${networkFlowsTable.sourceAddress})`,
        sourceHostname: sql`COALESCE(excluded.source_hostname, ${networkFlowsTable.sourceHostname})`,
        sourceWorkload: sql`COALESCE(excluded.source_workload, ${networkFlowsTable.sourceWorkload})`,
        destinationAddress: sql`COALESCE(excluded.destination_address, ${networkFlowsTable.destinationAddress})`,
        destinationHostname: sql`COALESCE(excluded.destination_hostname, ${networkFlowsTable.destinationHostname})`,
        destinationWorkload: sql`COALESCE(excluded.destination_workload, ${networkFlowsTable.destinationWorkload})`,
        applicationProtocol: sql`COALESCE(excluded.application_protocol, ${networkFlowsTable.applicationProtocol})`,
        // The same rule the collector applies within one submission, applied
        // across submissions: a record that names no cipher cannot retract one
        // another record stated. Silence is not a denial, and letting a nightly
        // cipher-free export flip a conversation back to `undetermined` would
        // erase a real reading because a different pipeline has fewer fields.
        cryptoState: sql`CASE WHEN excluded.crypto_state = 'observed' THEN 'observed' ELSE ${networkFlowsTable.cryptoState} END`,
        reportedCipherSuite: sql`COALESCE(excluded.reported_cipher_suite, ${networkFlowsTable.reportedCipherSuite})`,
        reportedTlsVersion: sql`COALESCE(excluded.reported_tls_version, ${networkFlowsTable.reportedTlsVersion})`,
        // Only advanced when this submission actually carried a suite — which
        // is what makes a stale reading visible as stale rather than as fresh.
        cryptoReportedAt: sql`CASE WHEN excluded.reported_cipher_suite IS NOT NULL THEN excluded.crypto_reported_at ELSE ${networkFlowsTable.cryptoReportedAt} END`,
        recordFormat: sql`excluded.record_format`,
      },
    });

  const result = await ingestObservations(tx, {
    organizationId: params.organizationId,
    repo: params.repo,
    collector: "network-flow-records",
    collectorVersion: "1.0.0",
    surface: "network-flow",
    observations: collected.conversations.flatMap((conversation) => conversation.observations),
    reobserved: { kind: "locations", locations: collected.reobservedLocations },
  });

  // Counted from what is now on record for this project, not from this
  // submission alone: the question a reader asks is "how much of my network
  // inventory has no cryptography determined", and a submission that adds one
  // determined conversation has not answered it for the other nine hundred.
  const [undetermined] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(networkFlowsTable)
    .where(
      and(
        eq(networkFlowsTable.organizationId, params.organizationId),
        eq(networkFlowsTable.projectId, params.projectId),
        eq(networkFlowsTable.cryptoState, "undetermined"),
      ),
    );

  return {
    ...result,
    ...collected,
    flowsCreated,
    flowsUpdated,
    flowsWithUndeterminedCryptography: undetermined?.n ?? 0,
  };
}

/**
 * B8 — persist the OT register as assets on the `ot` surface.
 *
 * Unlike its six siblings this is not called by a submission route: the
 * register is edited a row at a time, and every edit re-derives the whole
 * register. That is why the caller passes *all* of the organisation's fleets
 * rather than the one that changed.
 *
 * **The reobservation scope is a prefix, and that is legitimate here in a way
 * it is not for KMS.** `ingestKmsObservations` refuses a prefix scope because a
 * submitted key export cannot claim to be a complete enumeration of a key
 * store. The register can: it *is* the enumeration — there is no OT estate
 * outside it, only what the customer has written down. So a fleet deleted from
 * the register, or edited to remove its stated algorithm, correctly leaves its
 * asset behind as `gone`, which is the one lifecycle event this surface has.
 *
 * Records a run whenever the register has been examined, including when it
 * yields no observation at all — an empty register, or one where nobody has
 * stated a structured algorithm, is a real reading with a real result. It is
 * the *caller's* job not to invoke this when nothing was examined, and there is
 * no such case: every entry point here follows an edit the customer made.
 */
export async function ingestOtObservations(
  tx: ScopedTx,
  params: { fleets: OtFleetInput[]; organizationId: number },
): Promise<IngestResult> {
  const observations = params.fleets.flatMap((fleet) => observationsFromOtFleet(fleet));

  return ingestObservations(tx, {
    organizationId: params.organizationId,
    // The register is organisation-wide, not project-scoped — a device fleet
    // belongs to the estate, not to a repository. `repo` is the run's target,
    // and `ot` is the only surface whose fingerprint does not include it.
    repo: "ot-register",
    collector: "ot-register",
    collectorVersion: "1.0.0",
    surface: "ot",
    observations,
    reobserved: { kind: "prefixes", prefixes: [OT_FLEET_LOCATION_PREFIX] },
  });
}

export interface EndpointIngestResult extends IngestResult {
  /** Every host in the submission, in order, including the ones that were refused — see `resolveHostIdentity` for why a skipped host must still be reported. */
  hosts: EndpointHostResult[];
}

/**
 * EP — persist a host endpoint collection (docs/Claude/03-features.md §EP).
 * `POST /projects/:id/endpoint` is the caller.
 *
 * The ninth `IngestSpec` shape through the same shared `ingestObservations()`.
 *
 * **The "examined nothing" gate is on *ingestable hosts*, not on
 * observations**, which puts it alongside B6's (recognised files) rather than
 * B2/B3/B4's (readable input at all). A fully hardened Windows server whose
 * machine store is empty and whose suite list contains nothing this product
 * catalogues produces zero observations and *was examined* — recording a run
 * for it is the whole point of the D3 meter, and refusing one would tell a CISO
 * their server fleet had never been looked at. What must not record a run is a
 * submission where every host was refused: a body of hosts with placeholder or
 * colliding machine identities examined nothing, however many entries it had.
 *
 * **`reobserved` is built from the slots each host's report spoke about**, not
 * from the observations and not from the hosts. `observationsFromEndpointHost`
 * is where that is decided, because it is the only place that knows which
 * sections the agent actually collected — an agent that read the TLS policy but
 * not the machine stores must leave the host's certificates untouched, and an
 * agent that read a store and found it empty must retire what used to be in it.
 * Both are impossible to distinguish from here.
 */
export async function ingestEndpointObservations(
  tx: ScopedTx,
  params: {
    repo: string;
    hosts: EndpointHostReport[];
    organizationId: number;
  },
): Promise<EndpointIngestResult> {
  const hosts = collectEndpointObservations(params.repo, params.hosts);
  const ingestable = hosts.filter((host) => host.skipped === undefined);
  if (ingestable.length === 0) {
    throw new Error("endpoint ingest was given no host it could identify — a run must not be recorded");
  }

  const result = await ingestObservations(tx, {
    organizationId: params.organizationId,
    repo: params.repo,
    collector: "endpoint-host-report",
    collectorVersion: "1.0.0",
    surface: "endpoint",
    observations: ingestable.flatMap((host) => host.observations),
    reobserved: {
      kind: "locations",
      locations: [...new Set(ingestable.flatMap((host) => host.reobservedLocations))],
    },
  });

  return { ...result, hosts };
}
