import { createHash } from "node:crypto";
import { COLLECTOR_SURFACES, catalogueEntryForSurface } from "@workspace/collectors";
import { classifyRiskTrack, CONSULTANT_HOURLY_RATE_USD, DEFAULT_QDAY_SCENARIOS, QDAY_FRAMING, type QDayScenario } from "@workspace/risk";
import { mappingEngine } from "@workspace/mappings";
import type { ProjectCoverage } from "./coverage";
import type { EnrichedInventoryAsset } from "./inventory-assets";

/**
 * E1/E2 — the parts of a report that both packs owe the reader, computed once.
 * docs/Claude/07-reports.md §"Cross-cutting requirements".
 *
 * Pure and drizzle-free, same as its siblings (`coverage.ts`, `readiness.ts`,
 * `posture-timeline.ts`), so every honesty rule below is unit-testable without
 * a database. The route reads the tables; this decides what may be said about
 * what came back.
 *
 * Three rules run through the whole file and they are the reason it exists
 * rather than the route formatting its own numbers:
 *
 *  1. **No number may imply completeness.** Every count is a count of what this
 *     inventory holds. `unexaminedSurfaces` is stated next to every headline so
 *     a figure can never be read as an estate total, and `estateFraction` is
 *     `null` with a reason rather than a percentage — nothing we hold supports
 *     one (`coverage.ts` rule 4).
 *  2. **Every assumed value is marked at the point it is used**, not in a
 *     footnote. `ASSUMPTIONS` below is the register, and each figure that rests
 *     on one names it.
 *  3. **Standards data is resolved on the way out and never persisted.** The
 *     effort hours behind the cost figure come from the mappings data via
 *     `classifyRiskTrack`, and the mapping `dataVersion` is pinned in the
 *     header so the same report can be re-derived in two years.
 */

// ── inputs ───────────────────────────────────────────────────────────────────

/** One collection run, as the report reads it. Provenance, not measurement. */
export interface ReportRunRow {
  id: number;
  collector: string;
  collectorVersion: string;
  surface: string;
  status: string;
  target: string | null;
  observationCount: number;
  startedAt: Date | string;
  completedAt: Date | string | null;
}

/** One observation, as the report reads it — E2's answer to "says who?". */
export interface ReportObservationRow {
  id: number;
  assetId: number;
  collectionRunId: number;
  collector: string;
  collectorVersion: string;
  confidence: number;
  discoveryModality: string;
  observedAt: Date | string;
}

export interface ReportProjectRow {
  id: number;
  name: string;
}

/**
 * Everything both packs are built from. One read, one `now`, one `asOf` — two
 * clock reads would let the exposure half and the deadline half of the same
 * page disagree about which side of a deadline the estate is on.
 */
export interface ReportInput {
  now: Date;
  /** Present assets, already enriched by `summariseInventoryAssets` — one Mosca implementation, not two. */
  assets: EnrichedInventoryAsset[];
  /** Every asset status in the organisation, `gone` included, so exclusions can be stated rather than hidden. */
  statusCounts: Record<string, number>;
  projects: ReportProjectRow[];
  runs: ReportRunRow[];
  observations: ReportObservationRow[];
  coverage: ProjectCoverage;
  scenarios?: readonly QDayScenario[];
  /** Blended hourly rate. Omit and the documented consultant rate is used and marked assumed. */
  hourlyRate?: number;
  /** ISO 4217 code for whatever `hourlyRate` is denominated in. */
  currency?: string;
  /** Set by a release process; `null` when nothing stamped one, which is stated rather than faked. */
  productVersion?: string | null;
}

// ── assumptions ──────────────────────────────────────────────────────────────

export interface Assumption {
  id: string;
  label: string;
  /** Rendered as supplied — a number, a year, a phrase. */
  value: string;
  /** Where the value came from, in the words a reader can challenge it with. */
  basis: string;
  /** False only when the customer actually supplied this value. */
  assumed: boolean;
}

// ── provenance header ────────────────────────────────────────────────────────

export interface CollectorProvenance {
  collector: string;
  collectorVersion: string;
  surface: string;
  completedRuns: number;
  failedRuns: number;
  lastRunAt: string | null;
  observations: number;
}

