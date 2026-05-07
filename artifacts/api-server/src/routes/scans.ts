import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, scansTable, findingsTable, projectsTable, activityTable } from "@workspace/db";
import { CreateScanBody, GetScanParams, GetScanFindingsParams } from "@workspace/api-zod";
import { scanCode, computeScanResult, generateExecutiveSummary } from "../lib/scanner";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.post("/scans", async (req, res): Promise<void> => {
  const parsed = CreateScanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { projectId, mode, code, language } = parsed.data;

  const fileName = `code.${language === "python" ? "py" : language === "javascript" ? "js" : language === "typescript" ? "ts" : language === "go" ? "go" : language === "java" ? "java" : "txt"}`;
  const findings = scanCode(code, fileName, language);
  const totalLines = code.split("\n").length;
  const result = computeScanResult(findings, totalLines);
  const summary = generateExecutiveSummary(findings, totalLines, language);

  const [scan] = await db
    .insert(scansTable)
    .values({
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
    await db.insert(findingsTable).values(
      findings.map((f) => ({
        scanId: scan.id,
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

  // Update project stats
  await db
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
    await db.insert(activityTable).values({
      description: `Scan found ${result.criticalCount} critical vulnerabilit${result.criticalCount === 1 ? "y" : "ies"} in ${language} code`,
      severity: "critical",
    });
  } else if (result.alertCount > 0) {
    await db.insert(activityTable).values({
      description: `Scan found ${result.alertCount} weak-crypto alert${result.alertCount === 1 ? "" : "s"} in ${language} code`,
      severity: "alert",
    });
  } else {
    await db.insert(activityTable).values({
      description: `Scan completed: ${totalLines} lines of ${language} code confirmed quantum-safe`,
      severity: "info",
    });
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

  const [scan] = await db.select().from(scansTable).where(eq(scansTable.id, params.data.id));

  if (!scan) {
    res.status(404).json({ error: "Scan not found" });
    return;
  }

  const findings = await db.select().from(findingsTable).where(eq(findingsTable.scanId, params.data.id));

  res.json({ ...scan, findings });
});

router.get("/scans/:id/findings", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetScanFindingsParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid scan ID" });
    return;
  }

  const findings = await db.select().from(findingsTable).where(eq(findingsTable.scanId, params.data.id));
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

  const [project] = await db
    .insert(projectsTable)
    .values({ name: projectName, language, riskScore: 0, lastScanAt: new Date(), totalScans: 1, criticalCount: 0, alertCount: 0, cleanCount: 0 })
    .returning();

  let totalCritical = 0, totalAlert = 0, totalSafe = 0, totalLines = 0, worstRisk = 0;
  const allFindingRows: {
    scanId: number; fileName: string; lineNumber: number;
    severity: "critical" | "alert" | "safe"; algorithm: string;
    codeSnippet: string; nistReplacement: string | null; nistStandard: string | null;
    effortHours: number; explanation: string;
  }[] = [];

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

  for (const file of files) {
    const findings = scanCode(file.content, file.filename, language);
    const fileLines = file.content.split("\n").length;
    const result = computeScanResult(findings, fileLines);

    totalCritical += result.criticalCount;
    totalAlert    += result.alertCount;
    totalSafe     += result.cleanCount;
    totalLines    += fileLines;
    worstRisk      = Math.max(worstRisk, result.riskScore);

    const [scan] = await db
      .insert(scansTable)
      .values({
        projectId: project.id, mode: "scan-only", status: "completed",
        riskScore: result.riskScore, totalLines: fileLines,
        criticalCount: result.criticalCount, alertCount: result.alertCount, cleanCount: result.cleanCount,
        totalEffortHours: result.totalEffortHours, estimatedCost: result.estimatedCost,
        code: file.content, language, completedAt: new Date(),
      })
      .returning();

    const fileFindingRows = findings.map(f => ({
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

  if (allFindingRows.length > 0) await db.insert(findingsTable).values(allFindingRows);

  await db.update(projectsTable)
    .set({ riskScore: worstRisk, criticalCount: totalCritical, alertCount: totalAlert, cleanCount: totalSafe, lastScanAt: new Date() })
    .where(eq(projectsTable.id, project.id));

  if (totalCritical > 0) {
    await db.insert(activityTable).values({
      description: `Multi-file scan: ${totalCritical} critical vulnerabilities found across ${files.length} files in "${projectName}"`,
      severity: "critical",
    });
  } else {
    await db.insert(activityTable).values({
      description: `Multi-file scan complete: ${totalLines} lines of ${language} code scanned, ${totalAlert} alerts`,
      severity: totalAlert > 0 ? "alert" : "info",
    });
  }

  logger.info({ projectId: project.id, files: files.length, totalCritical, totalAlert }, "multi-scan complete");

  res.status(201).json({
    projectId: project.id, projectName: project.name,
    riskScore: worstRisk, criticalCount: totalCritical,
    alertCount: totalAlert, cleanCount: totalSafe,
    totalLines, findingsCount: allFindingRows.length, filesScanned: files.length,
    fileResults,
  });
});

export default router;
