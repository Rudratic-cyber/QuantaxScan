import { Router, type IRouter } from "express";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  withOrg,
  projectsTable,
  scansTable,
  findingsTable,
  assetsTable,
  observationsTable,
  collectionRunsTable,
  discoveredTargetsTable,
  networkFlowsTable,
  projectRepoId,
} from "@workspace/db";
import {
  CreateProjectBody,
  GetProjectParams,
  DeleteProjectParams,
  SubmitProjectDependenciesBody,
  SubmitProjectCertificatesBody,
  SubmitProjectTlsBody,
  SubmitProjectProtocolConfigBody,
  SubmitProjectKmsBody,
  SubmitProjectDataAtRestBody,
  SubmitProjectNetworkFlowsBody,
  SubmitProjectEndpointBody,
} from "@workspace/api-zod";
import {
  lockfilesIn,
  certificatesIn,
  protocolConfigsIn,
  KMS_KEY_SPECS_CRITICAL_CAVEAT,
  type KmsKeyDescription,
  type KmsKeyOutcome,
  collectDataAtRestObservations,
  collectNetworkFlowObservations,
  type DataAtRestStoreInput,
  type DataAtRestStoreResult,
  type LocationDetail,
  type NetworkFlowConversation,
  type NetworkFlowRecordInput,
  collectEndpointObservations,
  type EndpointHostReport,
  type EndpointHostResult,
} from "@workspace/collectors";
import { scanCode, computeScanResult } from "../lib/scanner";
import { summariseProjectCoverage } from "../lib/coverage";
import { examinedHostPorts, summariseDiscoveryCoverage } from "../lib/discovery-coverage";
import { withComplianceAll, resolveCompliance } from "../lib/compliance";
import {
  ingestDependencyObservations,
  ingestCertificateObservations,
  ingestTlsObservations,
  ingestProtocolConfigObservations,
  ingestKmsObservations,
  ingestDataAtRestObservations,
  ingestNetworkFlowObservations,
  ingestEndpointObservations,
  type CertificateSummary,
} from "../lib/asset-ingest";
import { evaluateCertificateExpiryAgainstQDay } from "../lib/certificate-risk";
import { resolveSecrecyLifetime, type DataClassification } from "@workspace/db/classification";
import { assessMoscaRisk, migrationYearsFromEffortHours, DEFAULT_QDAY_SCENARIOS, QDAY_FRAMING } from "@workspace/risk";
// `zod`, not `zod/v4`: the generated schemas in `@workspace/api-zod` import
// `zod`, and inferring off a different module identity yields `unknown`.
import type * as zod from "zod";
import { probeTlsTargets } from "../lib/tls-probe";
import { orgContextFor } from "../lib/principal";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Every handler runs inside `withOrg` and uses the `tx` it is handed rather
 * than the module-level `db` — which is why `db` is not imported here at all.
 *
 * The `where organization_id = ...` clauses you might expect are absent on
 * purpose: the row-level security policies supply them, so forgetting one
 * returns zero rows rather than another tenant's data.
 */
router.get("/projects", async (req, res): Promise<void> => {
  const projects = await withOrg(orgContextFor(req), (tx) =>
    tx.select().from(projectsTable).orderBy(projectsTable.createdAt),
  );
  res.json(projects);
});

router.post("/projects", async (req, res): Promise<void> => {
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, description, language, code } = parsed.data;
  const ctx = orgContextFor(req);

  // Run initial scan
  const fileName = `main.${language === "python" ? "py" : language === "javascript" ? "js" : language === "typescript" ? "ts" : language === "go" ? "go" : language === "java" ? "java" : "txt"}`;
  const findings = scanCode(code ?? "", fileName, language);
  const totalLines = (code ?? "").split("\n").length;
  const result = computeScanResult(findings, totalLines);

  const [project] = await withOrg(ctx, (tx) =>
    tx
      .insert(projectsTable)
      .values({
        organizationId: ctx.organizationId,
        name,
        description,
        language,
        riskScore: result.riskScore,
        lastScanAt: new Date(),
        totalScans: 1,
        criticalCount: result.criticalCount,
        alertCount: result.alertCount,
        cleanCount: result.cleanCount,
      })
      .returning(),
  );

  res.status(201).json(project);
});

router.get("/projects/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  const [project] = await withOrg(orgContextFor(req), (tx) =>
    tx.select().from(projectsTable).where(eq(projectsTable.id, params.data.id)),
  );

  // Another organisation's project is indistinguishable from one that does not
  // exist, which is the intended answer — a 403 would confirm it is real.
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json(project);
});

router.delete("/projects/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteProjectParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  // `scans`/`findings` cascade off the project's foreign key, but
  // `assets`/`observations` are organization-scoped and have no FK to a
  // project — so deleting a project would otherwise leave its assets behind
  // forever, with the submitted `codeSnippet` still in `observations.evidence`.
  // Reconcile them by the `project:<id>:` location prefix; `observations`
  // cascade off `assets`. The id is a validated integer, so the LIKE pattern
  // carries no wildcard or injection risk.
  //
  // A cross-tenant delete now reaches nothing rather than being prevented by
  // the where clause: the policy filters the rows before either statement
  // sees them.
  await withOrg(orgContextFor(req), async (tx) => {
    await tx.delete(assetsTable).where(like(assetsTable.location, `${projectRepoId(params.data.id)}:%`));
    await tx.delete(projectsTable).where(eq(projectsTable.id, params.data.id));
  });
  res.sendStatus(204);
});

// GET /api/projects/:id/findings — all findings across all scans in a project,
// aggregated by algorithm for the dashboard chart
router.get("/projects/:id/findings", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid project ID" }); return; }

  const findings = await withOrg(orgContextFor(req), async (tx) => {
    const scanRows = await tx
      .select({ id: scansTable.id })
      .from(scansTable)
      .where(eq(scansTable.projectId, id));

    if (scanRows.length === 0) return [];

    const scanIds = scanRows.map((s) => s.id);
    return tx.select().from(findingsTable).where(inArray(findingsTable.scanId, scanIds));
  });

  // Obligations are derived on read, not read off the row — see lib/compliance.ts.
  res.json(withComplianceAll(findings));
});

/**
 * GET /api/projects/:id/coverage — D3, the coverage and confidence meter.
 * docs/Claude/03-features.md §D3; closes the reporting half of
 * docs/Claude/09-open-gaps.md G-11.
 *
 * The first consumer of `observations.confidence`, which until now was written
 * on every scan and read by nothing.
 *
 * Three details that are the whole point of the endpoint:
 *
 *  - It reports the surfaces that *have* evidence and says nothing about the
 *    rest, because "absent from this list" is the machine-readable form of
 *    "never examined". The catalogue in `@workspace/collectors` supplies the
 *    denominator so the API and the UI cannot disagree about what ten means.
 *  - Runs are matched by `collection_runs.target = project:<id>`, which is what
 *    `POST /scans`, `POST /scans/multi` and the backfill all write (they all go
 *    through `projectRepoId`). Assets are matched by the `project:<id>:`
 *    location prefix, the same convention `DELETE /projects/:id` reconciles on.
 *  - An unknown *or* another organisation's project is a 404, matching
 *    `GET /projects/:id`. Returning an empty coverage payload instead would
 *    tell the caller the project exists and has no coverage, which is a
 *    different — and false — statement.
 */
router.get("/projects/:id/coverage", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }
  const id = params.data.id;
  const repo = projectRepoId(id);

  const coverage = await withOrg(orgContextFor(req), async (tx) => {
    const [project] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, id));
    if (!project) return null;

    const [runs, assets] = await Promise.all([
      tx
        .select({
          surface: collectionRunsTable.surface,
          status: collectionRunsTable.status,
          startedAt: collectionRunsTable.startedAt,
          completedAt: collectionRunsTable.completedAt,
        })
        .from(collectionRunsTable)
        .where(eq(collectionRunsTable.target, repo)),
      tx
        .select({
          id: assetsTable.id,
          surface: assetsTable.surface,
          status: assetsTable.status,
          location: assetsTable.location,
        })
        .from(assetsTable)
        .where(like(assetsTable.location, `${repo}:%`)),
    ]);

    // D8 — the denominator this meter has never had. Absent, not zero, when
    // discovery has never run for this project: see `ProjectCoverage.discovery`.
    const discovered = await tx
      .select({ hostname: discoveredTargetsTable.hostname })
      .from(discoveredTargetsTable)
      .where(eq(discoveredTargetsTable.projectId, id));
    const discovery =
      discovered.length === 0
        ? undefined
        : summariseDiscoveryCoverage({
            hostnames: discovered.map((d) => d.hostname),
            examinedHostnames: examinedHostPorts(
              repo,
              assets.filter((a) => a.surface === "tls").map((a) => a.location),
            ).keys(),
          });

    // Observations are fetched per asset rather than aggregated in SQL because
    // the "one point per asset, latest observation wins" rule lives in the pure
    // summariser, where it is unit-tested. If a project ever holds enough
    // assets for this to matter, push the DISTINCT ON down into the query —
    // the summariser's contract stays the same either way.
    const assetIds = assets.map((a) => a.id);
    const observations = assetIds.length === 0
      ? []
      : await tx
          .select({
            id: observationsTable.id,
            assetId: observationsTable.assetId,
            confidence: observationsTable.confidence,
            observedAt: observationsTable.observedAt,
          })
          .from(observationsTable)
          .where(inArray(observationsTable.assetId, assetIds));

    return summariseProjectCoverage({ runs, assets, observations, discovery });
  });

  if (!coverage) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json({ projectId: id, generatedAt: new Date().toISOString(), ...coverage });
});

