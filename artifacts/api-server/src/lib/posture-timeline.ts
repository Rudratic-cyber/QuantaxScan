import {
  DEFAULT_QDAY_SCENARIOS,
  QDAY_FRAMING,
  assessMoscaRisk,
  migrationYearsFromEffortHours,
  type QDayScenario,
  type QDayScenarioName,
} from "@workspace/risk";
import { resolveSecrecyLifetime, type DataClassification } from "@workspace/db/classification";
import { mappingEngine, type Citation, type MappingResult } from "@workspace/mappings";

/**
 * D7 — the estate posture timeline, computed.
 * docs/Claude/03-features.md §D7, docs/Claude/06-cisa-dashboard.md §"Row 5 — Time pressure".
 *
 * A scrubbable history of cryptographic posture: how many assets breached
 * Mosca's inequality, per Q-Day scenario, at each point the estate was actually
 * examined — and what is scheduled to happen to it next. Pure and drizzle-free
 * for the same reason `coverage.ts` is: every judgement call below is a claim
 * about honesty, and each one is unit-testable without a database.
 *
 * The four rules this module exists to enforce:
 *
 *  1. **One observed point per real collection instant, and no others.** The
 *     obvious implementation samples a regular grid between the first asset and
 *     now. It produces a smooth, rising, entirely fabricated curve: Z shrinks
 *     as the clock advances, so an estate that never changed still "trends
 *     worse". Points here come from `collection_runs` — the unit of examination
 *     the rest of the codebase already counts — and from nothing else.
 *
 *  2. **One collection instant is not a history, and the payload says so.**
 *     `sufficientForTrend` is false with fewer than two instants, and `reason`
 *     is a sentence the panel prints verbatim. Drawing a flat line through a
 *     single measurement, or interpolating between two, asserts readings we do
 *     not have — the same failure D3's coverage meter exists to prevent, moved
 *     onto the time axis.
 *
 *  3. **Observed and projected are different kinds of statement.** Everything
 *     at or before `now` is derived from timestamps in the database. Everything
 *     after it is this same arithmetic evaluated against a *frozen* inventory,
 *     carried in a separate branch of the payload with its assumption stated,
 *     so a renderer cannot accidentally draw them as one series.
 *
 *  4. **Deadlines are resolved, never named.** Not one year appears in this
 *     file. `resolveDeadlines` defaults to the C1 mapping engine and is
 *     injectable, so the test that mutates cloned standards data and watches
 *     the markers move is possible — which is the only way to prove the dates
 *     are not hardcoded (the same criterion `lib/mappings/src/engine.test.ts`
 *     holds itself to).
 */

// ── inputs ───────────────────────────────────────────────────────────────────

/** A `collection_runs` row. The unit of examination, and therefore the unit of history. */
export interface TimelineRunRow {
  id: number;
  surface: string;
  status: string;
  /** `collection_runs.target`, e.g. `project:7`. Null for a run not addressed at a project. */
  target: string | null;
  startedAt: Date | string;
  completedAt: Date | string | null;
}

/** An `assets` row, with the A3 classification columns it needs to resolve its own X. */
export interface TimelineAssetRow {
  id: number;
  surface: string;
  algorithm: string;
  location: string;
  status: string;
  firstSeen: Date | string;
  lastSeen: Date | string;
  dataClassification: DataClassification | null;
  secrecyLifetimeYears: number | null;
  /** Y's raw input. Null across the board today — see `migrationYearsBasis` below. */
  effortHours: number | null;
}

/** A `projects` row. Only the A3 defaults and the name are needed. */
export interface TimelineProjectRow {
  id: number;
  name: string;
  dataClassification: DataClassification | null;
  secrecyLifetimeYears: number | null;
}

/**
 * How an algorithm is classified for Mosca. Injectable so the deadline/track
 * data can be swapped wholesale in a test — see rule 4.
 */
export type AlgorithmResolver = (algorithm: string) => MappingResult | undefined;

export interface PostureTimelineInput {
  runs: TimelineRunRow[];
  assets: TimelineAssetRow[];
  projects: TimelineProjectRow[];
  /** Injected for reproducibility. Everything at or before this is observed; everything after is projected. */
  now: Date;
  scenarios?: readonly QDayScenario[];
  /** Defaults to the bundled C1 engine. */
  resolveAlgorithm?: AlgorithmResolver;
}