export interface ReportHeader {
  /** When this document was produced. */
  generatedAt: string;
  /**
   * The most recent moment any asset in it was seen. `null` when the inventory
   * is empty — which is a different statement from "as of now" and must not be
   * rendered as one.
   */
  inventoryAsOf: string | null;
  /** Pinned so the document can be re-derived. docs/Claude/07-reports.md §Reproducibility. */
  mappingDataVersion: string;
  frameworksDataVersion: string;
  /** The date every deadline in this document was evaluated against. */
  asOf: string;
  scenarios: Array<{ name: string; qDayYear: number; rationale: string; confidence: string }>;
  /** `QDAY_FRAMING`. Mandatory wherever a scenario year appears. */
  framing: string;
  collectors: CollectorProvenance[];
  /** `null` when no release process stamped one. Never "0.0.0". */
  productVersion: string | null;
  /** Surfaces examined out of the catalogue — never a share of the estate. See `CoverageLimitations`. */
  coverageSummary: string;
}

// ── coverage limitations ─────────────────────────────────────────────────────

export interface UnexaminedSurface {
  id: string;
  name: string;
  /** `planned` = no collector exists. `live` here means a collector exists and nobody has run it. */
  catalogueStatus: string;
  reason: string;
}

export interface CoverageLimitations {
  /**
   * The sentence that goes at the top of the page, not in a footnote.
   * docs/Claude/07-reports.md §E2: "Undisclosed gaps are the finding that sinks
   * an audit."
   */
  statement: string;
  examinedSurfaces: number;
  totalSurfaces: number;
  unexaminedSurfaces: UnexaminedSurface[];
  /**
   * **Always `null`.** docs/Claude/07-reports.md §E1 asks for "this covers 31%
   * of estimated estate" on page 1, and this product cannot produce that
   * number: `coverage.ts` rule 4 says the denominator is surfaces, not assets,
   * and how much cryptography sits in an unexamined surface is unknowable from
   * anything we hold. Printing a share of the estate would be the single thing
   * this product exists not to do, so the field is present, null, and carries
   * its reason — the gap is still on page 1, stated as surfaces rather than
   * invented as a percentage.
   */
  estateFraction: null;
  estateFractionReason: string;
  /** Collection attempts that produced nothing. Never counted as coverage (`coverage.ts` rule 1). */
  failedRuns: number;
  /** Present assets carrying no observation at all — a data gap, reported rather than hidden. */
  assetsWithoutObservation: number;
  /** Algorithms this estate holds that the standards data does not know. Scored nowhere, named here. */
  unmappedAlgorithms: string[];
  /** Everything else a reader must know before reading any count in the document. */
  caveats: string[];
}

// ── cost ─────────────────────────────────────────────────────────────────────

export interface CostEstimate {
  currency: string;
  hourlyRate: number;
  hourlyRateAssumed: boolean;
  hourlyRateBasis: string;
  estimatedHours: number;
  estimatedCost: number;
  /** Assets the figure covers. */
  assetsCosted: number;
  /** Of those, how many carry an effort estimate somebody recorded against the asset itself. */
  assetsWithRecordedEffort: number;
  /** Of those, how many took the algorithm's base effort from the standards data instead. */
  assetsWithDerivedEffort: number;
  /**
   * Assets excluded from the figure because nothing supports an effort number
   * for them. Counted, never silently treated as zero — a zero would make the
   * total read as complete.
   */
  assetsWithoutEffortEstimate: number;
  /** The whole figure in one sentence, with its assumptions inline. E1 question 3. */
  statement: string;
}

// ── trend ────────────────────────────────────────────────────────────────────

export interface TrendStatement {
  /** False until at least two distinct collection instants exist. */
  sufficient: boolean;
  /** `"baseline"` until then — never `"0% change"`. docs/Claude/07-reports.md §E1. */
  verdict: string;
  distinctCollectionInstants: number;
  firstCollectionAt: string | null;
  lastCollectionAt: string | null;
  basis: string;
}

// ── derivations ──────────────────────────────────────────────────────────────

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** Rounds to one decimal so an hours figure does not print a false precision. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function buildCollectorProvenance(input: ReportInput): CollectorProvenance[] {
  const byKey = new Map<string, CollectorProvenance>();
  const runToKey = new Map<number, string>();

  for (const run of input.runs) {
    const key = `${run.collector}@${run.collectorVersion}:${run.surface}`;
    runToKey.set(run.id, key);
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = {
        collector: run.collector,
        collectorVersion: run.collectorVersion,
        surface: run.surface,
        completedRuns: 0,
        failedRuns: 0,
        lastRunAt: null,
        observations: 0,
      };
      byKey.set(key, entry);
    }
    if (run.status === "failed") {
      entry.failedRuns += 1;
      continue;
    }
    if (run.status !== "completed") continue;
    entry.completedRuns += 1;
    const at = toIso(run.completedAt ?? run.startedAt);
    if (entry.lastRunAt === null || at > entry.lastRunAt) entry.lastRunAt = at;
  }

  // Counted from the observations themselves rather than `collection_runs.observation_count`,
  // which is a per-run tally written at ingest and says nothing about how many
  // of those rows are still reachable.
  for (const observation of input.observations) {
    const key = runToKey.get(observation.collectionRunId);
    const entry = key === undefined ? undefined : byKey.get(key);
    if (entry !== undefined) entry.observations += 1;
  }

  return [...byKey.values()].sort(
    (a, b) => a.collector.localeCompare(b.collector) || a.surface.localeCompare(b.surface),
  );
}