/**
 * B2 — `POST /api/projects/:id/dependencies`. docs/Claude/03-features.md §B2.
 *
 * **Why a new route rather than extending `POST /api/github/scan-files`.**
 * That route was the obvious candidate and it does not work, for two
 * independent reasons. First, no lockfile ever reaches it: its sibling
 * `POST /api/github/fetch` selects candidate files with `SCANNABLE_EXTENSIONS`,
 * which lists source extensions only — `.json`, `.yaml` and `.txt` are absent,
 * so `pnpm-lock.yaml`, `package-lock.json` and `requirements.txt` are filtered
 * out before a client ever sees them. Second, and decisively, `scan-files`
 * persists nothing: it takes no project id, opens no organisation scope and
 * writes no row (it is declared in `cross-tenant.test.ts`'s manifest as a route
 * that "touches no database at all"). Persisting a dependency asset from it
 * would mean giving a stateless demo endpoint a project parent, an org scope
 * and a lifecycle reconciliation — i.e. building this route inside that one.
 * The scan path that *does* persist is `POST /scans`, and this route is its
 * dependency-surface counterpart: same organisation scope, same parent check,
 * same ingest module.
 *
 * The response deliberately distinguishes "we examined the dependencies and
 * found nothing" from "nothing we could read was submitted" — see the
 * `lockfilesRecognised: 0` branch. Collapsing those two is the exact
 * dishonesty D3's coverage meter exists to prevent.
 */

/**
 * A bound on how many lockfiles one submission may carry. The body limit
 * (`express.json({ limit: "10mb" })` in `app.ts`) already caps total bytes;
 * this caps the parse work. Exceeding it is a 400 rather than a silent
 * truncation to the first N: quietly dropping lockfiles would understate the
 * dependency tree while reporting the surface as examined, which is worse
 * than refusing.
 */
const MAX_LOCKFILES_PER_SUBMISSION = 50;

/**
 * Stated on every response rather than left for a client to remember. A
 * lockfile pins the fully *resolved* graph, so a match may be a transitive
 * dependency of the build toolchain rather than a library this project's code
 * calls — see docs/Claude/09-open-gaps.md G-20.
 */
const EVIDENCE_CAVEAT =
  "A lockfile records the fully resolved dependency graph. A matched package may be a transitive " +
  "dependency of the toolchain rather than a library this project's own code calls; this collector " +
  "reports presence in the dependency graph, not use by first-party code.";

router.post("/projects/:id/dependencies", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }
  const body = SubmitProjectDependenciesBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const id = params.data.id;
  const repo = projectRepoId(id);
  const files = body.data.files;

  // Which of the submitted files the collector can actually read. Computed
  // before the scope is opened because it decides whether there is anything
  // to write at all, and because `@workspace/collectors` is pure.
  const recognised = lockfilesIn({ kind: "source", repo, files: files.map((f) => ({ ...f, language: "lockfile" })) });
  if (recognised.length > MAX_LOCKFILES_PER_SUBMISSION) {
    res.status(400).json({
      error: `Too many lockfiles in one submission (${recognised.length} > ${MAX_LOCKFILES_PER_SUBMISSION}). Split the request rather than truncating it.`,
    });
    return;
  }

  const outcome = await withOrg(orgContextFor(req), async (tx) => {
    // A foreign key is not subject to RLS, and `assets` has no foreign key to
    // `projects` at all — the association is the `project:<id>:` prefix this
    // route is about to write into `location`. So the parent must be confirmed
    // visible *inside* the scope, exactly as `POST /scans` does, or a caller
    // could stamp assets with another organisation's project id. (The policy
    // would still stamp the row with the caller's organisation, so nothing
    // leaks; it would create assets attributed to a project nobody can see.)
    const [parent] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, id));
    if (!parent) return null;

    // No recognised lockfile means we examined nothing. Writing a collection
    // run here would make `GET /projects/:id/coverage` report the dependency
    // surface as "examined — nothing found", which is a different and false
    // statement. Not an error either: a repository may legitimately have none.
    if (recognised.length === 0) return { kind: "no-lockfiles" as const };

    return {
      kind: "ingested" as const,
      result: await ingestDependencyObservations(tx, {
        repo,
        files,
        organizationId: orgContextFor(req).organizationId,
      }),
    };
  });

  if (outcome === null) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (outcome.kind === "no-lockfiles") {
    res.json({
      projectId: id,
      lockfilesRecognised: 0,
      lockfiles: [],
      collectionRunId: null,
      assetsCreated: 0,
      assetsUpdated: 0,
      observationsCreated: 0,
      assetsMarkedGone: 0,
      evidenceCaveat: EVIDENCE_CAVEAT,
    });
    return;
  }

  const { result } = outcome;
  logger.info(
    { projectId: id, lockfiles: result.lockfiles.length, observations: result.observationsCreated, route: "POST /projects/:id/dependencies" },
    "dependency collection complete",
  );

  res.json({
    projectId: id,
    lockfilesRecognised: result.lockfiles.length,
    lockfiles: result.lockfiles,
    collectionRunId: result.collectionRunId,
    assetsCreated: result.assetsCreated,
    assetsUpdated: result.assetsUpdated,
    observationsCreated: result.observationsCreated,
    assetsMarkedGone: result.assetsMarkedGone,
    evidenceCaveat: EVIDENCE_CAVEAT,
  });
});

/**
 * B4 — `POST /api/projects/:id/certificates` and `GET
 * /api/projects/:id/certificates`. docs/Claude/03-features.md §B4;
 * docs/Claude/02-roadmap.md M2 exit criterion: "Certificate inventory shows
 * which certs outlive the conservative Q-Day scenario."
 *
 * Modelled on the dependency route immediately above: same organisation
 * scope, same in-scope parent check (a foreign key is not subject to RLS —
 * `assets` has none to `projects` at all, so the parent must be confirmed
 * visible inside the scope before writing a child row), same "examined
 * nothing vs found nothing" distinction for the coverage meter.
 *
 * What differs is the reason a **second** route exists at all: the POST
 * response reports what one submission found, at the moment it was
 * submitted — that answers "did the collector run?", not "what does the
 * inventory say?" `GET /projects/:id/certificates` is the actual inventory
 * read, over the persisted assets, evaluated against Q-Day fresh on every
 * call — the same "derive on read, never persist a standards-dependent
 * verdict" discipline `lib/compliance.ts` uses for findings. Without this
 * second route, "outlives Q-Day" would only ever have been visible once, to
 * whoever happened to be watching the upload response, which is ingest
 * telemetry, not an inventory.
 */

/** Mirrors `MAX_LOCKFILES_PER_SUBMISSION` above — a bound on parse work, not on request size (the body limit already caps that). */
const MAX_CERTIFICATES_PER_SUBMISSION = 200;

const CERTIFICATE_EVIDENCE_CAVEAT =
  "This collector reads a submitted certificate's own stated public-key algorithm, size and validity period. " +
  "It does not verify the certificate is currently presented by a live endpoint, is trusted by any client, or " +
  "is part of a valid chain. An EC public key is reported as ECDSA: X.509 key-usage extensions are not reliably " +
  "present to distinguish an ECDSA-signing key from an ECDH-only one, so this is a known simplification, not a claim.";

function toCertificateResponseEntry(summary: CertificateSummary) {
  return {
    ...summary,
    qDay: evaluateCertificateExpiryAgainstQDay(new Date(summary.notAfter)),
  };
}

router.post("/projects/:id/certificates", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }
  const body = SubmitProjectCertificatesBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const id = params.data.id;
  const repo = projectRepoId(id);
  const files = body.data.files;

  // Which submitted files carry at least one parseable certificate.
  // Computed before the scope is opened, same reason `lockfilesIn` is above:
  // it decides whether there is anything to write at all, and
  // `@workspace/collectors` is pure.
  const recognised = certificatesIn({ kind: "source", repo, files: files.map((f) => ({ ...f, language: "certificate" })) });
  const certificateCount = recognised.reduce((sum, f) => sum + f.certificateCount, 0);
  if (certificateCount > MAX_CERTIFICATES_PER_SUBMISSION) {
    res.status(400).json({
      error: `Too many certificates in one submission (${certificateCount} > ${MAX_CERTIFICATES_PER_SUBMISSION}). Split the request rather than truncating it.`,
    });
    return;
  }

  const outcome = await withOrg(orgContextFor(req), async (tx) => {
    const [parent] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, id));
    if (!parent) return null;

    // No parseable certificate means we examined nothing. Writing a
    // collection run here would make GET /projects/:id/coverage report the
    // certificate surface as "examined — nothing found", which is a
    // different and false statement — the file may simply not be a
    // certificate. Not an error either: a submission may legitimately carry
    // none (a caller probing before it has real material to send).
    if (recognised.length === 0) return { kind: "no-certificates" as const };

    return {
      kind: "ingested" as const,
      result: await ingestCertificateObservations(tx, {
        repo,
        files,
        organizationId: orgContextFor(req).organizationId,
      }),
    };
  });

  if (outcome === null) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (outcome.kind === "no-certificates") {
    res.json({
      projectId: id,
      certificatesRecognised: 0,
      certificateFiles: [],
      collectionRunId: null,
      assetsCreated: 0,
      assetsUpdated: 0,
      observationsCreated: 0,
      assetsMarkedGone: 0,
      certificates: [],
      evidenceCaveat: CERTIFICATE_EVIDENCE_CAVEAT,
    });
    return;
  }

  const { result } = outcome;
  logger.info(
    {
      projectId: id,
      certificateFiles: result.certificateFiles.length,
      observations: result.observationsCreated,
      route: "POST /projects/:id/certificates",
    },
    "certificate collection complete",
  );

  res.json({
    projectId: id,
    certificatesRecognised: result.certificates.length,
    certificateFiles: result.certificateFiles,
    collectionRunId: result.collectionRunId,
    assetsCreated: result.assetsCreated,
    assetsUpdated: result.assetsUpdated,
    observationsCreated: result.observationsCreated,
    assetsMarkedGone: result.assetsMarkedGone,
    certificates: result.certificates.map(toCertificateResponseEntry),
    evidenceCaveat: CERTIFICATE_EVIDENCE_CAVEAT,
  });
});

/**
 * The inventory read: every certificate asset attributed to this project,
 * each evaluated against every Q-Day scenario at read time. `status` is
 * included and NOT filtered to `active` — a `gone` or `remediated`
 * certificate is still part of the record docs/Claude/03-features.md A1
 * promises ("stays in history"); the caller can filter client-side if it
 * only wants the current picture.
 */