// ── outputs ──────────────────────────────────────────────────────────────────

export type ScenarioCounts = Record<QDayScenarioName, number>;

export interface TimelinePoint {
  /** ISO instant. For observed points this is a real `collection_runs` timestamp. */
  at: string;
  /** Assets in the inventory at `at`, whatever their status. */
  assetsKnown: number;
  /** Assets present *and* not yet gone at `at`. The number the verdicts are over. */
  assetsPresent: number;
  /** Of `assetsPresent`, those the mapping data calls quantum-vulnerable. */
  pqcAssets: number;
  /** Present assets on the classical-hygiene track. Reported, never scored — G-10. */
  hygieneAssets: number;
  /** Present assets the standards data does not know. Named rather than bucketed. */
  unmappedAssets: number;
  /** Breaching assets per Q-Day scenario, evaluated with `now = at`. */
  breachedByScenario: ScenarioCounts;
}

export interface ObservedPoint extends TimelinePoint {
  kind: "observed";
  /** The completed runs that share this instant. */
  collectionRunIds: number[];
  surfaces: string[];
  /** Assets whose `firstSeen` falls at or before this instant but after the previous one. */
  assetsAdded: number;
}

export interface ProjectedPoint extends TimelinePoint {
  kind: "projected";
  /** The calendar year this point evaluates, at 1 January UTC. */
  year: number;
}

export interface ObservedHistory {
  /**
   * False when fewer than two distinct collection instants exist. A renderer
   * must not draw a line through the points when this is false.
   */
  sufficientForTrend: boolean;
  /** Printed verbatim by the panel. Says what is missing, in words, not a code. */
  reason: string;
  distinctCollectionInstants: number;
  observedSpanDays: number | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  /** Completed runs only. A failed run is an attempt, not an examination — `coverage.ts` rule 1. */
  completedRuns: number;
  failedRuns: number;
  points: ObservedPoint[];
}

export interface ProjectedHorizon {
  /** The assumption the whole branch rests on. Must be shown wherever these points are. */
  assumption: string;
  /** The instant the frozen inventory was read at. */
  basisAt: string;
  points: ProjectedPoint[];
}

export interface DeadlineMarker {
  /** Stable within one response, for React keys and scrub targets. */
  id: string;
  /** The raw vocabulary term from `algorithms.json` (`deprecated`, `disallowed`, ...). Never spelled here. */
  type: string;
  label: string;
  effect: string;
  /** 1 January of the first year the rule binds, UTC. Derived from the data's own `after`/`in`/`since`. */
  effectiveFrom: string;
  /** The calendar year of `effectiveFrom`, for axis placement. */
  year: number;
  /** True when the rule already binds at `now`. */
  inEffect: boolean;
  /**
   * Which use the rule covers, when the data keys it that way. Load-bearing for
   * SHA-1 and DSA, where the algorithm is disallowed for one purpose and fine
   * for another.
   */
  appliesTo: string | null;
  /**
   * The security strength the rule is keyed on (IR 8547 keys its tables this
   * way). Without it two markers on the same year read as duplicates, when in
   * fact they are separate rules covering different key sizes.
   */
  securityStrength: string | null;
  framework: string;
  frameworkName: string | null;
  requirement: string;
  citation: Citation;
  confidence: string;
  draftStatus: string | null;
  /** Which of *this estate's* algorithms the rule covers. Empty is impossible — a marker only exists because an asset produced it. */
  algorithms: string[];
  /** How many present assets it covers. This is the "N assets expire past here" figure, and it is counted, not estimated. */
  assets: number;
  caveats: string[];
}

export interface EstateRollup {
  projects: Array<{ id: number; name: string; assets: number; presentAssets: number }>;
  /**
   * Assets whose `location` carries no `project:<id>:` prefix. `tls`,
   * `certificate` and `kms` assets legitimately have no project at all, so
   * these are counted and named rather than dropped from an estate view.
   */
  unassociatedAssets: number;
  totalAssets: number;
  presentAssets: number;
}

export interface PostureTimelineInputs {
  secrecyLifetime: {
    /** How many present assets resolved X at each level. `default`/`project` mean the value was assumed. */
    bySource: Record<string, number>;
    assumedForAssets: number;
    /** One sentence per distinct basis, for the "show the inputs" panel. */
    bases: string[];
  };
  migrationYears: {
    /** Y as used, in years, for every asset that has no recorded effort. */
    defaultValue: number;
    assetsWithRecordedEffort: number;
    /** Says plainly that Y is not measured yet, so a reader knows X vs Z decided the verdict. */
    basis: string;
  };
}