/** The most recent moment any present asset was seen, or `null` for an empty inventory. */
export function inventoryAsOf(assets: EnrichedInventoryAsset[]): string | null {
  let latest: string | null = null;
  for (const asset of assets) {
    if (latest === null || asset.lastSeen > latest) latest = asset.lastSeen;
  }
  return latest;
}

export function buildHeader(input: ReportInput, coverage: CoverageLimitations): ReportHeader {
  const scenarios = input.scenarios ?? DEFAULT_QDAY_SCENARIOS;
  return {
    generatedAt: input.now.toISOString(),
    inventoryAsOf: inventoryAsOf(input.assets),
    mappingDataVersion: mappingEngine.dataVersion,
    frameworksDataVersion: mappingEngine.frameworksDataVersion,
    asOf: input.now.toISOString(),
    scenarios: scenarios.map((s) => ({
      name: s.name,
      qDayYear: s.qDayYear,
      rationale: s.rationale,
      confidence: s.confidence,
    })),
    framing: QDAY_FRAMING,
    collectors: buildCollectorProvenance(input),
    productVersion: input.productVersion ?? null,
    coverageSummary: coverage.statement,
  };
}

/**
 * The surfaces nobody has looked at, from the catalogue rather than from the
 * rows — a surface with no runs and no assets is absent from
 * `coverage.surfaces` entirely, and reading that absence as a zero is the
 * mistake this function exists to prevent.
 */
export function unexaminedSurfaces(coverage: ProjectCoverage): UnexaminedSurface[] {
  const examined = new Set(
    coverage.surfaces.filter((s) => s.state !== "never-examined" && s.surfaceId !== null).map((s) => s.surfaceId as string),
  );
  return COLLECTOR_SURFACES.filter((entry) => !examined.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      catalogueStatus: entry.status,
      reason:
        entry.status === "planned"
          ? "No collector exists for this surface, so anything it would have found has never been examined."
          : "A collector exists for this surface but has not been run against this organisation, so it has never been examined.",
    }));
}

export const COVERAGE_ESTATE_FRACTION_REASON =
  "Nothing in this inventory supports a figure for how much cryptography sits in the surfaces nobody has " +
  "examined, so no share of the estate is stated. The gap is reported as surfaces examined out of the " +
  "collector catalogue instead, which is a count rather than an estimate.";

export function buildCoverageLimitations(input: ReportInput): CoverageLimitations {
  const unexamined = unexaminedSurfaces(input.coverage);
  const failedRuns = input.runs.filter((r) => r.status === "failed").length;
  const observedAssetIds = new Set(input.observations.map((o) => o.assetId));
  const assetsWithoutObservation = input.assets.filter((a) => !observedAssetIds.has(a.id)).length;
  const unmapped = [...new Set(input.assets.filter((a) => a.compliance === null).map((a) => a.algorithm))].sort();

  const statement =
    `This document describes ${input.assets.length} cryptographic asset(s) found on ` +
    `${input.coverage.examinedSurfaces} of ${input.coverage.totalSurfaces} collector surfaces. ` +
    `${unexamined.length} surface(s) have never been examined and nothing here describes them. ` +
    `It is not a statement that the remainder of the estate is clean.`;

  const caveats = [
    "Every count is a count of what this inventory currently holds. An unexamined surface is unexamined, not clean.",
    "Assets a later collection proved absent are excluded from the inventory and reported separately under exclusions.",
  ];
  if (failedRuns > 0) {
    caveats.push(
      `${failedRuns} collection attempt(s) failed. A failed attempt is not an examination and contributes no coverage.`,
    );
  }
  if (assetsWithoutObservation > 0) {
    caveats.push(
      `${assetsWithoutObservation} asset(s) carry no observation record, so no collector, version or confidence can be stated for them.`,
    );
  }
  if (unmapped.length > 0) {
    // Counted here, named in `unmappedAlgorithms`. The two are separated so a
    // page that must not print an algorithm name can still print the caveat —
    // see `page1Coverage()` and E1's page-one rule.
    caveats.push(
      `${unmapped.length} of the algorithms in this inventory have no entry in the standards data, so no obligation, deadline or replacement is stated for them here.`,
    );
  }

  return {
    statement,
    examinedSurfaces: input.coverage.examinedSurfaces,
    totalSurfaces: input.coverage.totalSurfaces,
    unexaminedSurfaces: unexamined,
    estateFraction: null,
    estateFractionReason: COVERAGE_ESTATE_FRACTION_REASON,
    failedRuns,
    assetsWithoutObservation,
    unmappedAlgorithms: unmapped,
    caveats,
  };
}