router.get("/projects/:id/certificates", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }
  const id = params.data.id;
  const repo = projectRepoId(id);

  const certificates = await withOrg(orgContextFor(req), async (tx) => {
    const [project] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, id));
    if (!project) return null;

    return tx
      .select({
        id: assetsTable.id,
        algorithm: assetsTable.algorithm,
        keySize: assetsTable.keySize,
        location: assetsTable.location,
        locationDetail: assetsTable.locationDetail,
        status: assetsTable.status,
        firstSeen: assetsTable.firstSeen,
        lastSeen: assetsTable.lastSeen,
      })
      .from(assetsTable)
      .where(and(eq(assetsTable.surface, "certificate"), like(assetsTable.location, `${repo}:%`)));
  });

  if (certificates === null) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json({
    projectId: id,
    generatedAt: new Date().toISOString(),
    certificates: certificates.flatMap((asset) => {
      const detail = asset.locationDetail;
      // Defensive, not expected: every row on this surface was written by
      // ingestCertificateObservations, which always sets this. Skipping
      // rather than throwing keeps one malformed historical row from taking
      // the whole inventory read down.
      if (detail?.kind !== "certificate") {
        logger.warn({ assetId: asset.id }, "certificate asset has no certificate locationDetail — skipped");
        return [];
      }
      return [
        {
          assetId: asset.id,
          algorithm: asset.algorithm,
          keySize: asset.keySize,
          status: asset.status,
          issuer: detail.certificate.issuer,
          serialNumber: detail.certificate.serialNumber,
          subject: detail.certificate.subject ?? null,
          notBefore: detail.certificate.notBefore,
          notAfter: detail.certificate.notAfter,
          signatureAlgorithm: detail.certificate.signatureAlgorithm ?? null,
          firstSeen: asset.firstSeen.toISOString(),
          lastSeen: asset.lastSeen.toISOString(),
          qDay: evaluateCertificateExpiryAgainstQDay(new Date(detail.certificate.notAfter)),
        },
      ];
    }),
  });
});

/**
 * B3 — `POST /api/projects/:id/tls`. docs/Claude/03-features.md §B3.
 *
 * Same shape as the dependency route above — org-scoped, parent confirmed
 * inside the scope, a run recorded only when something was actually
 * examined — with one deliberate structural difference: **the probe runs
 * before `withOrg` is opened.** `withOrg` holds a real database transaction
 * for its whole callback, and this route's expensive step is outbound
 * `node:tls` connections to caller-named hosts — up to
 * `MAX_TLS_TARGETS_PER_SUBMISSION` of them, each up to `TLS_PROBE_TIMEOUT_MS`
 * — which has nothing to do with the database and must not hold a pooled
 * connection idle for however long that takes. The cost: an unrecognised or
 * another organisation's project id still triggers the probe before the 404
 * is returned, which is wasted egress, not a data leak — nothing about the
 * probe is persisted or returned until the parent is confirmed visible
 * inside the scope, exactly like the dependency route.
 *
 * Every target the guard refuses or that never completes a handshake is
 * still named in the response (`targets[].outcome`), so a caller submitting
 * five hosts where three are refused and one times out sees that shape
 * rather than a single opaque count.
 */
const TLS_EVIDENCE_CAVEAT =
  "Records the negotiated key-exchange algorithm/group and the peer certificate's public key type/size only " +
  "— no certificate identity, chain or validity (see B4). Certificates are not validated against any CA: this " +
  "collector observes what a host negotiates, not whether a browser would trust it.";

router.post("/projects/:id/tls", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }
  const body = SubmitProjectTlsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const id = params.data.id;
  const repo = projectRepoId(id);
  const targets = body.data.targets;

  // Every target is resolved, SSRF-checked and (if allowed) connected to
  // here — see the doc comment above for why this runs ahead of `withOrg`.
  const outcomes = await probeTlsTargets(targets);
  const probed = outcomes.filter(
    (o): o is Extract<(typeof outcomes)[number], { outcome: "probed" }> => o.outcome === "probed",
  );

  const ctx = orgContextFor(req);
  const outcome = await withOrg(ctx, async (tx) => {
    // Same reasoning as every other route with a client-supplied parent id:
    // a foreign key is not subject to RLS, and `assets` has no foreign key
    // to `projects` at all — the association is the `project:<id>:`
    // location prefix this route is about to write. The parent must be
    // confirmed visible *inside* the scope.
    const [parent] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, id));
    if (!parent) return null;

    // No completed handshake means we examined nothing. Writing a
    // collection run here would make GET /projects/:id/coverage report the
    // tls surface as "examined — nothing found," which is a different and
    // false statement. Not an error either: every target may legitimately
    // be refused or unreachable in one submission.
    if (probed.length === 0) return { kind: "no-handshakes" as const };

    return {
      kind: "ingested" as const,
      result: await ingestTlsObservations(tx, {
        repo,
        probed: probed.map((p) => ({ host: p.host, port: p.port, handshake: p.handshake })),
        organizationId: ctx.organizationId,
      }),
    };
  });

  if (outcome === null) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const targetsSummary = outcomes.map((o) => ({ host: o.host, port: o.port, outcome: o.outcome }));

  if (outcome.kind === "no-handshakes") {
    res.json({
      projectId: id,
      targetsSubmitted: targets.length,
      targetsProbed: 0,
      targets: targetsSummary,
      collectionRunId: null,
      assetsCreated: 0,
      assetsUpdated: 0,
      observationsCreated: 0,
      assetsMarkedGone: 0,
      evidenceCaveat: TLS_EVIDENCE_CAVEAT,
    });
    return;
  }

  const { result } = outcome;
  logger.info(
    { projectId: id, targetsProbed: probed.length, observations: result.observationsCreated, route: "POST /projects/:id/tls" },
    "TLS collection complete",
  );

  res.json({
    projectId: id,
    targetsSubmitted: targets.length,
    targetsProbed: probed.length,
    targets: targetsSummary,
    collectionRunId: result.collectionRunId,
    assetsCreated: result.assetsCreated,
    assetsUpdated: result.assetsUpdated,
    observationsCreated: result.observationsCreated,
    assetsMarkedGone: result.assetsMarkedGone,
    evidenceCaveat: TLS_EVIDENCE_CAVEAT,
  });
});

/**
 * B6 — `POST /api/projects/:id/protocol-config`. docs/Claude/03-features.md
 * §B6: "SSH, IPsec, JWT `alg`, SAML/OIDC signing".
 *
 * Same shape as the dependency and certificate routes above — org-scoped,
 * parent confirmed inside the scope (a foreign key is not subject to RLS, and
 * `assets` has none to `projects` at all: the association is the
 * `project:<id>:` location prefix this route is about to write), a run
 * recorded only when something was actually examined. It reuses their
 * submission shape (path + content) deliberately rather than inventing a
 * third: reading a config file is the same job as reading a lockfile, and the
 * caller that can produce one can produce the other.
 *
 * **Where it differs, and why the difference is the interesting part.** The
 * three routes above collapse "examined nothing" and "found nothing" at the
 * same boundary — no lockfile, no certificate, no completed handshake all mean
 * the collector had nothing to work with. This surface separates them one
 * level further, because a configuration file can be perfectly readable and
 * declare no crypto at all: an `sshd_config` that leaves every algorithm
 * directive at the compiled-in default was *examined*, and the honest answer
 * is a recorded run with zero observations, not silence. So the gate here is
 * "did we recognise a configuration file", not "did we find an algorithm" —
 * see `ingestProtocolConfigObservations`, which enforces the same rule so it
 * cannot depend on this route remembering it.
 *
 * No `GET` counterpart, unlike B4. The certificate route needed one because
 * "outlives Q-Day" is derived on read and had nowhere else to live; a config
 * declaration is a plain asset with no read-time derivation, and
 * `GET /api/inventory/assets?surface=config` already returns it.
 */

/** Mirrors `MAX_LOCKFILES_PER_SUBMISSION` — a bound on parse work, not on request size (the body limit already caps that). */
const MAX_CONFIG_FILES_PER_SUBMISSION = 100;

const PROTOCOL_CONFIG_EVIDENCE_CAVEAT =
  "This collector reads what a configuration file declares, not what an endpoint negotiates — a permitted-algorithm " +
  "list is an upper bound on what would be accepted, not evidence any peer selected it (see B3 for what was actually " +
  "agreed on the wire). Three things it deliberately does not do: it does not follow `Include`/`@include` directives, " +
  "because the caller submits file contents rather than a filesystem; it does not infer the compiled-in default set " +
  "when a directive is absent, because that set varies by version and distribution; and it reports nothing at all for " +
  "an algorithm token it does not recognise, including hybrid post-quantum key exchange such as " +
  "sntrup761x25519-sha512, rather than guessing at it.";

