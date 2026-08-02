/**
 * Pre-migration cleanup: delete orphaned `findings`/`scans` rows so that
 * adding `findings.scan_id -> scans.id` and `scans.project_id -> projects.id`
 * foreign keys (docs/Claude/04-architecture.md §"Also: add foreign keys")
 * does not fail against existing data.
 *
 * Run this BEFORE applying the schema migration that adds those
 * constraints — `pnpm --filter @workspace/db run push` (see
 * lib/db/drizzle/ for the reviewable generated SQL). The project's
 * existing data is a smoke test (docs/Claude/04-architecture.md
 * §"Migration path": "Do this now, while that is true"), so this is
 * expected to delete few or zero rows in practice; it is not safe to skip,
 * because the `ADD CONSTRAINT` statement fails outright if it would.
 *
 * Usage: `pnpm --filter @workspace/scripts run cleanup-orphans`
 * Requires `DATABASE_URL` to point at the target database.
 */
import { db, projectsTable, scansTable, findingsTable } from "@workspace/db";
import { inArray, notInArray } from "drizzle-orm";

async function main() {
  const projects = await db.select({ id: projectsTable.id }).from(projectsTable);
  const projectIds = projects.map((p) => p.id);

  const orphanedScans = projectIds.length
    ? await db.select({ id: scansTable.id }).from(scansTable).where(notInArray(scansTable.projectId, projectIds))
    : await db.select({ id: scansTable.id }).from(scansTable);
  const orphanedScanIds = orphanedScans.map((s) => s.id);

  if (orphanedScanIds.length) {
    const deletedFindings = await db
      .delete(findingsTable)
      .where(inArray(findingsTable.scanId, orphanedScanIds))
      .returning({ id: findingsTable.id });
    console.log(`Deleted ${deletedFindings.length} finding(s) belonging to orphaned scans`);

    const deletedScans = await db
      .delete(scansTable)
      .where(inArray(scansTable.id, orphanedScanIds))
      .returning({ id: scansTable.id });
    console.log(`Deleted ${deletedScans.length} orphaned scan(s) (project_id referenced no existing project)`);
  } else {
    console.log("No orphaned scans found.");
  }

  // Re-check after the pass above: a finding can be orphaned on its own
  // (scan_id referencing no scan at all) independent of project orphaning.
  const scans = await db.select({ id: scansTable.id }).from(scansTable);
  const scanIds = scans.map((s) => s.id);
  const remainingOrphanFindings = scanIds.length
    ? await db.delete(findingsTable).where(notInArray(findingsTable.scanId, scanIds)).returning({ id: findingsTable.id })
    : await db.delete(findingsTable).returning({ id: findingsTable.id });
  console.log(`Deleted ${remainingOrphanFindings.length} finding(s) whose scan_id referenced no existing scan`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