/**
 * Effort for one asset, and where the number came from. Never invented.
 *
 * `effortHours` on the asset is what somebody recorded against that specific
 * asset; today no collector writes it, so in practice almost everything falls
 * to the standards data's per-algorithm base — which is a class average, not an
 * estimate of this asset, and the report says which of the two it used. An
 * algorithm the standards data does not know yields `null`: no effort number
 * exists for it and inventing one is how a wrong total reaches a board.
 */
export function effortHoursFor(asset: EnrichedInventoryAsset): { hours: number; source: "recorded" | "derived" } | null {
  if (asset.effortHours !== null && asset.effortHours > 0) {
    return { hours: asset.effortHours, source: "recorded" };
  }
  const derived = classifyRiskTrack(asset.algorithm).mapping?.effortHours;
  if (derived === undefined) return null;
  return { hours: derived, source: "derived" };
}

export function buildCostEstimate(input: ReportInput): CostEstimate {
  const hourlyRateAssumed = input.hourlyRate === undefined;
  const hourlyRate = input.hourlyRate ?? CONSULTANT_HOURLY_RATE_USD;
  // The documented default rate is denominated in USD. Accepting a currency
  // code alongside it without a rate would relabel that number as some other
  // currency, which is a lie about an amount rather than a formatting choice.
  const currency = hourlyRateAssumed ? "USD" : (input.currency ?? "USD");

  let estimatedHours = 0;
  let assetsWithRecordedEffort = 0;
  let assetsWithDerivedEffort = 0;
  let assetsWithoutEffortEstimate = 0;

  // Only assets Mosca actually applies to. Classical-hygiene defects are real
  // work but they are not this migration, and folding them in would restate
  // G-10 as a currency figure.
  const inScope = input.assets.filter((a) => a.mosca.applicable);
  for (const asset of inScope) {
    const effort = effortHoursFor(asset);
    if (effort === null) {
      assetsWithoutEffortEstimate += 1;
      continue;
    }
    estimatedHours += effort.hours;
    if (effort.source === "recorded") assetsWithRecordedEffort += 1;
    else assetsWithDerivedEffort += 1;
  }

  const assetsCosted = assetsWithRecordedEffort + assetsWithDerivedEffort;
  estimatedHours = round1(estimatedHours);
  const estimatedCost = Math.round(estimatedHours * hourlyRate);

  const rateBasis = hourlyRateAssumed
    ? `Assumed, not supplied: the product's documented blended rate of ${hourlyRate} ${currency} per hour.`
    : `Supplied for this report: ${hourlyRate} ${currency} per hour.`;

  const excluded =
    assetsWithoutEffortEstimate > 0
      ? ` ${assetsWithoutEffortEstimate} in-scope asset(s) carry no effort estimate and are excluded from the total rather than counted as zero.`
      : "";

  const statement =
    `${formatCurrency(estimatedCost, currency)} (at ${hourlyRate} ${currency}/hr ` +
    `${hourlyRateAssumed ? "assumed" : "supplied"}, ${estimatedHours} est. hours across ${assetsCosted} asset(s) ` +
    `on ${input.coverage.examinedSurfaces} of ${input.coverage.totalSurfaces} collector surfaces).` +
    excluded +
    " It is the cost of migrating what has been found, not of migrating the estate.";

  return {
    currency,
    hourlyRate,
    hourlyRateAssumed,
    hourlyRateBasis: rateBasis,
    estimatedHours,
    estimatedCost,
    assetsCosted,
    assetsWithRecordedEffort,
    assetsWithDerivedEffort,
    assetsWithoutEffortEstimate,
    statement,
  };
}

/** Grouping separators only. No currency symbol is guessed from a code we were handed. */
export function formatCurrency(amount: number, currency: string): string {
  return `${amount.toLocaleString("en-GB")} ${currency}`;
}

/**
 * E1 question 4. docs/Claude/07-reports.md: "Trend arrows require ≥2 collection
 * runs — until then, say 'baseline', not '0% change'." A single collection is a
 * first measurement; calling it a flat trend asserts a comparison that was
 * never made.
 */