router.post("/projects/:id/protocol-config", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }
  const body = SubmitProjectProtocolConfigBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const id = params.data.id;
  const repo = projectRepoId(id);
  const files = body.data.files;

  // Which submitted files are a configuration this collector understands.
  // Computed before the scope is opened, same reason `lockfilesIn` and
  // `certificatesIn` are above: it decides whether there is anything to write
  // at all, and `@workspace/collectors` is pure.
  const recognised = protocolConfigsIn({ kind: "source", repo, files: files.map((f) => ({ ...f, language: "config" })) });
  if (recognised.length > MAX_CONFIG_FILES_PER_SUBMISSION) {
    res.status(400).json({
      error: `Too many configuration files in one submission (${recognised.length} > ${MAX_CONFIG_FILES_PER_SUBMISSION}). Split the request rather than truncating it.`,
    });
    return;
  }

  const ctx = orgContextFor(req);
  const outcome = await withOrg(ctx, async (tx) => {
    const [parent] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, id));
    if (!parent) return null;

    // Nothing recognised means we examined nothing. Note what this branch is
    // NOT: a recognised file that declares no algorithm falls through to the
    // ingest, records a run and reports zero observations, because "we read
    // your sshd_config and it configures no crypto" is a true and useful
    // answer. Collapsing the two would make `GET /projects/:id/coverage`
    // either overstate or understate what was looked at, depending on which
    // way it collapsed.
    if (recognised.length === 0) return { kind: "no-config-files" as const };

    return {
      kind: "ingested" as const,
      result: await ingestProtocolConfigObservations(tx, { repo, files, organizationId: ctx.organizationId }),
    };
  });

  if (outcome === null) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (outcome.kind === "no-config-files") {
    res.json({
      projectId: id,
      configFilesRecognised: 0,
      configFiles: [],
      collectionRunId: null,
      assetsCreated: 0,
      assetsUpdated: 0,
      observationsCreated: 0,
      assetsMarkedGone: 0,
      declarations: [],
      evidenceCaveat: PROTOCOL_CONFIG_EVIDENCE_CAVEAT,
    });
    return;
  }

  const { result } = outcome;
  logger.info(
    {
      projectId: id,
      configFiles: result.configFiles.length,
      observations: result.observationsCreated,
      route: "POST /projects/:id/protocol-config",
    },
    "protocol configuration collection complete",
  );

  res.json({
    projectId: id,
    configFilesRecognised: result.configFiles.length,
    configFiles: result.configFiles,
    collectionRunId: result.collectionRunId,
    assetsCreated: result.assetsCreated,
    assetsUpdated: result.assetsUpdated,
    observationsCreated: result.observationsCreated,
    assetsMarkedGone: result.assetsMarkedGone,
    declarations: result.declarations,
    evidenceCaveat: PROTOCOL_CONFIG_EVIDENCE_CAVEAT,
  });
});

/**
 * B5 — `POST /api/projects/:id/kms` and `GET /api/projects/:id/kms`.
 * docs/Claude/03-features.md §B5.
 *
 * Structurally the dependency route, with the same organisation scope, the
 * same in-scope parent check (a foreign key is not subject to RLS — `assets`
 * has none to `projects` at all), and the same second route for the
 * persisted-inventory read that B4 introduced. Two things differ, both
 * deliberate.
 *
 * **It is submission-based, not credentialed.** The caller posts the key
 * inventory their own `describe-key`/`keys list` already produced. Four
 * live-credentialed pollers would mean four cloud SDKs, four auth flows, and
 * long-lived read-only credentials into a customer's key store held in a
 * product whose secret-handling controls (F4) do not exist yet — and none of
 * that is needed to make the surface real. `kms-collector.ts`'s header has
 * the full argument; the credentialed poller is strictly additive and
 * produces the same `KmsKeyDescription` values.
 *
 * **The "examined nothing" branch is narrower than every other collector's.**
 * B2/B3/B4 refuse a run when nothing readable was submitted. Here, a key
 * store holding only HMAC and AES-wrapping keys *was* examined and every key
 * *was* classified — there is simply nothing on this product's reportable
 * list in it, which is `examined, nothing found` and is exactly what
 * `collection_runs` exists to make sayable. So only an empty `keys` array
 * skips the run. See `ingestKmsObservations` for the full reasoning.
 *
 * The GET is not redundant with `GET /inventory/assets`: that endpoint does
 * not return `locationDetail`, and provider, key id, spec, rotation state,
 * origin and key store all live there. Without this route a key's rotation
 * posture would be write-only.
 */

/**
 * There is deliberately **no** `MAX_KMS_KEYS_PER_SUBMISSION` constant here,
 * unlike `MAX_LOCKFILES_PER_SUBMISSION` and
 * `MAX_CERTIFICATES_PER_SUBMISSION` above. Those two count things that only
 * exist after parsing — recognised lockfiles, parsed certificates — which no
 * request schema can express, so the bound has to live in the handler. This
 * one is a plain array length, so it lives in `SubmitProjectKmsBody`'s
 * `maxItems` where clients generated from the spec can enforce it too. A
 * second check here would be a branch the zod parse above makes unreachable.
 */

/**
 * The curated table's own `criticalCaveat` is concatenated rather than
 * paraphrased, the same way B2 surfaces `crypto-packages.json`'s. A caveat
 * that lives only in the data file is a caveat no customer ever reads, and a
 * paraphrase in TypeScript is a second copy that can drift from the claim it
 * qualifies.
 */
const KMS_EVIDENCE_CAVEAT =
  "This collector reads a key inventory you submitted; no credential for your key store ever reaches this " +
  "product and nothing here connects to a provider. A key spec is resolved against a cited table of the " +
  "providers' own documentation, so a spec that table does not carry is reported as unclassified rather " +
  "than mapped to a similar one. " +
  KMS_KEY_SPECS_CRITICAL_CAVEAT;

/**
 * Flattens one collector outcome into the response shape. Every non-`observed`
 * outcome still appears: "we looked at 40 keys, classified 31, and here is
 * what the other 9 were" is the answer a key inventory has to give, and a
 * response that listed only the 31 would read as a complete inventory of 31
 * keys.
 */
function toKmsKeyResponseEntry(outcome: KmsKeyOutcome) {
  const { key } = outcome;
  const base = {
    provider: key.provider,
    keyId: key.keyId,
    keySpec: key.keySpec ?? null,
    alias: key.alias ?? null,
    keyState: key.keyState ?? null,
    // Absent, not false — the export said nothing, and `false` would claim
    // this key is not rotated.
    rotationEnabled: key.rotationEnabled ?? null,
  };

  if (outcome.kind !== "observed") {
    return {
      ...base,
      outcome: outcome.kind,
      reason: outcome.reason,
      algorithm: null,
      // A `no-algorithm` spec can still state a size (HMAC_512 is 512 bits),
      // and reporting it is free information about a key we cannot classify.
      keySize: outcome.kind === "no-algorithm" ? outcome.entry.keySize : null,
      keySizeSource: null,
      location: null,
    };
  }

  const { observation } = outcome;
  return {
    ...base,
    outcome: outcome.kind,
    reason: null,
    algorithm: observation.algorithm,
    keySize: observation.keySize ?? null,
    keySizeSource: (observation.evidence["keySizeSource"] as string | undefined) ?? null,
    location: observation.location,
  };
}

router.post("/projects/:id/kms", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }
  const body = SubmitProjectKmsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const id = params.data.id;
  const repo = projectRepoId(id);
  // The generated body type lines up with `KmsKeyDescription` field for
  // field, with one genuine conversion: the spec declares `lastRotatedAt` as
  // `format: date-time`, so the generated schema parses it into a `Date`,
  // while the collector's contract is an ISO string. That is not pedantry —
  // `locationDetail` is written to `jsonb`, where a `Date` becomes a string
  // on the way in and stays one on the way out (the same reason
  // `CertificateLocationDetailSchema` holds strings), so converting here is
  // what keeps the value that is stored equal to the value the type claims.
  // Typed rather than cast, so a future spec change that widens the body
  // fails at compile time instead of reaching the collector.
  const keys: KmsKeyDescription[] = body.data.keys.map((key) => {
    const { lastRotatedAt, ...rest } = key;
    return lastRotatedAt === undefined ? rest : { ...rest, lastRotatedAt: lastRotatedAt.toISOString() };
  });

  const ctx = orgContextFor(req);
  const outcome = await withOrg(ctx, async (tx) => {
    // Same reasoning as every other route with a client-supplied parent id:
    // `assets` has no foreign key to `projects`, only the `project:<id>:`
    // location prefix this route is about to write, so the parent must be
    // confirmed visible *inside* the scope.
    const [parent] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, id));
    if (!parent) return null;

    // The only "we examined nothing" case here. Deliberately NOT "no key
    // resolved to an algorithm" — see this route's header and
    // `ingestKmsObservations`.
    if (keys.length === 0) return { kind: "no-keys" as const };

    return {
      kind: "ingested" as const,
      result: await ingestKmsObservations(tx, { repo, keys, organizationId: ctx.organizationId }),
    };
  });

  if (outcome === null) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (outcome.kind === "no-keys") {
    res.json({
      projectId: id,
      keysSubmitted: 0,
      keysObserved: 0,
      keysUnclassified: 0,
      keys: [],
      collectionRunId: null,
      assetsCreated: 0,
      assetsUpdated: 0,
      observationsCreated: 0,
      assetsMarkedGone: 0,
      evidenceCaveat: KMS_EVIDENCE_CAVEAT,
    });
    return;
  }

  const { result } = outcome;
  const observed = result.outcomes.filter((o) => o.kind === "observed").length;
  logger.info(
    {
      projectId: id,
      keysSubmitted: keys.length,
      keysObserved: observed,
      observations: result.observationsCreated,
      route: "POST /projects/:id/kms",
    },
    "KMS collection complete",
  );

  res.json({
    projectId: id,
    keysSubmitted: keys.length,
    keysObserved: observed,
    keysUnclassified: result.outcomes.length - observed,
    keys: result.outcomes.map(toKmsKeyResponseEntry),
    collectionRunId: result.collectionRunId,
    assetsCreated: result.assetsCreated,
    assetsUpdated: result.assetsUpdated,
    observationsCreated: result.observationsCreated,
    assetsMarkedGone: result.assetsMarkedGone,
    evidenceCaveat: KMS_EVIDENCE_CAVEAT,
  });
});

