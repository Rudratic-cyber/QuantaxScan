import { COLLECTOR_SURFACES, CATALOGUE_ORDER_BY_SURFACE, catalogueEntryForSurface } from "@workspace/collectors";
import type { DiscoveryCoverage } from "./discovery-coverage";

/**
 * D3 — the coverage and confidence meter, computed.
 * docs/Claude/03-features.md §D3, docs/Claude/09-open-gaps.md G-11.
 *
 * The product's credibility claim is not "here is what we found", it is "here
 * is what we found *and* here is everything we never looked at". This module
 * is the arithmetic behind the second half, kept pure and free of drizzle so
 * the judgement calls below are unit-testable without a database:
 *
 *  1. **A failed collection run is not an examination.** A run row with
 *     `status = 'failed'` is an attempt, and counting it as coverage would be
 *     the exact dishonesty this feature exists to prevent. Such a surface stays
 *     `never-examined`; the attempt is reported separately as `failedRuns`.
 *
 *  2. **Examined-and-found-nothing is its own state.** `collection_runs` exists
 *     precisely so a clean result is distinguishable from an absent one.
 *     Collapsing it into either neighbour loses the only fact a CISO cares
 *     about when the answer is zero.
 *
 *  3. **The confidence distribution has one point per asset, not per
 *     observation.** Re-scanning the same file ten times writes ten
 *     observations of one asset; weighting the distribution by scan frequency
 *     would describe our scheduling, not our evidence quality. Each asset
 *     contributes its most recent observation.
 *
 *  4. **The denominator is surfaces, not assets.** How much crypto is hiding
 *     in the nine surfaces nobody has looked at is *unknowable from our data*,
 *     so nothing here estimates it. Callers must not turn `examinedSurfaces /
 *     totalSurfaces` into a percentage of the estate.
 */

/** Half-open buckets, [lower, upper), except the last which includes 1.0. */
export const CONFIDENCE_BUCKETS: ReadonlyArray<{ label: string; lower: number; upper: number }> = [
  { label: "0.0–0.2", lower: 0, upper: 0.2 },
  { label: "0.2–0.4", lower: 0.2, upper: 0.4 },
  { label: "0.4–0.6", lower: 0.4, upper: 0.6 },
  { label: "0.6–0.8", lower: 0.6, upper: 0.8 },
  { label: "0.8–1.0", lower: 0.8, upper: 1 },
];

export type SurfaceCoverageState = "examined" | "examined-nothing-found" | "never-examined";

export interface CoverageRunRow {
  surface: string;
  status: string;
  completedAt: Date | string | null;
  startedAt: Date | string;
}

export interface CoverageAssetRow {
  id: number;
  surface: string;
  status: string;
}

export interface CoverageObservationRow {
  assetId: number;
  confidence: number;
  observedAt: Date | string;
  /** Tie-breaker when two observations of one asset share a timestamp — a whole scan is written in one transaction, so this is the common case, not the edge case. */
  id: number;
}

export interface SurfaceCoverage {
  /** The `Surface` enum value, i.e. how the database records it. */
  surface: string;
  /** The catalogue id (`@workspace/collectors/surface-catalogue`) so callers can join presentation without re-deriving the mapping. */
  surfaceId: string | null;
  state: SurfaceCoverageState;
  completedRuns: number;
  failedRuns: number;
  lastExaminedAt: string | null;
  assets: number;
  activeAssets: number;
}

export interface ConfidenceBucketCount {
  label: string;
  lower: number;
  upper: number;
  count: number;
}

export interface ConfidenceSummary {
  /** Stated in the payload so a report generated from it can quote the basis rather than guess. */
  basis: "latest observation per active asset";
  /** Active assets that have at least one observation — the number the distribution is over. */
  scored: number;
  /** Active assets with no observation at all. Non-zero means a data problem, and hiding it would be the wrong default. */
  unscored: number;
  /** Assets deliberately left out of the distribution, by status. */
  excludedByAssetStatus: Record<string, number>;
  distinctValues: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  buckets: ConfidenceBucketCount[];
}

