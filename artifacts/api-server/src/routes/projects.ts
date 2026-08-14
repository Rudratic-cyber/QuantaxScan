import { Router, type IRouter } from "express";
import { eq, inArray, like } from "drizzle-orm";
import {
  withOrg,
  projectsTable,
  scansTable,
  findingsTable,
  assetsTable,
  observationsTable,
  collectionRunsTable,
  projectRepoId,
} from "@workspace/db";
import {
  CreateProjectBody,
  GetProjectParams,
  DeleteProjectParams,
  SubmitProjectDependenciesBody,
} from "@workspace/api-zod";
import { lockfilesIn } from "@workspace/collectors";
import { scanCode, computeScanResult } from "../lib/scanner";
import { summariseProjectCoverage } from "../lib/coverage";
import { withComplianceAll } from "../lib/compliance";
import { ingestDependencyObservations } from "../lib/asset-ingest";
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
        .select({ id: assetsTable.id, surface: assetsTable.surface, status: assetsTable.status })
        .from(assetsTable)
        .where(like(assetsTable.location, `${repo}:%`)),
    ]);

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

    return summariseProjectCoverage({ runs, assets, observations });
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

export default router;