router.get("/projects/:id/kms", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }
  const id = params.data.id;
  const repo = projectRepoId(id);

  const keys = await withOrg(orgContextFor(req), async (tx) => {
    const [project] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, id));
    if (!project) return null;

    return tx
      .select({
        id: assetsTable.id,
        algorithm: assetsTable.algorithm,
        keySize: assetsTable.keySize,
        location: assetsTable.location,
        locationDetail: assetsTable.locationDetail,
        status: assetsTable.status,
        firstSeen: assetsTable.firstSeen,
        lastSeen: assetsTable.lastSeen,
      })
      .from(assetsTable)
      .where(and(eq(assetsTable.surface, "kms"), like(assetsTable.location, `${repo}:%`)));
  });

  if (keys === null) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json({
    projectId: id,
    generatedAt: new Date().toISOString(),
    keys: keys.flatMap((asset) => {
      const detail = asset.locationDetail;
      // Defensive, not expected: every row on this surface was written by
      // ingestKmsObservations, which always sets this. Skipping rather than
      // throwing keeps one malformed historical row from taking the whole
      // inventory read down — the same posture the certificate read takes.
      if (detail?.kind !== "kms") {
        logger.warn({ assetId: asset.id }, "kms asset has no kms locationDetail — skipped");
        return [];
      }
      return [
        {
          assetId: asset.id,
          provider: detail.kms.provider,
          keyId: detail.kms.keyId,
          keySpec: detail.kms.keySpec ?? null,
          alias: detail.kms.alias ?? null,
          keyState: detail.kms.keyState ?? null,
          algorithm: asset.algorithm,
          // Straight off the column, which is nullable with no default so
          // that "the provider stated no size" survives the round trip.
          keySize: asset.keySize,
          status: asset.status,
          // Null here is "the export did not say", which is why the column
          // is read with `??` rather than `Boolean(...)`.
          rotationEnabled: detail.kms.rotationEnabled ?? null,
          rotationPeriodDays: detail.kms.rotationPeriodDays ?? null,
          lastRotatedAt: detail.kms.lastRotatedAt ?? null,
          origin: detail.kms.origin ?? null,
          region: detail.kms.region ?? null,
          keyStore: detail.kms.keyStore ?? null,
          firstSeen: asset.firstSeen.toISOString(),
          lastSeen: asset.lastSeen.toISOString(),
        },
      ];
    }),
  });
});

/**
 * B7 — `POST /api/projects/:id/data-at-rest` and `GET
 * /api/projects/:id/data-at-rest`. docs/Claude/03-features.md §B7: "DB TDE,
 * backup/archive encryption — the true HNDL targets".
 *
 * Same shape as the four ingest routes above — org-scoped, parent confirmed
 * inside the scope, a run recorded only when something was actually examined —
 * with two differences that are the point of the lane.
 *
 * **It takes a description, not a credential.** The caller POSTs what their
 * engine's own configuration reports. Live collection would need somewhere to
 * put a production database credential, and this product has no secret-handling
 * design yet (F4 is unbuilt) — the same reasoning B5 applies to KMS. Building
 * one inside a collector lane is how a product ends up storing production
 * passwords by accident, so it is deliberately not attempted here.
 *
 * **It is the only ingest that accepts a data classification.** Data at rest is
 * the case where an adversary genuinely can copy the ciphertext today and
 * decrypt it after Q-Day, so X — how long the data must stay secret — is the
 * whole question, and the caller knows it at submission time because they know
 * what is in the store. Persisting it on the asset is what puts this surface in
 * front of the risk engine: `GET /api/inventory/assets` resolves X with
 * `resolveSecrecyLifetime()` and runs Mosca over every asset, so a Regulated
 * backup archive arrives there with X = 25 rather than the product's assumed 3.
 *
 * The GET exists for the reason B4's does, stated verbatim in that route's
 * comment: the POST response is ingest telemetry — what one submission found at
 * the moment it was submitted — and without a second route the Mosca verdict
 * would only ever be visible once, to whoever happened to be watching the
 * upload response.
 */

/** Mirrors `MAX_CERTIFICATES_PER_SUBMISSION` — a bound on work, not on request size. */
const MAX_DATA_AT_REST_STORES_PER_SUBMISSION = 500;

const DATA_AT_REST_EVIDENCE_CAVEAT =
  "This collector records what a store's configuration was reported to say, not what its ciphertext " +
  "actually is: nothing here connects to a database, reads a backup, or verifies that data already " +
  "written was written under the cipher now configured. A store reported as encrypted with no algorithm " +
  "named records nothing at all rather than an assumed one. The bulk cipher (usually AES) is not " +
  "quantum-vulnerable in NIST's assessment — the key-protection entry, which is how that data key is " +
  "wrapped, is where Q-Day applies, and a store that reports no key protection has not been cleared of it.";

type DataAtRestSubmissionStore = zod.infer<typeof SubmitProjectDataAtRestBody>["stores"][number];

/**
 * The generated body type carries the A3 classification fields alongside the
 * collector's inputs, because they arrive in the same object. They are split
 * apart here rather than in the collector: `@workspace/collectors` is
 * deliberately unaware that data classification exists — see
 * `lib/db/src/classification.ts` for why that boundary is where it is.
 */
function toStoreInput(store: DataAtRestSubmissionStore): DataAtRestStoreInput {
  return {
    storeId: store.storeId,
    engine: store.engine,
    storeKind: store.storeKind,
    encryptionState: store.encryptionState,
    evidenceSource: store.evidenceSource,
    description: store.description,
    dataEncryption: store.dataEncryption ?? undefined,
    keyProtection: store.keyProtection ?? undefined,
  };
}

function classificationsBySubmittedStoreId(
  stores: DataAtRestSubmissionStore[],
): Map<string, { dataClassification?: DataClassification | null; secrecyLifetimeYears?: number | null }> {
  const out = new Map<string, { dataClassification?: DataClassification | null; secrecyLifetimeYears?: number | null }>();
  for (const store of stores) {
    // Absent entirely, rather than an entry of nulls, when the caller supplied
    // neither — so the ingest writes null and `resolveSecrecyLifetime()` can
    // still tell "nobody said" from "somebody said Public".
    if (store.dataClassification == null && store.secrecyLifetimeYears == null) continue;
    out.set(store.storeId, {
      dataClassification: store.dataClassification ?? null,
      secrecyLifetimeYears: store.secrecyLifetimeYears ?? null,
    });
  }
  return out;
}

function toStoreResponse(result: DataAtRestStoreResult) {
  return {
    storeId: result.storeId,
    engine: result.engine,
    recorded: result.observations.map((observation) => {
      const detail = observation.locationDetail;
      if (detail?.kind !== "data-at-rest") {
        // Cannot happen: every observation here came from
        // `collectDataAtRestObservations`, which always sets this. Thrown
        // rather than defaulted, the same call `toCertificateSummary` makes —
        // a defaulted `role` would quietly label a key-protection fact as the
        // bulk cipher, which is the one confusion this surface exists to
        // prevent.
        throw new Error(`data-at-rest observation at ${observation.location} carries no data-at-rest locationDetail`);
      }
      return {
        role: detail.dataAtRest.role,
        algorithm: observation.algorithm,
        keySize: observation.keySize ?? null,
        reportedAlgorithm: detail.dataAtRest.reportedAlgorithm,
        location: observation.location,
      };
    }),
    gaps: result.gaps.map((gap) => ({ role: gap.role, reason: gap.reason, reported: gap.reported ?? null })),
  };
}

router.post("/projects/:id/data-at-rest", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }
  const body = SubmitProjectDataAtRestBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const id = params.data.id;
  const repo = projectRepoId(id);
  const submitted = body.data.stores;

  if (submitted.length > MAX_DATA_AT_REST_STORES_PER_SUBMISSION) {
    res.status(400).json({
      error: `Too many stores in one submission (${submitted.length} > ${MAX_DATA_AT_REST_STORES_PER_SUBMISSION}). Split the request rather than truncating it.`,
    });
    return;
  }

  const storeInputs = submitted.map(toStoreInput);
  // Run the pure collector before the scope is opened, same reason
  // `lockfilesIn`/`certificatesIn` are called there: it decides whether there is
  // anything to write at all, and it supplies the per-store gaps the response
  // reports even in the branch where nothing is written.
  const collected = collectDataAtRestObservations(repo, storeInputs);
  const saysSomething = collected.some((store) => store.observations.length > 0 || store.reobservedLocations.length > 0);

  const ctx = orgContextFor(req);
  const outcome = await withOrg(ctx, async (tx) => {
    // A foreign key is not subject to RLS, and `assets` has none to `projects`
    // at all — the association is the `project:<id>:` prefix this route is about
    // to write. The parent must be confirmed visible *inside* the scope.
    const [parent] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, id));
    if (!parent) return null;

    // Nothing reconcilable means nothing was examined: every store was
    // `unknown`, or every crypto field was blank. Writing a collection run here
    // would make GET /projects/:id/coverage report data-at-rest as "examined —
    // nothing found", which is a different and false statement about the
    // surface whose whole value is knowing what you have not looked at. Not an
    // error: listing stores you cannot yet describe is a legitimate first step.
    if (!saysSomething) return { kind: "nothing-stated" as const };

    return {
      kind: "ingested" as const,
      result: await ingestDataAtRestObservations(tx, {
        repo,
        stores: storeInputs,
        organizationId: ctx.organizationId,
        classificationByStoreId: classificationsBySubmittedStoreId(submitted),
      }),
    };
  });

  if (outcome === null) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const stores = (outcome.kind === "ingested" ? outcome.result.stores : collected).map(toStoreResponse);
  const storesWithRecordedCrypto = stores.filter((store) => store.recorded.length > 0).length;

  if (outcome.kind === "nothing-stated") {
    res.json({
      projectId: id,
      storesSubmitted: submitted.length,
      storesWithRecordedCrypto: 0,
      collectionRunId: null,
      assetsCreated: 0,
      assetsUpdated: 0,
      observationsCreated: 0,
      assetsMarkedGone: 0,
      stores,
      evidenceCaveat: DATA_AT_REST_EVIDENCE_CAVEAT,
    });
    return;
  }

  const { result } = outcome;
  logger.info(
    {
      projectId: id,
      storesSubmitted: submitted.length,
      storesWithRecordedCrypto,
      observations: result.observationsCreated,
      route: "POST /projects/:id/data-at-rest",
    },
    "data-at-rest collection complete",
  );

  res.json({
    projectId: id,
    storesSubmitted: submitted.length,
    storesWithRecordedCrypto,
    collectionRunId: result.collectionRunId,
    assetsCreated: result.assetsCreated,
    assetsUpdated: result.assetsUpdated,
    observationsCreated: result.observationsCreated,
    assetsMarkedGone: result.assetsMarkedGone,
    stores,
    evidenceCaveat: DATA_AT_REST_EVIDENCE_CAVEAT,
  });
});

