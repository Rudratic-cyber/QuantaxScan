import { assetsTable, observationsTable, collectionRunsTable } from "@workspace/db/schema";
import type { ScopedTx } from "@workspace/db/org-scope";
import {
  collectSourceObservations,
  collectDependencyObservations,
  computeFingerprint,
  dependencyLocationPrefix,
  ecosystemsIn,
  fingerprintForObservation,
  lockfilesIn,
  type RawObservation,
  type Surface,
} from "@workspace/collectors";
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

    assetValuesByFingerprint.set(fingerprint, {
      organizationId,
      fingerprint,
      surface: fingerprintInput.surface,
      algorithm: raw.algorithm,
      keySize,
      location: raw.location,
      locationDetail: raw.locationDetail,
      status: "active",
    });

    pendingObservations.push({
      fingerprint,
      values: {
        organizationId,
        collector: spec.collector,
        collectorVersion: spec.collectorVersion,
        confidence: raw.confidence,
        discoveryModality: raw.discoveryModality,
        evidence: { ...raw.evidence, algorithm: raw.algorithm, keySize, location: raw.location },
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

    const upserted = await tx
      .insert(assetsTable)
      .values([...assetValuesByFingerprint.values()])
      .onConflictDoUpdate({
        target: [assetsTable.organizationId, assetsTable.fingerprint],
        set: {
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
        },
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
      await tx.update(assetsTable).set({ status: "gone" }).where(inArray(assetsTable.id, goneAssetIds));
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
