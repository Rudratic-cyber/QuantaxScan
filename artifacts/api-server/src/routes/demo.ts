import { Router, type IRouter } from "express";
import { scanCode, computeScanResult, generateExecutiveSummary } from "../lib/scanner";
import { db, activityTable } from "@workspace/db";
import { DEMO_REPOS } from "../lib/demo-repos";

const router: IRouter = Router();


router.get("/demo/repos", async (_req, res): Promise<void> => {
  res.json(
    DEMO_REPOS.map(({ slug, name, description, language, stars, repoUrl, files }) => {
      const allFindings = files.flatMap((f) => {
        const lang = language.toLowerCase();
        return scanCode(f.content, f.path, lang);
      });
      const totalLines = files.reduce((acc, f) => acc + f.content.split("\n").length, 0);
      const result = computeScanResult(allFindings, totalLines);
      return {
        slug,
        name,
        description,
        language,
        stars,
        repoUrl,
        fileCount: files.length,
        riskScore: result.riskScore,
        criticalCount: result.criticalCount,
        alertCount: result.alertCount,
      };
    })
  );
});

router.post("/demo/repos/:slug/scan", async (req, res): Promise<void> => {
  const rawSlug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
  const repo = DEMO_REPOS.find((r) => r.slug === rawSlug);

  if (!repo) {
    res.status(404).json({ error: "Demo repo not found" });
    return;
  }

  const lang = repo.language.toLowerCase();

  const fileResults = repo.files.map((f) => {
    const findings = scanCode(f.content, f.path, lang);
    const lines = f.content.split("\n").length;
    return {
      path: f.path,
      language: lang,
      content: f.content,
      lines,
      findings: findings.map((x, i) => ({ id: i + 1, scanId: -1, ...x })),
      criticalCount: findings.filter((x) => x.severity === "critical").length,
      alertCount: findings.filter((x) => x.severity === "alert").length,
    };
  });

  const allFindings = fileResults.flatMap((f) => f.findings);
  const totalLines = fileResults.reduce((acc, f) => acc + f.lines, 0);
  const result = computeScanResult(allFindings, totalLines);
  const summary = generateExecutiveSummary(allFindings, totalLines, repo.language);

  await db.insert(activityTable).values({
    description: `Demo scan run on ${repo.name} — found ${result.criticalCount} critical vulnerabilities`,
    severity: result.criticalCount > 0 ? "critical" : result.alertCount > 0 ? "alert" : "info",
  });

  res.json({
    id: -1,
    projectId: -1,
    mode: "scan-only",
    status: "completed",
    name: repo.name,
    repoUrl: repo.repoUrl,
    language: repo.language,
    riskScore: result.riskScore,
    totalLines,
    criticalCount: result.criticalCount,
    alertCount: result.alertCount,
    cleanCount: result.cleanCount,
    totalEffortHours: result.totalEffortHours,
    estimatedCost: result.estimatedCost,
    executiveSummary: summary,
    files: fileResults,
    findings: allFindings,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  });
});

export default router;