router.get("/projects/:id/data-at-rest", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: parseInt(rawId, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }
  const id = params.data.id;
  const repo = projectRepoId(id);
  const now = new Date();

  const found = await withOrg(orgContextFor(req), async (tx) => {
    const [project] = await tx
      .select({
        id: projectsTable.id,
        dataClassification: projectsTable.dataClassification,
        secrecyLifetimeYears: projectsTable.secrecyLifetimeYears,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, id));
    if (!project) return null;

    const assets = await tx
      .select({
        id: assetsTable.id,
        algorithm: assetsTable.algorithm,
        keySize: assetsTable.keySize,
        location: assetsTable.location,
        locationDetail: assetsTable.locationDetail,
        status: assetsTable.status,
        firstSeen: assetsTable.firstSeen,
        lastSeen: assetsTable.lastSeen,
        effortHours: assetsTable.effortHours,
        dataClassification: assetsTable.dataClassification,
        secrecyLifetimeYears: assetsTable.secrecyLifetimeYears,
      })
      .from(assetsTable)
      .where(and(eq(assetsTable.surface, "data-at-rest"), like(assetsTable.location, `${repo}:%`)))
      .orderBy(assetsTable.location);

    return { project, assets };
  });

  if (found === null) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // Grouped back into stores, because a store is the unit a customer reasons
  // about: "is the backup archive safe" is one question, even though its bulk
  // cipher and its key wrapping are two assets with two different answers.
  type DataAtRestDetail = Extract<LocationDetail, { kind: "data-at-rest" }>;
  type DataAtRestAssetRow = (typeof found.assets)[number] & { locationDetail: DataAtRestDetail };
  interface StoreGroup {
    storeId: string;
    engine: string;
    storeKind: string;
    encryptionState: string;
    description: string | null;
    /** Both of a store's assets carry the same value by construction; first non-null wins, so a row written before the classification cannot blank out its sibling's. */
    assetClassification: DataClassification | null;
    assetSecrecyLifetimeYears: number | null;
    assets: DataAtRestAssetRow[];
  }

  const byStore = new Map<string, StoreGroup>();
  const groups: StoreGroup[] = [];

  for (const asset of found.assets) {
    const detail = asset.locationDetail;
    // Defensive, not expected: every row on this surface was written by
    // ingestDataAtRestObservations, which always sets this. Skipping rather
    // than throwing keeps one malformed historical row from taking the whole
    // inventory read down — the same call `GET /projects/:id/certificates` makes.
    if (detail?.kind !== "data-at-rest") {
      logger.warn({ assetId: asset.id }, "data-at-rest asset has no data-at-rest locationDetail — skipped");
      continue;
    }
    const store = detail.dataAtRest;
    // Grouped on the identity pair, not on `location` — which also carries the
    // role, and would put a store's two halves in two different groups.
    const key = JSON.stringify([store.engine, store.storeId]);
    let group = byStore.get(key);
    if (group === undefined) {
      group = {
        storeId: store.storeId,
        engine: store.engine,
        storeKind: store.storeKind,
        encryptionState: store.encryptionState,
        description: store.description ?? null,
        assetClassification: null,
        assetSecrecyLifetimeYears: null,
        assets: [],
      };
      byStore.set(key, group);
      groups.push(group);
    }
    group.assetClassification ??= asset.dataClassification;
    group.assetSecrecyLifetimeYears ??= asset.secrecyLifetimeYears;
    group.assets.push({ ...asset, locationDetail: detail });
  }

  res.json({
    projectId: id,
    generatedAt: now.toISOString(),
    stores: groups.map((group) => {
      // X is resolved once per store and shared by both of its components: the
      // two halves of a key hierarchy protect the same data, so giving them
      // different secrecy lifetimes would be incoherent.
      const lifetime = resolveSecrecyLifetime({
        assetClassification: group.assetClassification,
        assetSecrecyLifetimeYears: group.assetSecrecyLifetimeYears,
        projectClassification: found.project.dataClassification,
        projectSecrecyLifetimeYears: found.project.secrecyLifetimeYears,
      });

      return {
        storeId: group.storeId,
        engine: group.engine,
        storeKind: group.storeKind,
        encryptionState: group.encryptionState,
        description: group.description,
        dataClassification: group.assetClassification,
        secrecyLifetimeYears: group.assetSecrecyLifetimeYears,
        // `classificationSource`, not `source`. They differ for a store that
        // supplied `secrecyLifetimeYears` without a label ("Confidential, but
        // this contract has to last 10 years") — and `GET /api/inventory/assets`
        // already ships this field name meaning the *label's* provenance, so
        // using `source` here would give one enum two meanings across two
        // routes and one generated client type. The X's own provenance is not
        // lost: `xAssumed` is exactly `source !== "asset"`, and
        // `secrecyLifetimeBasis` states both in prose.
        classificationSource: lifetime.classificationSource,
        xAssumed: lifetime.assumed,
        secrecyLifetimeBasis: lifetime.basis,
        components: group.assets.map((asset) => {
          // Derived on read, never stored — the same discipline
          // `lib/compliance.ts` applies to findings, and the reason a 2026 row
          // cannot disagree with a 2028 read about either the standards data or
          // the Q-Day scenario years.
          const compliance = resolveCompliance(asset.algorithm, { asOf: now });
          const y = migrationYearsFromEffortHours(asset.effortHours ?? 0);
          const assessment = assessMoscaRisk({
            secrecyLifetimeYears: lifetime.years,
            migrationYears: y,
            hasQuantumVulnerableCrypto: compliance?.quantumVulnerable ?? false,
            now,
          });
          return {
            assetId: asset.id,
            role: asset.locationDetail.dataAtRest.role,
            algorithm: asset.algorithm,
            keySize: asset.keySize,
            reportedAlgorithm: asset.locationDetail.dataAtRest.reportedAlgorithm,
            keySource: asset.locationDetail.dataAtRest.keySource ?? null,
            status: asset.status,
            firstSeen: asset.firstSeen.toISOString(),
            lastSeen: asset.lastSeen.toISOString(),
            quantumVulnerable: compliance?.quantumVulnerable ?? null,
            mosca: {
              x: assessment.x,
              y: assessment.y,
              applicable: assessment.applicable,
              breachedScenarios: assessment.verdicts.filter((v) => v.breached).map((v) => v.scenario),
            },
          };
        }),
      };
    }),
    scenarios: DEFAULT_QDAY_SCENARIOS,
    framing: QDAY_FRAMING,
  });
});

/**
 * B11 — `POST /api/projects/:id/network-flows` and
 * `GET /api/projects/:id/network-flows`. docs/Claude/03-features.md §B11:
 * "Network conversations — both endpoints, and whatever protected them".
 *
 * Same shape as the six ingest routes above — org-scoped, parent confirmed
 * inside the scope, a run recorded only when something was actually examined —
 * with three differences that are the point of the lane.
 *
 * **It ingests records, it does not intercept traffic.** `docs/Claude/02-roadmap.md`
 * lists real-time network traffic interception as an explicit twelve-month
 * non-goal with "passive scanning only" as the posture. So the caller submits
 * flow and session records their own infrastructure already writes — a VPC flow
 * log, a load-balancer access log, a mesh telemetry export, a firewall session
 * log — and this product creates no new observation point.
 *
 * **It writes to two places, and that is deliberate.** Conversations go to
 * `network_flows` (both endpoints, always). Cryptography goes to `assets` on the
 * `network-flow` surface, only when a record actually named a cipher suite. A
 * conversation with undetermined cryptography has nothing to put in
 * `assets.algorithm`, which is `NOT NULL`, and a sentinel algorithm there would
 * be the fabricated value this whole surface exists to refuse — see
 * `lib/db/src/schema/network_flows.ts`'s header.
 *
 * **The GET joins them back together.** The customer's question is "for this
 * conversation, what protected it and who were the two ends" — one question, so
 * one response. Returning the conversations bare and leaving the crypto in
 * `/inventory/assets` would ship two halves of a feature.
 */

/** Mirrors `MAX_DATA_AT_REST_STORES_PER_SUBMISSION` — a bound on work, not on request size. A flow export is naturally larger than a store list, hence the higher ceiling. */
const MAX_NETWORK_FLOW_RECORDS_PER_SUBMISSION = 5000;

const NETWORK_FLOW_EVIDENCE_CAVEAT =
  "These conversations come from flow and session records the customer's own infrastructure produced. " +
  "This product captured no packets and initiated no connection, so every negotiated parameter here is as " +
  "the record stated it, not as we measured it. A conversation with cryptoState 'undetermined' means the " +
  "record named no cipher suite — it does NOT mean the conversation was unencrypted, and nothing here " +
  "infers cryptography from a port number. A TLS 1.3 suite name states only the AEAD and hash (RFC 8446 " +
  "§1.2), so its mandated key exchange is reported as not named rather than assumed.";

type NetworkFlowSubmissionRecord = zod.infer<typeof SubmitProjectNetworkFlowsBody>["records"][number];

/**
 * The generated body type's nullable fields are `T | null | undefined`; the
 * collector's inputs are the same shape, so this is a narrowing rather than a
 * transformation. The one real decision it encodes is that the **source port is
 * carried through and then dropped by the collector** rather than being
 * stripped here — so there is exactly one place in the codebase that decides an
 * ephemeral port is not part of a conversation's identity, and it is the place
 * with the comment explaining why.
 */
function toFlowRecordInput(record: NetworkFlowSubmissionRecord): NetworkFlowRecordInput {
  return {
    source: record.source,
    destination: record.destination,
    transport: record.transport,
    applicationProtocol: record.applicationProtocol,
    recordFormat: record.recordFormat,
    tlsVersion: record.tlsVersion,
    cipherSuite: record.cipherSuite,
    recordCount: record.recordCount,
    observedAt: record.observedAt,
  };
}