export interface ProjectCoverage {
  /** Catalogue entries with at least one completed collection run. Never a percentage of the estate — see the note at the top of this file. */
  examinedSurfaces: number;
  totalSurfaces: number;
  /** Every catalogue surface that has any run or asset. A catalogue surface absent from here has never been examined at all. */
  surfaces: SurfaceCoverage[];
  confidence: ConfidenceSummary;
  /**
   * D8 — how many hosts discovery knows about, and how many of them a
   * collector has actually examined. Computed in `discovery-coverage.ts` and
   * passed through here unchanged.
   *
   * Absent (rather than zeroed) when discovery has never been run for the
   * project, for the same reason a never-examined surface is absent from
   * `surfaces`: "nobody has looked" and "we looked and there are none" are
   * different statements and a zero would say the second.
   */
  discovery?: DiscoveryCoverage;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function bucketIndexFor(confidence: number): number {
  // Clamped rather than dropped: a value outside 0..1 is a collector bug, and
  // silently discarding it would shrink the denominator of an honesty claim.
  const clamped = Math.min(1, Math.max(0, confidence));
  const index = CONFIDENCE_BUCKETS.findIndex((b) => clamped >= b.lower && clamped < b.upper);
  return index === -1 ? CONFIDENCE_BUCKETS.length - 1 : index; // exactly 1.0 lands in the top bucket
}

function summariseConfidence(
  assets: CoverageAssetRow[],
  observations: CoverageObservationRow[],
): ConfidenceSummary {
  const activeAssetIds = new Set(assets.filter((a) => a.status === "active").map((a) => a.id));

  const excludedByAssetStatus: Record<string, number> = {};
  for (const asset of assets) {
    if (asset.status === "active") continue;
    excludedByAssetStatus[asset.status] = (excludedByAssetStatus[asset.status] ?? 0) + 1;
  }

  const latestByAsset = new Map<number, CoverageObservationRow>();
  for (const observation of observations) {
    if (!activeAssetIds.has(observation.assetId)) continue;
    const held = latestByAsset.get(observation.assetId);
    if (
      held === undefined ||
      toMillis(observation.observedAt) > toMillis(held.observedAt) ||
      (toMillis(observation.observedAt) === toMillis(held.observedAt) && observation.id > held.id)
    ) {
      latestByAsset.set(observation.assetId, observation);
    }
  }

  const values = [...latestByAsset.values()].map((o) => o.confidence);
  const buckets: ConfidenceBucketCount[] = CONFIDENCE_BUCKETS.map((b) => ({ ...b, count: 0 }));
  for (const value of values) buckets[bucketIndexFor(value)].count += 1;

  const mean = values.length === 0 ? null : Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000;

  return {
    basis: "latest observation per active asset",
    scored: values.length,
    unscored: activeAssetIds.size - latestByAsset.size,
    excludedByAssetStatus,
    distinctValues: new Set(values).size,
    min: values.length === 0 ? null : Math.min(...values),
    max: values.length === 0 ? null : Math.max(...values),
    mean,
    buckets,
  };
}

export function summariseProjectCoverage(input: {
  runs: CoverageRunRow[];
  assets: CoverageAssetRow[];
  observations: CoverageObservationRow[];
  /** D8. Omitted when discovery has never run for this scope — see `ProjectCoverage.discovery`. */
  discovery?: DiscoveryCoverage;
}): ProjectCoverage {
  const { runs, assets, observations } = input;

  const bySurface = new Map<string, SurfaceCoverage>();
  const entryFor = (surface: string): SurfaceCoverage => {
    let held = bySurface.get(surface);
    if (held === undefined) {
      held = {
        surface,
        surfaceId: catalogueEntryForSurface(surface)?.id ?? null,
        state: "never-examined",
        completedRuns: 0,
        failedRuns: 0,
        lastExaminedAt: null,
        assets: 0,
        activeAssets: 0,
      };
      bySurface.set(surface, held);
    }
    return held;
  };

  for (const run of runs) {
    const entry = entryFor(run.surface);
    if (run.status === "failed") {
      // An attempt that produced nothing is not coverage. Counted, and kept
      // out of `completedRuns` so it can never make a surface look examined.
      entry.failedRuns += 1;
      continue;
    }
    if (run.status !== "completed") continue; // still running — no result yet
    entry.completedRuns += 1;
    const at = toIso(run.completedAt ?? run.startedAt);
    if (at !== null && (entry.lastExaminedAt === null || at > entry.lastExaminedAt)) {
      entry.lastExaminedAt = at;
    }
  }

  for (const asset of assets) {
    const entry = entryFor(asset.surface);
    entry.assets += 1;
    if (asset.status === "active") entry.activeAssets += 1;
  }

  for (const entry of bySurface.values()) {
    if (entry.assets > 0) {
      // Evidence exists, so this surface was examined whatever the run rows
      // say — a missing run row is a bookkeeping gap, not a reason to claim we
      // never looked at something we demonstrably have findings from.
      entry.state = "examined";
    } else if (entry.completedRuns > 0) {
      entry.state = "examined-nothing-found";
    }
  }

  // Catalogue order, so the meter reads the same way as the public coverage page.
  const positionOf = (surface: string) => CATALOGUE_ORDER_BY_SURFACE.get(surface) ?? Number.MAX_SAFE_INTEGER;
  const surfaces = [...bySurface.values()].sort((a, b) => positionOf(a.surface) - positionOf(b.surface));

  return {
    examinedSurfaces: surfaces.filter((s) => s.state !== "never-examined" && s.surfaceId !== null).length,
    totalSurfaces: COLLECTOR_SURFACES.length,
    surfaces,
    confidence: summariseConfidence(assets, observations),
    ...(input.discovery === undefined ? {} : { discovery: input.discovery }),
  };
}
