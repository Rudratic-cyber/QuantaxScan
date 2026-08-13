import { Router, type IRouter } from "express";
import { eq, inArray, like } from "drizzle-orm";
import { withOrg, projectsTable, scansTable, findingsTable, assetsTable, projectRepoId } from "@workspace/db";
import {
  CreateProjectBody,
  GetProjectParams,
  DeleteProjectParams,
} from "@workspace/api-zod";
import { scanCode, computeScanResult } from "../lib/scanner";
import { orgContextFor } from "../lib/principal";

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

  res.json(findings);
});

export default router;