/** The POST's view of a conversation: what was collected, before asset ids exist to join on. */
function toCollectedConversation(conversation: NetworkFlowConversation) {
  return {
    flowKey: conversation.flowKey,
    transport: conversation.transport,
    sourceIdentity: conversation.sourceIdentity,
    sourceAddress: conversation.source.address ?? null,
    sourceHostname: conversation.source.hostname ?? null,
    sourceWorkload: conversation.source.workload ?? null,
    destinationIdentity: conversation.destinationIdentity,
    destinationAddress: conversation.destination.address ?? null,
    destinationHostname: conversation.destination.hostname ?? null,
    destinationWorkload: conversation.destination.workload ?? null,
    destinationPort: conversation.destinationPort,
    applicationProtocol: conversation.applicationProtocol,
    recordFormat: conversation.recordFormat,
    cryptoState: conversation.cryptoState,
    reportedCipherSuite: conversation.reportedCipherSuite,
    reportedTlsVersion: conversation.reportedTlsVersion,
    cryptoReportedAt: null,
    recordCount: conversation.recordCount,
    firstSeen: null,
    lastSeen: null,
    cryptography: conversation.observations.map((observation) => {
      const detail = observation.locationDetail;
      if (detail?.kind !== "network-flow") {
        // Cannot happen: every observation here came from
        // `collectNetworkFlowObservations`, which always sets this. Thrown
        // rather than defaulted — a defaulted `role` would label a key exchange
        // as an authentication, which is the one confusion that would make two
        // separately-remediated facts read as one.
        throw new Error(`network-flow observation at ${observation.location} carries no network-flow locationDetail`);
      }
      return {
        assetId: null,
        role: detail.networkFlow.role,
        algorithm: observation.algorithm,
        keySize: observation.keySize ?? null,
        location: observation.location,
        status: null,
        quantumVulnerable: null,
      };
    }),
    gaps: conversation.gaps.map((gap) => ({
      reason: gap.reason,
      component: gap.component ?? null,
      reported: gap.reported ?? null,
    })),
  };
}

router.post("/projects/:id/network-flows", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }
  const body = SubmitProjectNetworkFlowsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const id = params.data.id;
  const repo = projectRepoId(id);
  const submitted = body.data.records;

  if (submitted.length > MAX_NETWORK_FLOW_RECORDS_PER_SUBMISSION) {
    res.status(400).json({
      error: `Too many records in one submission (${submitted.length} > ${MAX_NETWORK_FLOW_RECORDS_PER_SUBMISSION}). Split the request rather than truncating it.`,
    });
    return;
  }

  const records = submitted.map(toFlowRecordInput);
  // Run the pure collector before the scope is opened, the same reason
  // `lockfilesIn`/`certificatesIn` are called there: it decides whether there is
  // anything to write at all, and it supplies the per-record rejections the
  // response reports even in the branch where nothing is written.
  const collected = collectNetworkFlowObservations(repo, records);

  const ctx = orgContextFor(req);
  const outcome = await withOrg(ctx, async (tx) => {
    // A foreign key is not subject to RLS — PostgreSQL checks referential
    // integrity with policies bypassed — so `network_flows.project_id` being a
    // real FK does not make this check optional. The parent must be confirmed
    // visible *inside* the scope before a child row is written.
    const [parent] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, id));
    if (!parent) return null;

    // Not one record could be read as a conversation: no endpoint pair, or
    // garbage. Writing a collection run here would make
    // `GET /projects/:id/coverage` report network-flow as "examined — nothing
    // found", a different and false statement. Note what this does NOT gate on:
    // a submission of a thousand cipher-free rows produces zero observations
    // and IS a real examination — a thousand conversations now on record — so
    // it records a run.
    if (collected.conversations.length === 0) return { kind: "nothing-readable" as const };

    return {
      kind: "ingested" as const,
      result: await ingestNetworkFlowObservations(tx, {
        repo,
        projectId: id,
        records,
        organizationId: ctx.organizationId,
      }),
    };
  });

  if (outcome === null) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (outcome.kind === "nothing-readable") {
    res.json({
      projectId: id,
      recordsSubmitted: submitted.length,
      conversationsRecorded: 0,
      flowsCreated: 0,
      flowsUpdated: 0,
      flowsWithUndeterminedCryptography: 0,
      collectionRunId: null,
      assetsCreated: 0,
      assetsUpdated: 0,
      observationsCreated: 0,
      assetsMarkedGone: 0,
      conversations: [],
      rejected: collected.rejected,
      evidenceCaveat: NETWORK_FLOW_EVIDENCE_CAVEAT,
    });
    return;
  }

  const { result } = outcome;
  logger.info(
    {
      projectId: id,
      recordsSubmitted: submitted.length,
      conversationsRecorded: result.conversations.length,
      undetermined: result.flowsWithUndeterminedCryptography,
      observations: result.observationsCreated,
      route: "POST /projects/:id/network-flows",
    },
    "network-flow collection complete",
  );

  res.json({
    projectId: id,
    recordsSubmitted: submitted.length,
    conversationsRecorded: result.conversations.length,
    flowsCreated: result.flowsCreated,
    flowsUpdated: result.flowsUpdated,
    flowsWithUndeterminedCryptography: result.flowsWithUndeterminedCryptography,
    collectionRunId: result.collectionRunId,
    assetsCreated: result.assetsCreated,
    assetsUpdated: result.assetsUpdated,
    observationsCreated: result.observationsCreated,
    assetsMarkedGone: result.assetsMarkedGone,
    conversations: result.conversations.map(toCollectedConversation),
    rejected: result.rejected,
    evidenceCaveat: NETWORK_FLOW_EVIDENCE_CAVEAT,
  });
});

router.get("/projects/:id/network-flows", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: parseInt(rawId, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }
  const id = params.data.id;
  const repo = projectRepoId(id);
  const now = new Date();

  const found = await withOrg(orgContextFor(req), async (tx) => {
    const [project] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, id));
    if (!project) return null;

    const flows = await tx
      .select()
      .from(networkFlowsTable)
      .where(eq(networkFlowsTable.projectId, id))
      .orderBy(networkFlowsTable.destinationIdentity, networkFlowsTable.destinationPort, networkFlowsTable.sourceIdentity);

    const assets = await tx
      .select({
        id: assetsTable.id,
        algorithm: assetsTable.algorithm,
        keySize: assetsTable.keySize,
        location: assetsTable.location,
        locationDetail: assetsTable.locationDetail,
        status: assetsTable.status,
      })
      .from(assetsTable)
      .where(and(eq(assetsTable.surface, "network-flow"), like(assetsTable.location, `${repo}:%`)))
      .orderBy(assetsTable.location);

    return { flows, assets };
  });

  if (found === null) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // Assets are keyed by the destination service endpoint, not by conversation
  // — that is the whole reason five hundred clients dialling one load balancer
  // do not produce five hundred copies of the same crypto. Joining them back on
  // here is what lets one response answer "what protected this conversation,
  // and who were its two ends" rather than half of it.
  const cryptoByEndpoint = new Map<string, Array<(typeof found.assets)[number]>>();
  for (const asset of found.assets) {
    const detail = asset.locationDetail;
    if (detail?.kind !== "network-flow") {
      // Defensive, not expected: every row on this surface was written by
      // `ingestNetworkFlowObservations`. Skipping rather than throwing keeps one
      // malformed historical row from taking the whole inventory read down — the
      // same call `GET /projects/:id/data-at-rest` makes.
      logger.warn({ assetId: asset.id }, "network-flow asset has no network-flow locationDetail — skipped");
      continue;
    }
    const key = JSON.stringify([
      detail.networkFlow.transport,
      detail.networkFlow.destinationIdentity,
      detail.networkFlow.destination.destinationPort ?? null,
    ]);
    const held = cryptoByEndpoint.get(key);
    if (held === undefined) cryptoByEndpoint.set(key, [asset]);
    else held.push(asset);
  }

  const conversations = found.flows.map((flow) => {
    const endpointKey = JSON.stringify([flow.transport, flow.destinationIdentity, flow.destinationPort]);
    const cryptography = (cryptoByEndpoint.get(endpointKey) ?? []).map((asset) => {
      const detail = asset.locationDetail as Extract<LocationDetail, { kind: "network-flow" }>;
      // Derived on read, never stored — the same discipline `lib/compliance.ts`
      // applies to findings, so a 2026 row cannot disagree with a 2028 read.
      const compliance = resolveCompliance(asset.algorithm, { asOf: now });
      return {
        assetId: asset.id,
        role: detail.networkFlow.role,
        algorithm: asset.algorithm,
        keySize: asset.keySize,
        location: asset.location,
        status: asset.status,
        quantumVulnerable: compliance?.quantumVulnerable ?? null,
      };
    });

    return {
      flowKey: flow.flowKey,
      transport: flow.transport,
      sourceIdentity: flow.sourceIdentity,
      sourceAddress: flow.sourceAddress,
      sourceHostname: flow.sourceHostname,
      sourceWorkload: flow.sourceWorkload,
      destinationIdentity: flow.destinationIdentity,
      destinationAddress: flow.destinationAddress,
      destinationHostname: flow.destinationHostname,
      destinationWorkload: flow.destinationWorkload,
      destinationPort: flow.destinationPort,
      applicationProtocol: flow.applicationProtocol,
      recordFormat: flow.recordFormat,
      cryptoState: flow.cryptoState,
      reportedCipherSuite: flow.reportedCipherSuite,
      reportedTlsVersion: flow.reportedTlsVersion,
      cryptoReportedAt: flow.cryptoReportedAt?.toISOString() ?? null,
      recordCount: flow.recordCount,
      firstSeen: flow.firstSeen.toISOString(),
      lastSeen: flow.lastSeen.toISOString(),
      cryptography,
      // The POST reports per-submission gaps; a stored conversation's gap is
      // simply its `cryptoState`, so this stays empty rather than being
      // reconstructed from a suite name that is no longer being parsed.
      gaps: [],
    };
  });

  res.json({
    projectId: id,
    generatedAt: now.toISOString(),
    conversationsRecorded: conversations.length,
    flowsWithUndeterminedCryptography: conversations.filter((c) => c.cryptoState === "undetermined").length,
    conversations,
    evidenceCaveat: NETWORK_FLOW_EVIDENCE_CAVEAT,
  });
});

