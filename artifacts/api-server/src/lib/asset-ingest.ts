import { assetsTable, observationsTable, collectionRunsTable } from "@workspace/db/schema";
import type { ScopedTx } from "@workspace/db/org-scope";
import { collectSourceObservations, computeFingerprint } from "@workspace/collectors";
import { and, eq, inArray, sql } from "drizzle-orm";

/**
 * Dual-write step of the A1/A2 migration (docs/Claude/04-architecture.md
 * §"Migration path", step 3): alongside the existing `scans`/`findings`
 * writes, also persist the same detection as `assets`/`observations`/
 * `collection_runs`. Both tables are written from every `POST /scans` and
 * `POST /scans/multi` call during the transition; reads have not been cut
 * over yet (see docs/Claude/04-architecture.md for why that is a
 * deliberately separate follow-up, not done in this change).
 *
 * Takes the caller's already-scoped transaction and uses it directly rather
 * than opening one of its own. That is not a style preference: a second scope
 * opened inside an existing one is the single failure mode in the isolation
 * mechanism that returns another tenant's rows rather than none, so `withOrg`
 * refuses to nest and this function must be handed the `ScopedTx` instead.
 *
 * `organizationId` is required, with no default. A hardcoded organisation
 * default is exactly the bug the whole mechanism exists to prevent — and the
 * policies' `WITH CHECK` would reject a wrong value here anyway.
 */

export interface IngestResult {
  collectionRunId: number;
  assetsCreated: number;
  assetsUpdated: number;
  observationsCreated: number;
  assetsMarkedGone: number;
}

