/**
 * One-time, best-effort backfill: populate `assets`/`observations`/
 * `collection_runs` from the existing `scans`/`findings` data.
 * docs/Claude/04-architecture.md §"Migration path", step 2.
 *
 * Run this AFTER `cleanup-orphans.ts` and the schema migration (new tables
 * + FKs) have been applied, and BEFORE relying on dual-write alone to
 * populate history — otherwise every asset present before this change
 * ships would appear to have `firstSeen` at the moment dual-write happened,
 * not when it was actually first found.
 *
 * Best-effort, honestly: the pre-refactor scanner never extracted key size
 * (G-05), so every backfilled asset gets `keySize: null` — this script does
 * not invent one. There is no real "repository" concept in the existing
 * `scans`/`findings` data (only a project ID and a file name), so the
 * fingerprint's `repo` component is synthesised as `project:<id>`; a
 * genuine multi-repo project backfilled this way will not distinguish
 * files that happen to share a path across repos. `organizationId` is
 * hardcoded to 1 — there is no `organizations` table yet (F2 multi-tenancy
 * is out of scope for this change; see docs/Claude/04-architecture.md
 * §"assets — stable identity").
 *
 * Not idempotent by design: re-running against data it has already
 * backfilled would create duplicate observations. It refuses to run if any
 * `collection_runs` rows already exist, since a from-scratch backfill only
 * makes sense once, against data that predates this migration entirely.
 *
 * Usage: `pnpm --filter @workspace/scripts run backfill-assets`
 * Requires `DATABASE_URL` to point at the target database.
 */
import { db, scansTable, findingsTable, assetsTable, observationsTable, collectionRunsTable, projectRepoId } from "@workspace/db";
import { computeFingerprint } from "@workspace/collectors";
import { and, asc, eq } from "drizzle-orm";

const DEFAULT_ORGANIZATION_ID = 1;

async function main() {
  const [existingRun] = await db.select({ id: collectionRunsTable.id }).from(collectionRunsTable).limit(1);
  if (existingRun) {
    console.error(
      "collection_runs already has rows — refusing to run. This backfill is meant to run exactly once, against data that predates the asset/observation model.",
    );
    process.exit(1);
  }

  // Oldest scan first. Without this the rows come back in whatever order the
  // heap hands them over, and `firstSeen`/`lastSeen` — the entire reason this
  // script exists rather than letting dual-write populate history — would be
  // taken from an arbitrary scan rather than the first/last one.
  const scans = await db.select().from(scansTable).orderBy(asc(scansTable.createdAt), asc(scansTable.id));
  let assetsCreated = 0;
  let assetsReObserved = 0;
  let observationsCreated = 0;
  let collectionRunsCreated = 0;

  for (const scan of scans) {
    const findings = await db.select().from(findingsTable).where(eq(findingsTable.scanId, scan.id));
    const observedAt = scan.completedAt ?? scan.createdAt;
    const repo = projectRepoId(scan.projectId);

    const [run] = await db
      .insert(collectionRunsTable)
      .values({
        organizationId: DEFAULT_ORGANIZATION_ID,
        collector: "source-regex",
        collectorVersion: "1.0.0",
        surface: "source",
        status: "completed",
        target: repo,
        observationCount: findings.length,
        startedAt: scan.createdAt,
        completedAt: observedAt,
      })
      .returning();
    collectionRunsCreated++;

    for (const finding of findings) {
      const fingerprint = computeFingerprint({
        surface: "source",
        repo,
        path: finding.fileName,
        algorithm: finding.algorithm,
        // Best-effort: the pre-refactor scanner recorded only the matched
        // algorithm, not a distinct symbol — this is the closest available
        // stand-in for the fingerprint's "normalised-symbol" input.
        symbol: finding.algorithm,
      });

      const [existingAsset] = await db
        .select()
        .from(assetsTable)
        .where(and(eq(assetsTable.organizationId, DEFAULT_ORGANIZATION_ID), eq(assetsTable.fingerprint, fingerprint)));

      let assetId: number;
      if (existingAsset) {
        // lastSeen only ever advances and firstSeen only ever retreats. Scans
        // are processed oldest-first by createdAt, but a scan's completedAt
        // can still predate an earlier-created scan's, so the window is
        // widened explicitly rather than relying on the ordering alone.
        const widened: { lastSeen?: Date; firstSeen?: Date } = {};
        if (observedAt > existingAsset.lastSeen) widened.lastSeen = observedAt;
        if (observedAt < existingAsset.firstSeen) widened.firstSeen = observedAt;
        if (widened.lastSeen || widened.firstSeen) {
          await db.update(assetsTable).set(widened).where(eq(assetsTable.id, existingAsset.id));
        }
        assetId = existingAsset.id;
        assetsReObserved++;
      } else {
        const [created] = await db
          .insert(assetsTable)
          .values({
            organizationId: DEFAULT_ORGANIZATION_ID,
            fingerprint,
            surface: "source",
            algorithm: finding.algorithm,
            keySize: null, // G-05: never determined by the pre-refactor scanner — not invented here
            location: `${repo}:${finding.fileName}`,
            locationDetail: { kind: "source", source: { repo, path: finding.fileName, symbol: finding.algorithm } },
            status: "active",
            firstSeen: observedAt,
            lastSeen: observedAt,
            // effortHours deliberately left unset: like nistReplacement/severity,
            // it is mapping-derived data (algorithms.json's baseEffortHours) —
            // freezing the legacy finding's copy here would repeat the exact
            // staleness problem this migration exists to fix. Consistent with
            // artifacts/api-server/src/lib/asset-ingest.ts's dual-write path,
            // which also never sets it.
          })
          .returning();
        assetId = created.id;
        assetsCreated++;
      }

      await db.insert(observationsTable).values({
        assetId,
        collectionRunId: run.id,
        collector: "source-regex",
        collectorVersion: "1.0.0",
        confidence: 0.7, // regex — see docs/Claude/09-open-gaps.md G-11
        discoveryModality: "static_artifact_analysis",
        evidence: {
          lineNumber: finding.lineNumber,
          codeSnippet: finding.codeSnippet,
          keySize: null,
          backfilled: true,
        },
        observedAt,
      });
      observationsCreated++;
    }
  }

  console.log(
    `Backfill complete: ${collectionRunsCreated} collection_runs, ${assetsCreated} assets created, ` +
      `${assetsReObserved} assets re-observed (deduplicated by fingerprint), ${observationsCreated} observations.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