export function buildTrend(input: ReportInput): TrendStatement {
  const completed = input.runs.filter((r) => r.status === "completed");
  const instants = new Set(completed.map((r) => toMillis(r.completedAt ?? r.startedAt)));
  const sorted = [...instants].sort((a, b) => a - b);
  const sufficient = sorted.length >= 2;

  return {
    sufficient,
    verdict: sufficient ? "measured" : "baseline",
    distinctCollectionInstants: sorted.length,
    firstCollectionAt: sorted.length > 0 ? new Date(sorted[0]).toISOString() : null,
    lastCollectionAt: sorted.length > 0 ? new Date(sorted[sorted.length - 1]).toISOString() : null,
    basis: sufficient
      ? `Compared across ${sorted.length} distinct collection instants.`
      : "Baseline. Fewer than two distinct collection instants exist, so there is nothing to compare against and no change is reported.",
  };
}

export function buildAssumptions(input: ReportInput, cost: CostEstimate): Assumption[] {
  const scenarios = input.scenarios ?? DEFAULT_QDAY_SCENARIOS;
  const assumedX = input.assets.filter((a) => a.mosca.xAssumed).length;
  const derivedEffort = cost.assetsWithDerivedEffort;

  const assumptions: Assumption[] = [
    {
      id: "hourly-rate",
      label: "Blended hourly rate",
      value: `${cost.hourlyRate} ${cost.currency} per hour`,
      basis: cost.hourlyRateBasis,
      assumed: cost.hourlyRateAssumed,
    },
    {
      id: "qday-scenarios",
      label: "Q-Day scenarios",
      value: scenarios.map((s) => `${s.name} ${s.qDayYear}`).join(", "),
      basis: `${QDAY_FRAMING} Every scenario in this set is marked ${[...new Set(scenarios.map((s) => s.confidence))].join("/")} in the source data.`,
      assumed: scenarios.some((s) => s.confidence !== "verified"),
    },
    {
      id: "secrecy-lifetime",
      label: "Secrecy lifetime (X)",
      value:
        assumedX === 0
          ? "Supplied for every asset"
          : `Assumed for ${assumedX} of ${input.assets.length} asset(s)`,
      basis:
        assumedX === 0
          ? "Every asset in this document carries a secrecy lifetime somebody stated for it or for its project."
          : "Where nobody stated how long the data behind an asset must stay confidential, the product's documented default was used and the asset is marked accordingly.",
      assumed: assumedX > 0,
    },
    {
      id: "migration-effort",
      label: "Migration effort (Y)",
      value: `${cost.estimatedHours} hours across ${cost.assetsCosted} asset(s)`,
      basis:
        derivedEffort === 0
          ? "Every costed asset carries an effort estimate recorded against the asset itself."
          : `${derivedEffort} asset(s) take the per-algorithm base effort from the standards data rather than an estimate anybody made for that specific asset.`,
      assumed: derivedEffort > 0,
    },
    {
      id: "coverage",
      label: "Coverage",
      value: `${input.coverage.examinedSurfaces} of ${input.coverage.totalSurfaces} collector surfaces examined`,
      basis: COVERAGE_ESTATE_FRACTION_REASON,
      assumed: false,
    },
  ];

  return assumptions;
}

/**
 * A content digest over the document, so a copy can be checked against the one
 * that was issued. **This is not a signature** — there is no key management in
 * this product yet — and every caller of it says so in the same breath, because
 * "signed" is a claim an auditor will test.
 */
export function contentDigest(document: unknown): string {
  return createHash("sha256").update(canonicalJson(document)).digest("hex");
}

/** Key-sorted JSON, so two runs over an equal document produce an equal digest. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

/** Catalogue name for a surface, for prose. Falls back to the raw enum value rather than inventing one. */
export function surfaceLabel(surface: string): string {
  return catalogueEntryForSurface(surface)?.name ?? surface;
}

/**
 * The coverage block as page one of the board pack may state it: everything
 * except the *names* of the algorithms the standards data does not know.
 *
 * Dropping the names is the only concession page one makes, and it drops
 * nothing a board reader can act on — the count survives in `caveats`, and
 * Appendix B and the regulator submission both carry the full list. Narrowing
 * by construction rather than by a renderer that remembers to skip a field is
 * what keeps E1's page-one rule checkable in one place.
 */
export type Page1Coverage = Omit<CoverageLimitations, "unmappedAlgorithms">;

export function page1Coverage(coverage: CoverageLimitations): Page1Coverage {
  const { unmappedAlgorithms: _named, ...rest } = coverage;
  return rest;
}
