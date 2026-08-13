import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { withOrg, scansTable, findingsTable, projectsTable, activityTable, projectRepoId } from "@workspace/db";
import type { ScopedTx } from "@workspace/db/org-scope";
import { CreateScanBody, GetScanParams, GetScanFindingsParams } from "@workspace/api-zod";
import { scanCode, computeScanResult, generateExecutiveSummary } from "../lib/scanner";
import { ingestSourceObservations } from "../lib/asset-ingest";
import { orgContextFor } from "../lib/principal";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * The asset/observation dual-write (docs/Claude/04-architecture.md §"Migration
 * path", step 3) is additive: a failure here must not take down the existing
 * scan-submission flow.
 *
 * That contract needs a SAVEPOINT now that everything runs inside one
 * transaction. A failed statement poisons its transaction in PostgreSQL —
 * catching the JavaScript error does not un-poison it, and every later
 * statement would fail with "current transaction is aborted". `tx.transaction`
 * opens a savepoint, so a failure rolls back only the dual-write.
 *
 * It is deliberately NOT a nested `withOrg`: this stays in the caller's
 * organisation scope, sets no GUC of its own, and so cannot re-scope its
 * parent. (Rolling back to a savepoint restores the GUC anyway — it is
 * releasing one that leaks.)
 */
async function dualWriteObservations(
  tx: ScopedTx,
  organizationId: number,
  params: { repo: string; files: Array<{ path: string; content: string; language: string }> },
  logContext: Record<string, unknown>,
): Promise<void> {
  try {
    await tx.transaction((sp) => ingestSourceObservations(sp as ScopedTx, { ...params, organizationId }));
  } catch (err) {
    logger.error({ err, ...logContext }, "asset/observation dual-write failed");
  }
}

router.post("/scans", async (req, res): Promise<void> => {
  const parsed = CreateScanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { projectId, mode, code, language } = parsed.data;
  const ctx = orgContextFor(req);

  const fileName = `code.${language === "python" ? "py" : language === "javascript" ? "js" : language === "typescript" ? "ts" : language === "go" ? "go" : language === "java" ? "java" : "txt"}`;
  const findings = scanCode(code, fileName, language);
  const totalLines = code.split("\n").length;
  const result = computeScanResult(findings, totalLines);
  const summary = generateExecutiveSummary(findings, totalLines, language);

  const scan = await withOrg(ctx, async (tx) => {
    // A foreign key is NOT subject to row-level security: PostgreSQL checks
    // referential integrity with RLS bypassed, so `scans.project_id` pointing
    // at another organisation's project is accepted by the database. The
    // policy still stamps the new row with the caller's organisation, so no
    // data leaks — but it would create a scan whose parent belongs to someone
    // else, which cascades from their delete. The parent has to be confirmed
    // visible *inside* the scope. Found by the cross-tenant suite, which
    // expected this to fail and it did not.
    const [parent] = await tx
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));
    if (!parent) return null;

    const [inserted] = await tx
      .insert(scansTable)
      .values({
        organizationId: ctx.organizationId,
        projectId,
        mode,
        status: "completed",
        riskScore: result.riskScore,
        totalLines,
        criticalCount: result.criticalCount,
        alertCount: result.alertCount,
        cleanCount: result.cleanCount,
        totalEffortHours: result.totalEffortHours,
        estimatedCost: result.estimatedCost,
        executiveSummary: summary,
        code,
        language,
        completedAt: new Date(),
      })
      .returning();

    // Save findings
    if (findings.length > 0) {
      await tx.insert(findingsTable).values(
        findings.map((f) => ({
          organizationId: ctx.organizationId,
          scanId: inserted.id,
          fileName: f.fileName,
          lineNumber: f.lineNumber,
          severity: f.severity,
          algorithm: f.algorithm,
          codeSnippet: f.codeSnippet,
          nistReplacement: f.nistReplacement,
          nistStandard: f.nistStandard,
          effortHours: f.effortHours,
          explanation: f.explanation,
        }))
      );
    }

    await dualWriteObservations(
      tx,
      ctx.organizationId,
      { repo: projectRepoId(projectId), files: [{ path: fileName, content: code, language }] },
      { projectId, scanId: inserted.id, route: "POST /scans" },
    );

    // Update project stats
    await tx
      .update(projectsTable)
      .set({
        riskScore: result.riskScore,
        lastScanAt: new Date(),
        criticalCount: result.criticalCount,
        alertCount: result.alertCount,
        cleanCount: result.cleanCount,
      })
      .where(eq(projectsTable.id, projectId));

    // Log activity
    if (result.criticalCount > 0) {
      await tx.insert(activityTable).values({
        organizationId: ctx.organizationId,
        description: `Scan found ${result.criticalCount} critical vulnerabilit${result.criticalCount === 1 ? "y" : "ies"} in ${language} code`,
        severity: "critical",
      });
    } else if (result.alertCount > 0) {
      await tx.insert(activityTable).values({
        organizationId: ctx.organizationId,
        description: `Scan found ${result.alertCount} weak-crypto alert${result.alertCount === 1 ? "" : "s"} in ${language} code`,
        severity: "alert",
      });
    } else {
      await tx.insert(activityTable).values({
        organizationId: ctx.organizationId,
        description: `Scan completed: ${totalLines} lines of ${language} code confirmed quantum-safe`,
        severity: "info",
      });
    }

    return inserted;
  });

  // Another organisation's project is indistinguishable from one that does not
  // exist. Previously an unknown project id surfaced as a 500 from the foreign
  // key; a 404 is both correct and consistent with the other handlers.
  if (!scan) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const scanWithFindings = {
    ...scan,
    findings: findings.map((f, i) => ({ id: i + 1, scanId: scan.id, ...f })),
  };

  res.status(201).json(scanWithFindings);
});