export async function ingestSourceObservations(
  tx: ScopedTx,
  params: {
    /** A stable target identity for the collection run and the fingerprint's `repo` component — this project has no real git-repo concept yet, so callers pass e.g. `project:<id>`. */
    repo: string;
    files: Array<{ path: string; content: string; language: string }>;
    /** Must match the organisation the caller's `withOrg` scope was opened at; RLS rejects anything else. */
    organizationId: number;
  },
): Promise<IngestResult> {
  const { organizationId } = params;
  const observations = collectSourceObservations({ kind: "source", repo: params.repo, files: params.files });

  // Collapse the run's observations to one row per asset before touching the
  // database: a file legitimately matches the same (repo, path, algorithm,
  // symbol) on many lines, and those are many observations of ONE asset.
  // Later lines win, so the asset reflects the last state the collector saw —
  // including a key size going back to undetermined. Deduplicating here is
  // also what makes the batched upsert legal: Postgres rejects an ON CONFLICT
  // DO UPDATE that would touch the same row twice in one statement.
  const assetValuesByFingerprint = new Map<string, typeof assetsTable.$inferInsert>();
  const pendingObservations: Array<{ fingerprint: string; values: Omit<typeof observationsTable.$inferInsert, "assetId" | "collectionRunId"> }> = [];

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

    assetValuesByFingerprint.set(fingerprint, {
      organizationId,
      fingerprint,
      surface: "source",
      algorithm: raw.algorithm,
      keySize,
      location: raw.location,
      locationDetail: raw.locationDetail,
      status: "active",
    });

    pendingObservations.push({
      fingerprint,
      values: {
        organizationId,
        collector: "source-regex",
        collectorVersion: "1.0.0",
        confidence: raw.confidence,
        discoveryModality: raw.discoveryModality,
        evidence: { ...raw.evidence, algorithm: raw.algorithm, keySize, location: raw.location },
      },
    });
  }

  // Fingerprints touched by an observation in this run — used below to find
  // previously-active assets at a scanned location that this run did NOT
  // reobserve, i.e. the vulnerable line was removed.
  const touchedFingerprints = new Set(assetValuesByFingerprint.keys());
  // Scoped per scanned FILE (by `location`), not per `repo`: a call that
  // only submits a subset of a repo's files (e.g. POST /scans submitting
  // one file) has no information about files it wasn't given, so those
  // files' assets must be left untouched rather than wrongly marked gone.
  const scannedLocations = [...new Set(params.files.map((f) => `${params.repo}:${f.path}`))];

  // A fixed number of statements regardless of how many detections the run
  // produced — `POST /scans/multi` submits a whole repo at once, and this runs
  // inside the request. Atomicity now comes from the caller's scope: the whole
  // request is one transaction, so a failure part-way cannot leave a run row
  // claiming more observations than were written.
  {
    const [run] = await tx
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
    const assetIdByFingerprint = new Map<string, number>();

    if (assetValuesByFingerprint.size > 0) {
      const fingerprints = [...assetValuesByFingerprint.keys()];
      const existing = await tx
        .select({ fingerprint: assetsTable.fingerprint })
        .from(assetsTable)
        .where(and(eq(assetsTable.organizationId, organizationId), inArray(assetsTable.fingerprint, fingerprints)));
      assetsUpdated = existing.length;
      assetsCreated = fingerprints.length - existing.length;

      const upserted = await tx
        .insert(assetsTable)
        .values([...assetValuesByFingerprint.values()])
        .onConflictDoUpdate({
          target: [assetsTable.organizationId, assetsTable.fingerprint],
          set: {
            lastSeen: new Date(),
            keySize: sql`excluded.key_size`,
            location: sql`excluded.location`,
            locationDetail: sql`excluded.location_detail`,
            // Reactivation is only ever gone -> active. `waived` (a human
            // explicitly accepted the risk) and `remediated` are decisions
            // about the asset, not observations of it, so re-seeing the same
            // line must not silently undo them. The gone-reconciliation below
            // is already one-directional in the same way: it only ever moves
            // `active` assets.
            status: sql`CASE WHEN ${assetsTable.status} = 'gone' THEN 'active' ELSE ${assetsTable.status} END`,
          },
        })
        .returning({ id: assetsTable.id, fingerprint: assetsTable.fingerprint });
      // Keyed by fingerprint, never by position: the order rows come back
      // from an upsert's RETURNING is not the order they were supplied in.
      for (const row of upserted) assetIdByFingerprint.set(row.fingerprint, row.id);
    }

    if (pendingObservations.length > 0) {
      await tx.insert(observationsTable).values(
        pendingObservations.map((pending) => {
          const assetId = assetIdByFingerprint.get(pending.fingerprint);
          if (assetId === undefined) {
            throw new Error(`asset upsert returned no row for fingerprint ${pending.fingerprint}`);
          }
          return { assetId, collectionRunId: run.id, ...pending.values };
        }),
      );
    }

    // Lifecycle: mark "gone" any previously-active asset at a location this
    // run fully rescanned but did not reobserve — the vulnerable line was
    // removed. docs/Claude/03-features.md A1 acceptance: "Removing the
    // vulnerable line marks the asset `gone`, and it stays in history" (the
    // row is updated in place, never deleted).
    let assetsMarkedGone = 0;
    if (scannedLocations.length > 0) {
      const priorActiveAssets = await tx
        .select({ id: assetsTable.id, fingerprint: assetsTable.fingerprint })
        .from(assetsTable)
        .where(
          and(
            eq(assetsTable.organizationId, organizationId),
            eq(assetsTable.surface, "source"),
            inArray(assetsTable.location, scannedLocations),
            eq(assetsTable.status, "active"),
          ),
        );

      const goneAssetIds = priorActiveAssets.filter((a) => !touchedFingerprints.has(a.fingerprint)).map((a) => a.id);
      if (goneAssetIds.length > 0) {
        // lastSeen is deliberately left as-is — it records when the asset
        // was last actually observed, not when we last failed to find it.
        await tx.update(assetsTable).set({ status: "gone" }).where(inArray(assetsTable.id, goneAssetIds));
        assetsMarkedGone = goneAssetIds.length;
      }
    }

    return { collectionRunId: run.id, assetsCreated, assetsUpdated, observationsCreated: observations.length, assetsMarkedGone };
  }
}
