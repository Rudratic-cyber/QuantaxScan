import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { db, projectsTable, scansTable, findingsTable, communityPostsTable, activityTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/stats", async (_req, res): Promise<void> => {
  const [projects, scans, findings, posts, activity] = await Promise.all([
    db.select().from(projectsTable),
    db.select().from(scansTable),
    db.select().from(findingsTable),
    db.select().from(communityPostsTable),
    db.select().from(activityTable).orderBy(desc(activityTable.timestamp)).limit(10),
  ]);

  const totalLinesScanned = scans.reduce((sum, s) => sum + s.totalLines, 0);
  const totalVulnerabilitiesFound = findings.filter((f) => f.severity === "critical" || f.severity === "alert").length;

  const algoCounts: Record<string, number> = {};
  for (const f of findings) {
    algoCounts[f.algorithm] = (algoCounts[f.algorithm] || 0) + 1;
  }
  const mostCommonAlgorithm = Object.entries(algoCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "RSA";

  res.json({
    totalReposScanned: projects.length + scans.length,
    totalVulnerabilitiesFound,
    totalLinesScanned,
    totalCommunityPosts: posts.length,
    totalMigrationsAssisted: Math.floor(scans.filter((s) => s.criticalCount > 0).length * 0.3),
    mostCommonAlgorithm,
    recentActivity: activity.map((a) => ({
      id: a.id,
      description: a.description,
      timestamp: a.timestamp,
      severity: a.severity,
    })),
  });
});

export default router;
