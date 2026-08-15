import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  withOrg,
  scansTable,
  findingsTable,
  projectsTable,
  activityTable,
  projectRepoId,
  EPHEMERAL_SNIPPET_MARKER,
  type RetentionMode,
} from "@workspace/db";
import type { ScopedTx } from "@workspace/db/org-scope";
import { CreateScanBody, GetScanParams, GetScanFindingsParams } from "@workspace/api-zod";
import { computeRiskProfile } from "@workspace/risk";
import { scanCode, computeScanResult, generateExecutiveSummary } from "../lib/scanner";
import { withComplianceAll } from "../lib/compliance";
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
  params: {
    repo: string;
    files: Array<{ path: string; content: string; language: string }>;
    retentionMode: RetentionMode;
  },
  logContext: Record<string, unknown>,
): Promise<void> {
  try {
    await tx.transaction((sp) => ingestSourceObservations(sp as ScopedTx, { ...params, organizationId }));
  } catch (err) {
    // F4: `err` here can carry the failing statement's parameters, and under
    // `retained` those include the matched source line. The dual-write is
    // additive and its failures are diagnosed from the route and ids, so log
    // the class rather than the object.
    logger.error(
      { errName: err instanceof Error ? err.name : typeof err, ...logContext },
      "asset/observation dual-write failed",
    );
  }
}

/**
 * F4 — what actually gets persisted for a finding, given the retention mode.
 *
 * The whole of the ephemeral guarantee for `findings` is this one function, and
 * it is deliberately a single choke point: both scan routes build their finding
 * rows through it, so adding a third writer that forgets the mode is a
 * type-level omission rather than a silent leak. `findings.code_snippet` is
 * `NOT NULL`, so an ephemeral finding carries a fixed self-describing marker —
 * see `EPHEMERAL_SNIPPET_MARKER` for why that is preferred to an empty string
 * or to dropping the constraint.
 */
function persistedSnippet(snippet: string, retentionMode: RetentionMode): string {
  return retentionMode === "ephemeral" ? EPHEMERAL_SNIPPET_MARKER : snippet;
}

router.post("/scans", async (req, res): Promise<void> => {
  const parsed = CreateScanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { projectId, mode, code, language } = parsed.data;
  // F4: absent means `retained` — what every submission did before this
  // existed. The default is explicit here rather than left to the column
  // default, because the column default describes rows written before the
  // feature and this describes a caller who did not ask for ephemeral.
  const retentionMode: RetentionMode = parsed.data.retentionMode ?? "retained";
  const ctx = orgContextFor(req);

  const fileName = `code.${language === "python" ? "py" : language === "javascript" ? "js" : language === "typescript" ? "ts" : language === "go" ? "go" : language === "java" ? "java" : "txt"}`;
  const findings = scanCode(code, fileName, language);
  const totalLines = code.split("\n").length;
  // TODO(A3): `secrecyLifetimeYears` (X) is not passed because data
  // classification does not exist yet — the risk engine falls back to its
  // documented default and flags the verdict as an assumption. When A3 lands,
  // read the project's classification here and pass it through.
  const result = computeScanResult(findings, totalLines);
  const summary = generateExecutiveSummary(findings, totalLines, language, result.mosca);

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
        // The single most important line in F4's other half: under `ephemeral`
        // the submitted body is never written. It was scanned in memory above
        // and is discarded when this handler returns.
        code: retentionMode === "ephemeral" ? null : code,
        retentionMode,
        sourceDiscardedAt: retentionMode === "ephemeral" ? new Date() : null,
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
          codeSnippet: persistedSnippet(f.codeSnippet, retentionMode),
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
      { repo: projectRepoId(projectId), files: [{ path: fileName, content: code, language }], retentionMode },
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

  // `pqc`, `hygiene` and `mosca` are derived, not stored. They are additive
  // to the persisted scan row, which keeps A4 out of the schema entirely —
  // and because they are recomputed from the findings on every read, a
  // mappings-data or scenario change is reflected without a backfill, the
  // same read-time-derivation principle as `algorithm-mapping.ts`.
  const scanWithFindings = {
    ...scan,
    findings: findings.map((f, i) => ({ id: i + 1, scanId: scan.id, ...f })),
    pqc: result.pqc,
    hygiene: result.hygiene,
    mosca: result.mosca,
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
    // Obligations are resolved on the way out, never read back off the row — a
    // mappings-data update therefore reaches findings written before it. See
    // lib/compliance.ts and docs/Claude/05-compliance-mapping.md.
    return { ...scan, findings: withComplianceAll(findings) };
  });

  if (!found) {
    res.status(404).json({ error: "Scan not found" });
    return;
  }

  // Recomputed from the persisted findings rather than read back from a
  // column: the risk profile is a derivation over the mappings data and the
  // Q-Day scenarios, both of which change independently of a historical scan.
  // Storing the verdict would freeze a number that is supposed to move.
  const profile = computeRiskProfile(found.findings, { totalLines: found.totalLines ?? 0 });

  // `riskScore` is overridden with the recomputed value rather than served
  // from the column. Returning both would put two different numbers under
  // two keys in one payload: the stored one is frozen at write time and Z
  // shrinks every day, so they diverge. The column is kept as the historical
  // record and for list views that do not recompute.
  res.json({
    ...found,
    riskScore: profile.pqc.riskScore,
    pqc: profile.pqc,
    hygiene: profile.hygiene,
    mosca: profile.mosca,
  });
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
  res.json(withComplianceAll(findings));
});

