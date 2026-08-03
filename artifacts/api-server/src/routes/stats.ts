import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { withOrg, projectsTable, scansTable, findingsTable, communityPostsTable, activityTable } from "@workspace/db";
import { orgContextFor } from "../lib/principal";

const router: IRouter = Router();

/**
 * `/api/stats` is authenticated and now organisation-scoped. That matters:
 * `recentActivity` carries descriptions like `Multi-file scan: 3 critical
 * vulnerabilities found across 12 files in "<projectName>"`, which is a
 * project-name leak the moment there is more than one tenant. The policies
 * scope it — no `where` clause here does.
 *
 * Splitting out a genuinely public `GET /api/stats/public` — aggregate
 * counters only, no names, no `recentActivity` — is what unbreaks the
 * marketing homepage's stats bar, which calls this protected route today. That
 * is sequenced with the interface work, not here: this phase changes no
 * response shape.
 */
router.get("/stats", async (req, res): Promise<void> => {
  const { projects, scans, findings, posts, activity } = await withOrg(orgContextFor(req), async (tx) => {
    const [projectRows, scanRows, findingRows, postRows, activityRows] = await Promise.all([
      tx.select().from(projectsTable),
      tx.select().from(scansTable),
      tx.select().from(findingsTable),
      tx.select().from(communityPostsTable),
      tx.select().from(activityTable).orderBy(desc(activityTable.timestamp)).limit(10),
    ]);
    return { projects: projectRows, scans: scanRows, findings: findingRows, posts: postRows, activity: activityRows };
  });

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