/**
 * EP — `POST /api/projects/:id/endpoint` and `GET /api/projects/:id/endpoint`.
 * docs/Claude/03-features.md §EP: "Windows and Linux host fleet".
 *
 * Structurally the data-at-rest pair: org-scoped, parent confirmed inside the
 * scope (a foreign key is not subject to RLS, and `assets` has none to
 * `projects` at all — the association is the `project:<id>:` location prefix
 * this route writes), a run recorded only when something was genuinely
 * examined, and a second route for the persisted read because
 * `GET /inventory/assets` returns no `locationDetail`.
 *
 * **What this route is not: a host agent.** It is the contract one reports
 * against. Shipping a binary that runs on a customer's domain controller,
 * reads their machine certificate stores and their Schannel policy and then
 * authenticates outbound is a packaging and security-review problem several
 * times the size of a collector, and it cannot authenticate at all until
 * credential handling (F4) exists. Building the format and the ingest first
 * means the agent has a defined thing to send, and that the format is settled
 * before anything is deployed against it. B5 made the same call for key stores
 * and for the same reason.
 *
 * **The "examined nothing" gate is on identifiable hosts, not observations**,
 * which puts it with B6 rather than B2/B3/B4. A hardened Windows server whose
 * machine store is empty and whose suite list holds nothing this product
 * catalogues *was examined*, and a recorded run with zero observations is the
 * honest answer — refusing one would tell a CISO their server fleet had never
 * been looked at. Only a submission where every host was refused examined
 * nothing. `ingestEndpointObservations` enforces the same rule so it does not
 * depend on this route remembering it.
 */

/** Mirrors the spec's `maxItems`; both exist because a client generated from the spec should refuse before the server has to. */
const MAX_ENDPOINT_HOSTS_PER_SUBMISSION = 500;

const ENDPOINT_EVIDENCE_CAVEAT =
  "This reads a report a host agent submitted; no agent ships with this product yet and nothing here connects to a " +
  "host. An enabled cipher suite is a permitted algorithm, not a negotiated one — a Windows suite list is an upper " +
  "bound on what the host would accept, and most of it is never selected (see the TLS route for what was actually " +
  "agreed on the wire). A suite the host's policy disables is not reported at all, and every such suppression is " +
  "returned so it can be audited. Four deliberate silences: no protocol version and no loaded cryptographic provider " +
  "becomes an asset, because a protocol has no entry in the algorithm register and a provider is a capability rather " +
  "than a key; the OS build is carried so a reader knows what the defaults would have been and is never used to infer " +
  "one; a certificate is read as its store renders it rather than parsed, so it carries less weight than a submitted " +
  "PEM; and a cipher-suite or key-algorithm token with no canonical name — including every post-quantum one — " +
  "produces nothing rather than a guess.";

router.post("/projects/:id/endpoint", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }
  const body = SubmitProjectEndpointBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const id = params.data.id;
  const repo = projectRepoId(id);
  const hosts: EndpointHostReport[] = body.data.hosts;

  if (hosts.length > MAX_ENDPOINT_HOSTS_PER_SUBMISSION) {
    res.status(400).json({
      error: `Too many hosts in one submission (${hosts.length} > ${MAX_ENDPOINT_HOSTS_PER_SUBMISSION}). Split the request rather than truncating it.`,
    });
    return;
  }

  // Which hosts are ingestable at all. Computed before the scope is opened, the
  // same reason `lockfilesIn` and `protocolConfigsIn` are: it decides whether
  // there is anything to write, and `@workspace/collectors` is pure.
  const resolved = collectEndpointObservations(repo, hosts);
  const ingestable = resolved.filter((host) => host.skipped === undefined);

  const ctx = orgContextFor(req);
  const outcome = await withOrg(ctx, async (tx) => {
    const [parent] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, id));
    if (!parent) return null;

    // No identifiable host means we examined nothing. Note what this branch is
    // NOT: a host that was read and declares nothing reportable falls through
    // to the ingest, records a run and reports zero observations, because "we
    // read your domain controller and it configures nothing we can report" is a
    // true and useful answer. Collapsing the two would make the coverage meter
    // either overstate or understate what was looked at.
    if (ingestable.length === 0) return { kind: "no-hosts" as const };

    return {
      kind: "ingested" as const,
      result: await ingestEndpointObservations(tx, { repo, hosts, organizationId: ctx.organizationId }),
    };
  });

  if (outcome === null) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const hostResults = outcome.kind === "ingested" ? outcome.result.hosts : resolved;
  const response = {
    projectId: id,
    hostsSubmitted: hosts.length,
    hostsIngested: ingestable.length,
    collectionRunId: outcome.kind === "ingested" ? outcome.result.collectionRunId : null,
    assetsCreated: outcome.kind === "ingested" ? outcome.result.assetsCreated : 0,
    assetsUpdated: outcome.kind === "ingested" ? outcome.result.assetsUpdated : 0,
    observationsCreated: outcome.kind === "ingested" ? outcome.result.observationsCreated : 0,
    assetsMarkedGone: outcome.kind === "ingested" ? outcome.result.assetsMarkedGone : 0,
    hosts: hostResults.map(toEndpointHostResponse),
    evidenceCaveat: ENDPOINT_EVIDENCE_CAVEAT,
  };

  if (outcome.kind === "ingested") {
    logger.info(
      {
        projectId: id,
        hostsSubmitted: hosts.length,
        hostsIngested: ingestable.length,
        observations: outcome.result.observationsCreated,
        route: "POST /projects/:id/endpoint",
      },
      "endpoint host collection complete",
    );
  }

  res.json(response);
});

/**
 * One submitted host's outcome, including the refused ones.
 *
 * `suppressedSuites`, `undecodedSuites` and `unrecognisedDisabledAlgorithms`
 * are all on the response rather than kept in a log, and the third is the one
 * that matters most: it is the only input whose misreading risks a false
 * positive rather than an omission, so a caller has to be told this collector
 * could not act on it.
 */
function toEndpointHostResponse(host: EndpointHostResult) {
  return {
    machineId: host.machineId,
    hostname: host.hostname,
    skipped: host.skipped ?? null,
    observationsCreated: host.observations.length,
    certificatesRead: host.certificatesRead,
    cipherSuiteDeclarations: host.tlsPolicy?.declarations.length ?? 0,
    suppressedSuites: host.tlsPolicy?.suppressedSuites ?? [],
    undecodedSuites: host.tlsPolicy?.undecodedSuites ?? [],
    unrecognisedDisabledAlgorithms: host.tlsPolicy?.unrecognisedDisabledAlgorithms ?? [],
    enabledProtocols: host.tlsPolicy?.enabledProtocols ?? [],
    disabledProtocols: host.tlsPolicy?.disabledProtocols ?? [],
    undeterminedProtocols: host.tlsPolicy?.undeterminedProtocols ?? [],
  };
}

router.get("/projects/:id/endpoint", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: parseInt(rawId, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }
  const id = params.data.id;
  const repo = projectRepoId(id);

  const found = await withOrg(orgContextFor(req), async (tx) => {
    const [project] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, id));
    if (!project) return null;

    return tx
      .select({
        id: assetsTable.id,
        algorithm: assetsTable.algorithm,
        keySize: assetsTable.keySize,
        locationDetail: assetsTable.locationDetail,
        status: assetsTable.status,
        firstSeen: assetsTable.firstSeen,
        lastSeen: assetsTable.lastSeen,
      })
      .from(assetsTable)
      .where(and(eq(assetsTable.surface, "endpoint"), like(assetsTable.location, `${repo}:%`)))
      .orderBy(assetsTable.location, assetsTable.id);
  });

  if (found === null) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  type EndpointDetail = Extract<LocationDetail, { kind: "endpoint" }>;
  interface HostGroup {
    machineId: string;
    detail: EndpointDetail["endpoint"];
    lastSeen: Date;
    components: Array<(typeof found)[number] & { detail: EndpointDetail["endpoint"] }>;
  }

  // Grouped back into hosts, because a host is the unit an administrator acts
  // on: "what does DC-01 trust" is one question even though it is answered by a
  // store's certificates and a registry's suite list.
  const byMachine = new Map<string, HostGroup>();
  const groups: HostGroup[] = [];

  for (const asset of found) {
    const locationDetail = asset.locationDetail;
    // Defensive, not expected: every row on this surface was written by
    // `ingestEndpointObservations`, which always sets this. Skipping rather than
    // throwing keeps one malformed historical row from taking the whole fleet
    // read down — the same call `GET /projects/:id/data-at-rest` makes.
    if (locationDetail?.kind !== "endpoint") {
      logger.warn({ assetId: asset.id }, "endpoint asset has no endpoint locationDetail — skipped");
      continue;
    }
    const detail = locationDetail.endpoint;
    let group = byMachine.get(detail.machineId);
    if (group === undefined) {
      group = { machineId: detail.machineId, detail, lastSeen: asset.lastSeen, components: [] };
      byMachine.set(detail.machineId, group);
      groups.push(group);
    }
    // The host block on the most recently observed asset wins: a rename, an OS
    // patch or a provider being loaded are all real changes to the same
    // machine, and the newest report is the current state of it.
    if (asset.lastSeen > group.lastSeen) {
      group.lastSeen = asset.lastSeen;
      group.detail = detail;
    }
    group.components.push({ ...asset, detail });
  }

  res.json({
    projectId: id,
    generatedAt: new Date().toISOString(),
    hosts: groups.map((group) => ({
      machineId: group.machineId,
      machineIdSource: group.detail.machineIdSource ?? null,
      hostname: group.detail.hostname ?? null,
      os: group.detail.os ?? null,
      tlsPolicy: group.detail.tlsPolicy ?? null,
      providers: group.detail.providers ?? [],
      lastSeen: group.lastSeen.toISOString(),
      components: group.components.map((asset) => ({
        component: asset.detail.component,
        observedToken: asset.detail.observedToken,
        algorithm: asset.algorithm,
        keySize: asset.keySize,
        strength: asset.detail.strength,
        status: asset.status,
        firstSeen: asset.firstSeen.toISOString(),
        lastSeen: asset.lastSeen.toISOString(),
        certificate: asset.detail.certificate ?? null,
      })),
    })),
    evidenceCaveat: ENDPOINT_EVIDENCE_CAVEAT,
  });
});

export default router;