// ── Multi-file scan: scan all files in one project ────────────────────────────
router.post("/scans/multi", async (req, res): Promise<void> => {
  const { projectName, language, files, retentionMode: requestedRetention } = req.body as {
    projectName: string;
    language: string;
    files: { content: string; filename: string }[];
    retentionMode?: string;
  };

  if (!projectName || !Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: "projectName and files[] required" });
    return;
  }

  // This handler reads `req.body` directly rather than through a generated zod
  // schema (it predates them), so the retention mode is validated here by hand.
  // Anything other than the one opt-in value is `retained` — an unrecognised
  // string must never be read as "do not retain", because that would let a typo
  // silently promise a customer something the code then does not do.
  if (requestedRetention !== undefined && requestedRetention !== "retained" && requestedRetention !== "ephemeral") {
    res.status(400).json({ error: "retentionMode must be 'retained' or 'ephemeral'" });
    return;
  }
  const retentionMode: RetentionMode = requestedRetention === "ephemeral" ? "ephemeral" : "retained";

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
    const allFindings: { algorithm: string; effortHours: number }[] = [];
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
      allFindings.push(...findings);

      const [scan] = await tx
        .insert(scansTable)
        .values({
          organizationId: ctx.organizationId,
          projectId: project.id, mode: "scan-only", status: "completed",
          riskScore: result.riskScore, totalLines: fileLines,
          criticalCount: result.criticalCount, alertCount: result.alertCount, cleanCount: result.cleanCount,
          totalEffortHours: result.totalEffortHours, estimatedCost: result.estimatedCost,
          code: retentionMode === "ephemeral" ? null : file.content,
          retentionMode,
          sourceDiscardedAt: retentionMode === "ephemeral" ? new Date() : null,
          language, completedAt: new Date(),
        })
        .returning();

      const fileFindingRows = findings.map(f => ({
        organizationId: ctx.organizationId,
        scanId: scan.id, fileName: f.fileName, lineNumber: f.lineNumber,
        severity: f.severity, algorithm: f.algorithm,
        codeSnippet: persistedSnippet(f.codeSnippet, retentionMode),
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
          compliance: f.compliance,
        })),
      });
    }

    if (allFindingRows.length > 0) await tx.insert(findingsTable).values(allFindingRows);

    // A4: the project-level risk profile is computed over every finding in
    // the submission, not taken as the worst per-file score. `worstRisk` is
    // still reported per file (and remains the value stored on each scan
    // row), but a Mosca verdict is a statement about a body of data and its
    // total migration effort — the maximum of per-file scores cannot express
    // one. TODO(A3): pass the project's classification as X once it exists.
    const projectProfile = computeRiskProfile(allFindings, { totalLines });

    // One collection run for the whole multi-file submission, not one per file.
    await dualWriteObservations(
      tx,
      ctx.organizationId,
      {
        repo: projectRepoId(project.id),
        files: files.map((f) => ({ path: f.filename, content: f.content, language })),
        retentionMode,
      },
      { projectId: project.id, route: "POST /scans/multi" },
    );

    await tx.update(projectsTable)
      .set({ riskScore: projectProfile.pqc.riskScore, criticalCount: totalCritical, alertCount: totalAlert, cleanCount: totalSafe, lastScanAt: new Date() })
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
      riskScore: projectProfile.pqc.riskScore, worstFileRiskScore: worstRisk,
      criticalCount: totalCritical,
      alertCount: totalAlert, cleanCount: totalSafe,
      totalLines, findingsCount: allFindingRows.length, filesScanned: files.length,
      // Echoed back so the caller can state which regime their upload went
      // through without a second read — the answer to "what did you do with my
      // source" should be in the response that acknowledged it.
      retentionMode,
      pqc: projectProfile.pqc, hygiene: projectProfile.hygiene, mosca: projectProfile.mosca,
    };
  });

  logger.info(
    { projectId: summary.projectId, files: files.length, totalCritical: summary.criticalCount, totalAlert: summary.alertCount },
    "multi-scan complete",
  );

  res.status(201).json({ ...summary, fileResults });
});

export default router;
