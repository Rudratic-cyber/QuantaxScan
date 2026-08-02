import { assetsTable, observationsTable, collectionRunsTable } from "@workspace/db/schema";
import * as schema from "@workspace/db/schema";
import { collectSourceObservations, computeFingerprint } from "@workspace/collectors";
import { and, eq } from "drizzle-orm";
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

  return { collectionRunId: run.id, assetsCreated, assetsUpdated, observationsCreated: observations.length };
}