export interface PostureTimeline {
  generatedAt: string;
  now: string;
  /** `QDAY_FRAMING`. Mandatory wherever a scenario year is shown. */
  framing: string;
  scenarios: Array<{ name: QDayScenarioName; qDayYear: number; rationale: string; confidence: string }>;
  estate: EstateRollup;
  observed: ObservedHistory;
  projected: ProjectedHorizon;
  deadlines: DeadlineMarker[];
  inputs: PostureTimelineInputs;
  /**
   * Facts a reader will expect on a time-pressure panel that this product
   * cannot produce. Stated on the page rather than silently omitted — doc 06's
   * certificate-expiry chart needs a `notAfter` the asset model has no column
   * for, and no certificate collector has shipped.
   */
  notCollected: Array<{ id: string; label: string; reason: string }>;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const PROJECT_PREFIX_PATTERN = /^project:(\d+):/;

function toMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function toIso(value: Date | string): string {
  return new Date(toMillis(value)).toISOString();
}

function emptyCounts(scenarios: readonly QDayScenario[]): ScenarioCounts {
  return Object.fromEntries(scenarios.map((s) => [s.name, 0])) as ScenarioCounts;
}

/**
 * The `project:<id>:` association, matched with its trailing colon.
 *
 * Without the colon `project:1` is a prefix of `project:10` and an estate
 * roll-up silently attributes one project's assets to another. `projectRepoId`
 * owns the format; this owns reading it back, and the two must not drift.
 */
function projectIdFromLocation(location: string): number | null {
  const match = PROJECT_PREFIX_PATTERN.exec(location);
  return match === null ? null : Number(match[1]);
}

/**
 * Was this asset part of the inventory at `instant`?
 *
 * `firstSeen` is when it entered. There is no `goneAt` column, and
 * `asset-ingest.ts` deliberately leaves `lastSeen` alone when it marks an asset
 * gone — so `lastSeen` is the last time the asset was actually *observed*, and
 * for a gone asset that is the honest end of its life. For every other status
 * the asset is still present now, so it is present at any instant after it
 * appeared. Nothing here reconstructs a status it cannot: a `waived` asset was
 * not retroactively waived, and it is counted as present throughout.
 */
function presentAt(asset: TimelineAssetRow, instantMs: number): boolean {
  if (toMillis(asset.firstSeen) > instantMs) return false;
  if (asset.status === "gone") return toMillis(asset.lastSeen) >= instantMs;
  return true;
}

/**
 * The first instant a deadline binds, from the data's own vocabulary.
 *
 * `after: "2030"` means the rule takes effect once 2030 has passed, so
 * 1 January 2031 — `ObligationDeadline`'s own documentation. `in: "2030"` binds
 * from the start of that year, and `since` is already a date. A deadline with
 * none of the three is in effect already and has no place on a time axis.
 */
function effectiveFromOf(deadline: { after?: string; in?: string; since?: string }): Date | null {
  if (deadline.since !== undefined) {
    const at = new Date(deadline.since);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  if (deadline.in !== undefined) {
    const year = Number(deadline.in);
    return Number.isFinite(year) ? new Date(Date.UTC(year, 0, 1)) : null;
  }
  if (deadline.after !== undefined) {
    const year = Number(deadline.after);
    return Number.isFinite(year) ? new Date(Date.UTC(year + 1, 0, 1)) : null;
  }
  return null;
}

interface ScoredAsset {
  row: TimelineAssetRow;
  quantumVulnerable: boolean;
  mapped: boolean;
  /** X, years, resolved through A3 with its provenance. */
  x: number;
  xSource: string;
  xAssumed: boolean;
  xBasis: string;
  /** Y, years. */
  y: number;
}

/**
 * One Mosca evaluation per asset per scenario, at `instant`.
 *
 * `now` is injected as the historical instant, which is the entire mechanism
 * behind the observed series: at an earlier instant Z is larger, so fewer
 * assets breach. That is a real change in the verdict, not a redrawing of the
 * same number, and it is why `assessMoscaRisk` taking an injectable clock
 * matters here.
 */
function countBreaches(
  scored: ScoredAsset[],
  instant: Date,
  scenarios: readonly QDayScenario[],
): ScenarioCounts {
  const counts = emptyCounts(scenarios);
  for (const asset of scored) {
    const assessment = assessMoscaRisk({
      secrecyLifetimeYears: asset.x,
      migrationYears: asset.y,
      hasQuantumVulnerableCrypto: asset.quantumVulnerable,
      now: instant,
      scenarios,
    });
    for (const verdict of assessment.verdicts) {
      if (verdict.breached) counts[verdict.scenario] += 1;
    }
  }
  return counts;
}

function pointFor(
  scored: ScoredAsset[],
  instant: Date,
  scenarios: readonly QDayScenario[],
): TimelinePoint {
  const instantMs = instant.getTime();
  const known = scored.filter((a) => toMillis(a.row.firstSeen) <= instantMs);
  const present = known.filter((a) => presentAt(a.row, instantMs));

  return {
    at: instant.toISOString(),
    assetsKnown: known.length,
    assetsPresent: present.length,
    pqcAssets: present.filter((a) => a.quantumVulnerable).length,
    hygieneAssets: present.filter((a) => a.mapped && !a.quantumVulnerable).length,
    unmappedAssets: present.filter((a) => !a.mapped).length,
    breachedByScenario: countBreaches(present, instant, scenarios),
  };
}

// ── the summariser ───────────────────────────────────────────────────────────

export function summarisePostureTimeline(input: PostureTimelineInput): PostureTimeline {
  const { runs, assets, projects, now } = input;
  const scenarios = input.scenarios ?? DEFAULT_QDAY_SCENARIOS;
  const resolveAlgorithm =
    input.resolveAlgorithm ?? ((algorithm: string) => mappingEngine.resolve({ algorithm }, { asOf: now }));

  const projectById = new Map(projects.map((p) => [p.id, p]));
  const nowMs = now.getTime();

  // ── per-asset scoring inputs, resolved once ──
  // Cached per algorithm: an estate has thousands of assets and a handful of
  // distinct algorithms, and `resolve()` is the injectable seam a test swaps.
  const mappingCache = new Map<string, MappingResult | undefined>();
  const mappingFor = (algorithm: string) => {
    if (!mappingCache.has(algorithm)) mappingCache.set(algorithm, resolveAlgorithm(algorithm));
    return mappingCache.get(algorithm);
  };

  const scored: ScoredAsset[] = assets.map((row) => {
    const projectId = projectIdFromLocation(row.location);
    const project = projectId === null ? undefined : projectById.get(projectId);
    const lifetime = resolveSecrecyLifetime({
      assetClassification: row.dataClassification,
      assetSecrecyLifetimeYears: row.secrecyLifetimeYears,
      projectClassification: project?.dataClassification ?? null,
      projectSecrecyLifetimeYears: project?.secrecyLifetimeYears ?? null,
    });
    const mapping = mappingFor(row.algorithm);
    return {
      row,
      quantumVulnerable: mapping?.quantumVulnerable ?? false,
      mapped: mapping !== undefined,
      x: lifetime.years,
      xSource: lifetime.source,
      xAssumed: lifetime.assumed,
      xBasis: lifetime.basis,
      y: migrationYearsFromEffortHours(row.effortHours ?? 0),
    };
  });

  // ── estate roll-up ──
  const perProject = new Map<number, { id: number; name: string; assets: number; presentAssets: number }>();
  let unassociatedAssets = 0;
  for (const asset of scored) {
    const projectId = projectIdFromLocation(asset.row.location);
    const project = projectId === null ? undefined : projectById.get(projectId);
    if (project === undefined) {
      unassociatedAssets += 1;
      continue;
    }
    let entry = perProject.get(project.id);
    if (entry === undefined) {
      entry = { id: project.id, name: project.name, assets: 0, presentAssets: 0 };
      perProject.set(project.id, entry);
    }
    entry.assets += 1;
    if (presentAt(asset.row, nowMs)) entry.presentAssets += 1;
  }

  const estate: EstateRollup = {
    projects: [...perProject.values()].sort((a, b) => b.presentAssets - a.presentAssets || a.id - b.id),
    unassociatedAssets,
    totalAssets: scored.length,
    presentAssets: scored.filter((a) => presentAt(a.row, nowMs)).length,
  };

  // ── observed history ──
  // Completed runs only, collapsed to distinct instants. A whole scan is
  // written in one transaction, so several runs legitimately share a
  // millisecond; those are one examination of the estate, not several.
  const completed = runs.filter((r) => r.status === "completed");
  const failedRuns = runs.filter((r) => r.status === "failed").length;

  const byInstant = new Map<number, { runIds: number[]; surfaces: Set<string> }>();
  for (const run of completed) {
    const at = toMillis(run.completedAt ?? run.startedAt);
    if (Number.isNaN(at) || at > nowMs) continue; // a run stamped in the future is not history
    let entry = byInstant.get(at);
    if (entry === undefined) {
      entry = { runIds: [], surfaces: new Set() };
      byInstant.set(at, entry);
    }
    entry.runIds.push(run.id);
    entry.surfaces.add(run.surface);
  }

  const instants = [...byInstant.keys()].sort((a, b) => a - b);
  let previousKnown = 0;
  const observedPoints: ObservedPoint[] = instants.map((instantMs) => {
    const entry = byInstant.get(instantMs)!;
    const base = pointFor(scored, new Date(instantMs), scenarios);
    const assetsAdded = base.assetsKnown - previousKnown;
    previousKnown = base.assetsKnown;
    return {
      ...base,
      kind: "observed",
      collectionRunIds: entry.runIds.sort((a, b) => a - b),
      surfaces: [...entry.surfaces].sort(),
      assetsAdded,
    };
  });

  const spanDays =
    instants.length < 2 ? null : Math.round(((instants[instants.length - 1] - instants[0]) / MS_PER_DAY) * 10) / 10;

  const sufficientForTrend = instants.length >= 2;
  const reason = sufficientForTrend
    ? `${instants.length} collection instants span ${spanDays} days. Each point is one examination of the estate; the line steps between them because nothing was measured in between.`
    : instants.length === 1
      ? "One collection run. There is no history to draw — a line needs two measurements, and drawing one through a single point would assert a trend nobody has observed. Scan again to establish a second."
      : "Nothing has been collected yet, so there is no history and no posture to plot. This is an empty inventory, not a clean one.";

  const observed: ObservedHistory = {
    sufficientForTrend,
    reason,
    distinctCollectionInstants: instants.length,
    observedSpanDays: spanDays,
    firstObservedAt: instants.length === 0 ? null : new Date(instants[0]).toISOString(),
    lastObservedAt: instants.length === 0 ? null : new Date(instants[instants.length - 1]).toISOString(),
    completedRuns: completed.length,
    failedRuns,
    points: observedPoints,
  };

  // ── deadline markers, resolved from the standards data ──
  // Keyed so two algorithms sharing one rule produce one marker carrying both,
  // which is how a reader sees "everything that stops working on this date".
  const markers = new Map<string, DeadlineMarker>();
  const presentNow = scored.filter((a) => presentAt(a.row, nowMs));
  const algorithmCounts = new Map<string, number>();
  for (const asset of presentNow) {
    algorithmCounts.set(asset.row.algorithm, (algorithmCounts.get(asset.row.algorithm) ?? 0) + 1);
  }

  for (const [algorithm, count] of algorithmCounts) {
    const mapping = mappingFor(algorithm);
    if (mapping === undefined) continue;
    for (const obligation of mapping.obligations) {
      const deadline = obligation.deadline;
      if (deadline === undefined) continue;
      const effectiveFrom = effectiveFromOf(deadline);
      if (effectiveFrom === null) continue; // already binding, with no date to place

      const key = `${obligation.framework}|${deadline.type}|${effectiveFrom.toISOString()}|${deadline.appliesTo ?? ""}|${deadline.securityStrength ?? ""}`;
      let marker = markers.get(key);
      if (marker === undefined) {
        marker = {
          id: key,
          type: deadline.type,
          label: deadline.label,
          effect: deadline.effect,
          effectiveFrom: effectiveFrom.toISOString(),
          year: effectiveFrom.getUTCFullYear(),
          inEffect: effectiveFrom.getTime() <= nowMs,
          appliesTo: deadline.appliesTo ?? null,
          securityStrength: deadline.securityStrength ?? null,
          framework: obligation.framework,
          frameworkName: obligation.frameworkName ?? null,
          requirement: obligation.requirement,
          citation: obligation.citation,
          confidence: obligation.confidence,
          draftStatus: obligation.draftStatus ?? null,
          algorithms: [],
          assets: 0,
          caveats: [...obligation.caveats],
        };
        markers.set(key, marker);
      }
      if (!marker.algorithms.includes(mapping.algorithm)) marker.algorithms.push(mapping.algorithm);
      marker.assets += count;
    }
  }

  const deadlines = [...markers.values()]
    .map((m) => ({ ...m, algorithms: m.algorithms.sort() }))
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.framework.localeCompare(b.framework));

  // ── projected horizon ──
  // Not a forecast of the estate: the inventory is frozen at `now` and the same
  // arithmetic is evaluated forward, one point per calendar year. Every future
  // point is therefore an exact evaluation of a formula under a stated
  // assumption, which is a different kind of claim from a measurement — and
  // why it lives in its own branch with its own `kind`.
  const horizonYear = Math.max(
    now.getUTCFullYear(),
    ...scenarios.map((s) => s.qDayYear),
    ...deadlines.map((d) => d.year),
  );

  const projectedPoints: ProjectedPoint[] = [];
  for (let year = now.getUTCFullYear() + 1; year <= horizonYear; year += 1) {
    const at = new Date(Date.UTC(year, 0, 1));
    if (at.getTime() <= nowMs) continue;
    // Deliberately scored against the inventory as it stands *now*, not as it
    // stood at `at` — there is no inventory at a future date to read.
    const counts = countBreaches(presentNow, at, scenarios);
    projectedPoints.push({
      kind: "projected",
      year,
      at: at.toISOString(),
      assetsKnown: estate.totalAssets,
      assetsPresent: presentNow.length,
      pqcAssets: presentNow.filter((a) => a.quantumVulnerable).length,
      hygieneAssets: presentNow.filter((a) => a.mapped && !a.quantumVulnerable).length,
      unmappedAssets: presentNow.filter((a) => !a.mapped).length,
      breachedByScenario: counts,
    });
  }

  const projected: ProjectedHorizon = {
    assumption:
      "Projection, not measurement. It holds the inventory exactly as it stands today and advances only the clock, so it shows when today's assets fall out of compliance if nothing is migrated and nothing new is introduced. Neither of those will be true.",
    basisAt: now.toISOString(),
    points: projectedPoints,
  };

  // ── the inputs behind the verdicts ──
  const bySource: Record<string, number> = {};
  const bases = new Set<string>();
  for (const asset of presentNow) {
    bySource[asset.xSource] = (bySource[asset.xSource] ?? 0) + 1;
    bases.add(asset.xBasis);
  }

  const assetsWithRecordedEffort = presentNow.filter((a) => a.row.effortHours !== null).length;

  const inputs: PostureTimelineInputs = {
    secrecyLifetime: {
      bySource,
      assumedForAssets: presentNow.filter((a) => a.xAssumed).length,
      bases: [...bases].sort(),
    },
    migrationYears: {
      defaultValue: migrationYearsFromEffortHours(0),
      assetsWithRecordedEffort,
      basis:
        assetsWithRecordedEffort === 0
          ? "Y is zero for every asset: no collector records a migration effort estimate against an asset yet, so these verdicts are decided entirely by X against Z. A real Y can only move them earlier, never later."
          : `Y is derived from a recorded effort estimate for ${assetsWithRecordedEffort} of ${presentNow.length} assets; the rest contribute zero.`,
    },
  };

  return {
    generatedAt: new Date().toISOString(),
    now: now.toISOString(),
    framing: QDAY_FRAMING,
    scenarios: scenarios.map((s) => ({
      name: s.name,
      qDayYear: s.qDayYear,
      rationale: s.rationale,
      confidence: s.confidence,
    })),
    estate,
    observed,
    projected,
    deadlines,
    inputs,
    notCollected: [
      {
        id: "certificate-expiry",
        label: "Certificate expiry against Q-Day",
        reason:
          "Not available. A certificate's notAfter has nowhere to live in the asset model and no certificate collector has shipped, so no count of certificates outliving their cryptography can be produced. An estimate here would be invented.",
      },
      {
        id: "asset-refresh-cycle",
        label: "Renewal cycles remaining before each deadline",
        reason:
          "Not available. Nothing records how often an asset is refreshed, so the number of renewal cycles left before a deadline — the figure that goes negative for OT estates — cannot be computed from anything held.",
      },
    ],
  };
}
