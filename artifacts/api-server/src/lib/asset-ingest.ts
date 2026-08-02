import { assetsTable, observationsTable, collectionRunsTable } from "@workspace/db/schema";
import * as schema from "@workspace/db/schema";
import { collectSourceObservations, computeFingerprint } from "@workspace/collectors";
import { and, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

// Generic over the query-result driver (node-postgres in production,
// pglite in tests) so this function accepts either without a cast.
type AppDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Dual-write step of the A1/A2 migration (docs/Claude/04-architecture.md
 * §"Migration path", step 3): alongside the existing `scans`/`findings`
 * writes, also persist the same detection as `assets`/`observations`/
 * `collection_runs`. Both tables are written from every `POST /scans` and
 * `POST /scans/multi` call during the transition; reads have not been cut
 * over yet (see docs/Claude/04-architecture.md for why that is a
 * deliberately separate follow-up, not done in this change).
 *
 * There is no `organizations` table yet (F2 multi-tenancy is out of
 * scope), so every asset is attributed to a single hardcoded organization.
 */
export const DEFAULT_ORGANIZATION_ID = 1;

export interface IngestResult {
  collectionRunId: number;
  assetsCreated: number;
  assetsUpdated: number;
  observationsCreated: number;
  assetsMarkedGone: number;
}

export async function ingestSourceObservations(
  db: AppDatabase,
  params: {
    /** A stable target identity for the collection run and the fingerprint's `repo` component — this project has no real git-repo concept yet, so callers pass e.g. `project:<id>`. */
    repo: string;
    files: Array<{ path: string; content: string; language: string }>;
    organizationId?: number;
  },
): Promise<IngestResult> {
  const organizationId = params.organizationId ?? DEFAULT_ORGANIZATION_ID;
  const observations = collectSourceObservations({ kind: "source", repo: params.repo, files: params.files });

  const [run] = await db
    .insert(collectionRunsTable)
    .values({
      organizationId,
      collector: "source-regex",
      collectorVersion: "1.0.0",
      surface: "source",
      status: "completed",
      target: params.repo,
      observationCount: observations.length,
      completedAt: new Date(),
    })
    .returning();

  let assetsCreated = 0;
  let assetsUpdated = 0;
  // Fingerprints touched by an observation in this run — used below to find
  // previously-active assets at a scanned location that this run did NOT
  // reobserve, i.e. the vulnerable line was removed. Only fingerprints, not
  // full asset rows, need tracking here since the gone-reconciliation query
  // re-fetches whatever it needs to update.
  const touchedFingerprints = new Set<string>();

  for (const raw of observations) {
    const source = raw.locationDetail?.kind === "source" ? raw.locationDetail.source : undefined;
    const path = source?.path ?? raw.location;
    const symbol = source?.symbol ?? raw.algorithm;
    // Undetermined stays undetermined here — `raw.keySize` is `undefined`
    // when the collector couldn't determine it; this is the one place that
    // becomes `null` for the nullable DB column. Never a guessed default —
    // see docs/Claude/09-open-gaps.md G-05.
    const keySize = raw.keySize ?? null;

    const fingerprint = computeFingerprint({
      surface: "source",
      repo: params.repo,
      path,
      algorithm: raw.algorithm,
      symbol,
    });
    touchedFingerprints.add(fingerprint);

    const [existingAsset] = await db
      .select()
      .from(assetsTable)
      .where(and(eq(assetsTable.organizationId, organizationId), eq(assetsTable.fingerprint, fingerprint)));

    let assetId: number;
    if (existingAsset) {
      await db
        .update(assetsTable)
        .set({ lastSeen: new Date(), status: "active", keySize, location: raw.location, locationDetail: raw.locationDetail })
        .where(eq(assetsTable.id, existingAsset.id));
      assetId = existingAsset.id;
      assetsUpdated++;
    } else {
      const [created] = await db
        .insert(assetsTable)
        .values({
          organizationId,
          fingerprint,
          surface: "source",
          algorithm: raw.algorithm,
          keySize,
          location: raw.location,
          locationDetail: raw.locationDetail,
          status: "active",
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
      confidence: raw.confidence,
      discoveryModality: raw.discoveryModality,
      evidence: { ...raw.evidence, algorithm: raw.algorithm, keySize, location: raw.location },
    });
  }

  // Lifecycle: mark "gone" any previously-active asset at a location this
  // run fully rescanned but did not reobserve — the vulnerable line was
  // removed. docs/Claude/03-features.md A1 acceptance: "Removing the
  // vulnerable line marks the asset `gone`, and it stays in history" (the
  // row is updated in place, never deleted).
  //
  // Scoped per scanned FILE (by `location`), not per `repo`: a call that
  // only submits a subset of a repo's files (e.g. POST /scans submitting
  // one file) has no information about files it wasn't given, so those
  // files' assets must be left untouched rather than wrongly marked gone.
  let assetsMarkedGone = 0;
  const scannedLocations = [...new Set(params.files.map((f) => `${params.repo}:${f.path}`))];
  if (scannedLocations.length > 0) {
    const priorActiveAssets = await db
      .select()
      .from(assetsTable)
      .where(
        and(
          eq(assetsTable.organizationId, organizationId),
          eq(assetsTable.surface, "source"),
          inArray(assetsTable.location, scannedLocations),
          eq(assetsTable.status, "active"),
        ),
      );

    for (const asset of priorActiveAssets) {
      if (!touchedFingerprints.has(asset.fingerprint)) {
        // lastSeen is deliberately left as-is — it records when the asset
        // was last actually observed, not when we last failed to find it.
        await db.update(assetsTable).set({ status: "gone" }).where(eq(assetsTable.id, asset.id));
        assetsMarkedGone++;
      }
    }
  }

  return { collectionRunId: run.id, assetsCreated, assetsUpdated, observationsCreated: observations.length, assetsMarkedGone };
}