router.get("/scans/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetScanParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid scan ID" });
    return;
  }

  const found = await withOrg(orgContextFor(req), async (tx) => {
    const [scan] = await tx.select().from(scansTable).where(eq(scansTable.id, params.data.id));
    if (!scan) return null;
    const findings = await tx.select().from(findingsTable).where(eq(findingsTable.scanId, params.data.id));
    return { ...scan, findings };
  });

  if (!found) {
    res.status(404).json({ error: "Scan not found" });
    return;
  }

  res.json(found);
});

router.get("/scans/:id/findings", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetScanFindingsParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid scan ID" });
    return;
  }

  const findings = await withOrg(orgContextFor(req), (tx) =>
    tx.select().from(findingsTable).where(eq(findingsTable.scanId, params.data.id)),
  );
  res.json(findings);
});

// ── Multi-file scan: scan all files in one project ────────────────────────────
router.post("/scans/multi", async (req, res): Promise<void> => {
  const { projectName, language, files } = req.body as {
    projectName: string;
    language: string;
    files: { content: string; filename: string }[];
  };

  if (!projectName || !Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: "projectName and files[] required" });
    return;
  }

  const ctx = orgContextFor(req);

  // Per-file results returned to the client for inline IDE display
  const fileResults: {
    filename: string;
    riskScore: number;
    findings: {
      lineNumber: number; severity: string; algorithm: string;
      codeSnippet: string; nistReplacement: string | null; nistStandard: string | null;
      effortHours: number; explanation: string;
    }[];
  }[] = [];

  const summary = await withOrg(ctx, async (tx) => {
    const [project] = await tx
      .insert(projectsTable)
      .values({ organizationId: ctx.organizationId, name: projectName, language, riskScore: 0, lastScanAt: new Date(), totalScans: 1, criticalCount: 0, alertCount: 0, cleanCount: 0 })
      .returning();

    let totalCritical = 0, totalAlert = 0, totalSafe = 0, totalLines = 0, worstRisk = 0;
    const allFindingRows: {
      organizationId: number; scanId: number; fileName: string; lineNumber: number;
      severity: "critical" | "alert" | "safe"; algorithm: string;
      codeSnippet: string; nistReplacement: string | null; nistStandard: string | null;
      effortHours: number; explanation: string;
    }[] = [];

    for (const file of files) {
      const findings = scanCode(file.content, file.filename, language);
      const fileLines = file.content.split("\n").length;
      const result = computeScanResult(findings, fileLines);

      totalCritical += result.criticalCount;
      totalAlert    += result.alertCount;
      totalSafe     += result.cleanCount;
      totalLines    += fileLines;
      worstRisk      = Math.max(worstRisk, result.riskScore);

      const [scan] = await tx
        .insert(scansTable)
        .values({
          organizationId: ctx.organizationId,
          projectId: project.id, mode: "scan-only", status: "completed",
          riskScore: result.riskScore, totalLines: fileLines,
          criticalCount: result.criticalCount, alertCount: result.alertCount, cleanCount: result.cleanCount,
          totalEffortHours: result.totalEffortHours, estimatedCost: result.estimatedCost,
          code: file.content, language, completedAt: new Date(),
        })
        .returning();

      const fileFindingRows = findings.map(f => ({
        organizationId: ctx.organizationId,
        scanId: scan.id, fileName: f.fileName, lineNumber: f.lineNumber,
        severity: f.severity, algorithm: f.algorithm, codeSnippet: f.codeSnippet,
        nistReplacement: f.nistReplacement, nistStandard: f.nistStandard,
        effortHours: f.effortHours, explanation: f.explanation,
      }));
      allFindingRows.push(...fileFindingRows);

      fileResults.push({
        filename: file.filename,
        riskScore: result.riskScore,
        findings: findings.map(f => ({
          lineNumber: f.lineNumber, severity: f.severity, algorithm: f.algorithm,
          codeSnippet: f.codeSnippet, nistReplacement: f.nistReplacement,
          nistStandard: f.nistStandard, effortHours: f.effortHours, explanation: f.explanation,
        })),
      });
    }

    if (allFindingRows.length > 0) await tx.insert(findingsTable).values(allFindingRows);

    // One collection run for the whole multi-file submission, not one per file.
    await dualWriteObservations(
      tx,
      ctx.organizationId,
      { repo: projectRepoId(project.id), files: files.map((f) => ({ path: f.filename, content: f.content, language })) },
      { projectId: project.id, route: "POST /scans/multi" },
    );

    await tx.update(projectsTable)
      .set({ riskScore: worstRisk, criticalCount: totalCritical, alertCount: totalAlert, cleanCount: totalSafe, lastScanAt: new Date() })
      .where(eq(projectsTable.id, project.id));

    if (totalCritical > 0) {
      await tx.insert(activityTable).values({
        organizationId: ctx.organizationId,
        description: `Multi-file scan: ${totalCritical} critical vulnerabilities found across ${files.length} files in "${projectName}"`,
        severity: "critical",
      });
    } else {
      await tx.insert(activityTable).values({
        organizationId: ctx.organizationId,
        description: `Multi-file scan complete: ${totalLines} lines of ${language} code scanned, ${totalAlert} alerts`,
        severity: totalAlert > 0 ? "alert" : "info",
      });
    }

    return {
      projectId: project.id, projectName: project.name,
      riskScore: worstRisk, criticalCount: totalCritical,
      alertCount: totalAlert, cleanCount: totalSafe,
      totalLines, findingsCount: allFindingRows.length, filesScanned: files.length,
    };
  });

  logger.info(
    { projectId: summary.projectId, files: files.length, totalCritical: summary.criticalCount, totalAlert: summary.alertCount },
    "multi-scan complete",
  );

  res.status(201).json({ ...summary, fileResults });
});

export default router;
