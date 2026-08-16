import {
  surfaceLabel,
  buildAssumptions,
  buildCoverageLimitations,
  buildCostEstimate,
  buildHeader,
  buildTrend,
  effortHoursFor,
  page1Coverage,
  type Assumption,
  type CostEstimate,
  type CoverageLimitations,
  type Page1Coverage,
  type ReportHeader,
  type ReportInput,
  type TrendStatement,
} from "./report-common";
import { DEFAULT_QDAY_SCENARIOS, yearsUntilQDay } from "@workspace/risk";
import type { EnrichedInventoryAsset } from "./inventory-assets";

/**
 * E1 — the board / executive pack, computed.
 * docs/Claude/07-reports.md §"E1 — Board / executive pack".
 *
 * One page, then three appendices. The page answers exactly four questions —
 * are we exposed, how badly and by when, what will it cost, are we on track —
 * and it answers them for the *estate*, not for a scan. (`scanner.ts`'s
 * `generateExecutiveSummary()` still opens "We scanned N lines of python code",
 * which is the thing doc 07 says to stop doing; it is left alone here because
 * it is a scan-level summary and this is not.)
 *
 * **Page one names no algorithm.** doc 07: "Encryption that quantum computers
 * will break" beats "ECDH". That is not a style preference — the reader has
 * four minutes and no cryptography background, and a name they cannot evaluate
 * is a name they will take on trust or discount entirely. The rule is asserted
 * in `board-pack.test.ts` against every algorithm the input actually contains,
 * so it cannot rot as the vocabulary grows. The appendices name everything.
 *
 * **The coverage gap is on page one**, in `page1.coverage`, because that is
 * where the honest framing lives and it is also how a CISO gets budget for the
 * surfaces nobody has looked at. It is stated as surfaces out of the catalogue.
 * It is never stated as a share of the estate — see
 * `CoverageLimitations.estateFraction`.
 */

export interface ExposureAnswer {
  /** E1 question 1. One sentence, plain English, no algorithm names, no jargon. */
  headline: string;
  /** Present assets this document describes. Not an estate total. */
  assetsFound: number;
  /** Of those, how many carry cryptography a quantum computer is expected to break. */
  quantumVulnerableAssets: number;
  /** Of those, how many breach the inequality under at least one scenario. */
  assetsAlreadyTooLate: number;
  /**
   * Real cryptographic defects with no quantum content. Reported separately and
   * excluded from every number above — G-10, restated at board level.
   */
  classicalHygieneAssets: number;
  /** Assets whose algorithm the standards data does not know. Counted in nothing else. */
  unassessableAssets: number;
}

export interface ScenarioAnswer {
  scenario: string;
  qDayYear: number;
  /** How many assets are already too late under this scenario. */
  assetsBreached: number;
  /** The largest overshoot, in years, under this scenario. Null when nothing breaches. */
  worstOvershootYears: number | null;
  /** From the source data. Every scenario ships `needs-check` today, and that is shown. */
  confidence: string;
  rationale: string;
}

export interface TimingAnswer {
  /** E1 question 2, in one sentence. */
  headline: string;
  scenarios: ScenarioAnswer[];
  /** `QDAY_FRAMING`. These years are compliance deadlines, not physics. */
  framing: string;
}

export interface BoardPackAppendix {
  id: string;
  title: string;
  /** Shown under the title. States what the appendix is and is not. */
  summary: string;
  rows: Array<Record<string, string | number | null>>;
  columns: Array<{ key: string; label: string }>;
  notes: string[];
}

export interface BoardPack {
  kind: "board-pack";
  header: ReportHeader;
  page1: {
    exposure: ExposureAnswer;
    timing: TimingAnswer;
    cost: CostEstimate;
    trend: TrendStatement;
    /** The gap, on page one. Narrowed so no algorithm name can reach it — see `page1Coverage`. */
    coverage: Page1Coverage;
  };
  appendices: BoardPackAppendix[];
  assumptions: Assumption[];
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

function coverageClause(coverage: CoverageLimitations): string {
  return (
    `This covers ${coverage.examinedSurfaces} of ${coverage.totalSurfaces} places we know how to look, ` +
    `and says nothing about the ${coverage.unexaminedSurfaces.length} nobody has looked at`
  );
}

function buildExposure(assets: EnrichedInventoryAsset[], coverage: CoverageLimitations): ExposureAnswer {
  const quantumVulnerable = assets.filter((a) => a.mosca.applicable);
  const tooLate = quantumVulnerable.filter((a) => a.mosca.breachedScenarios.length > 0);
  const hygiene = assets.filter(
    (a) => a.compliance !== null && !a.compliance.countsTowardPostQuantumScore,
  );
  const unassessable = assets.filter((a) => a.compliance === null);

  let headline: string;
  if (assets.length === 0) {
    headline =
      `No cryptography has been recorded for this organisation yet, so this pack states nothing about exposure. ` +
      `${coverageClause(coverage)}.`;
  } else if (quantumVulnerable.length === 0) {
    headline =
      `Nothing found so far uses the kind of encryption a future quantum computer is expected to break. ` +
      `${coverageClause(coverage)}, so this is not yet a clean bill of health.`;
  } else if (tooLate.length === 0) {
    headline =
      `Yes — ${quantumVulnerable.length} ${plural(quantumVulnerable.length, "item")} of the encryption we have found ` +
      `${plural(quantumVulnerable.length, "is", "are")} of a kind a future quantum computer is expected to break, ` +
      `though on our current assumptions there is still time to replace ${plural(quantumVulnerable.length, "it", "them")}. ` +
      `${coverageClause(coverage)}.`;
  } else {
    headline =
      `Yes — ${quantumVulnerable.length} ${plural(quantumVulnerable.length, "item")} of the encryption we have found ` +
      `${plural(quantumVulnerable.length, "is", "are")} of a kind a future quantum computer is expected to break, and ` +
      `${tooLate.length} of ${plural(tooLate.length, "them", "them")} ${plural(tooLate.length, "protects", "protect")} ` +
      `information that has to stay secret for longer than we have left to replace it. ` +
      `${coverageClause(coverage)}.`;
  }

  return {
    headline,
    assetsFound: assets.length,
    quantumVulnerableAssets: quantumVulnerable.length,
    assetsAlreadyTooLate: tooLate.length,
    classicalHygieneAssets: hygiene.length,
    unassessableAssets: unassessable.length,
  };
}

function buildTiming(input: ReportInput, header: ReportHeader): TimingAnswer {
  const applicable = input.assets.filter((a) => a.mosca.applicable);

  // The typed scenario set, not `header.scenarios` — the header widens
  // `confidence` to `string` for the payload, and `yearsUntilQDay` wants the
  // real thing.
  const scenarioSet = input.scenarios ?? DEFAULT_QDAY_SCENARIOS;

  const scenarios: ScenarioAnswer[] = scenarioSet.map((scenario) => {
    const breached = applicable.filter((a) => a.mosca.breachedScenarios.includes(scenario.name));
    // The overshoot is (X + Y) − Z, in years, for the worst asset under this
    // scenario. Z comes from `@workspace/risk`'s own `yearsUntilQDay` rather
    // than a year-length constant spelled out again here — a second copy of it
    // would drift and put this table quietly out of step with every Mosca
    // verdict elsewhere in the product.
    const zYears = yearsUntilQDay(scenario, input.now);
    let worst: number | null = null;
    for (const asset of breached) {
      const overshoot = asset.mosca.x + asset.mosca.y - zYears;
      if (worst === null || overshoot > worst) worst = overshoot;
    }
    return {
      scenario: scenario.name,
      qDayYear: scenario.qDayYear,
      assetsBreached: breached.length,
      worstOvershootYears: worst === null ? null : Math.round(worst * 10) / 10,
      confidence: scenario.confidence,
      rationale: scenario.rationale,
    };
  });

  const anyBreach = scenarios.some((s) => s.assetsBreached > 0);
  const allBreach = scenarios.length > 0 && scenarios.every((s) => s.assetsBreached > 0);
  const earliest = scenarios.filter((s) => s.assetsBreached > 0).sort((a, b) => a.qDayYear - b.qDayYear)[0];

  let headline: string;
  if (applicable.length === 0) {
    headline = "Nothing found so far is of a kind these deadlines apply to, so no scenario produces a shortfall.";
  } else if (!anyBreach) {
    headline =
      `On our current assumptions, none of the three deadlines is missed: every affected item can be replaced ` +
      `before the information it protects stops needing protection.`;
  } else if (allBreach) {
    headline =
      `All three deadlines are missed. Under the earliest (${earliest.qDayYear}), ${earliest.assetsBreached} ` +
      `${plural(earliest.assetsBreached, "item")} ${plural(earliest.assetsBreached, "is", "are")} already too late — ` +
      `the information outlives the protection whichever date you argue from.`;
  } else {
    headline =
      `The earliest deadline (${earliest.qDayYear}) is already missed for ${earliest.assetsBreached} ` +
      `${plural(earliest.assetsBreached, "item")}; the later ones are not, on our current assumptions.`;
  }

  return { headline, scenarios, framing: header.framing };
}

function bySurfaceAppendix(input: ReportInput): BoardPackAppendix {
  const bySurface = new Map<string, { assets: number; vulnerable: number; breached: number; hours: number; unknownEffort: number }>();
  for (const asset of input.assets) {
    let entry = bySurface.get(asset.surface);
    if (entry === undefined) {
      entry = { assets: 0, vulnerable: 0, breached: 0, hours: 0, unknownEffort: 0 };
      bySurface.set(asset.surface, entry);
    }
    entry.assets += 1;
    if (!asset.mosca.applicable) continue;
    entry.vulnerable += 1;
    if (asset.mosca.breachedScenarios.length > 0) entry.breached += 1;
    const effort = effortHoursFor(asset);
    if (effort === null) entry.unknownEffort += 1;
    else entry.hours += effort.hours;
  }

  const rows = [...bySurface.entries()]
    .sort((a, b) => b[1].vulnerable - a[1].vulnerable || a[0].localeCompare(b[0]))
    .map(([surface, entry]) => ({
      surface: surfaceLabel(surface),
      assets: entry.assets,
      vulnerable: entry.vulnerable,
      breached: entry.breached,
      hours: Math.round(entry.hours * 10) / 10,
      unknownEffort: entry.unknownEffort,
    }));

  return {
    id: "a-where",
    title: "Appendix A — where it is",
    summary:
      "Every surface this inventory has evidence from, and how much of what was found on it is a post-quantum " +
      "problem rather than a classical one. A surface absent from this table has not been examined; see Appendix C.",
    columns: [
      { key: "surface", label: "Surface" },
      { key: "assets", label: "Items found" },
      { key: "vulnerable", label: "Quantum-vulnerable" },
      { key: "breached", label: "Already too late" },
      { key: "hours", label: "Est. hours" },
      { key: "unknownEffort", label: "No effort estimate" },
    ],
    rows,
    notes: [
      "Hours are the sum of per-asset effort estimates. Assets in the last column carry none and contribute nothing to the total rather than zero.",
      "Classical-hygiene defects are counted under \"Items found\" and excluded from \"Quantum-vulnerable\" — they are real work, on their own merits, not on a Q-Day deadline.",
    ],
  };
}

function byAlgorithmAppendix(input: ReportInput): BoardPackAppendix {
  const byAlgorithm = new Map<
    string,
    { assets: number; breached: number; track: string; hours: number; unknownEffort: number; replacement: string | null }
  >();
  for (const asset of input.assets) {
    let entry = byAlgorithm.get(asset.algorithm);
    if (entry === undefined) {
      entry = {
        assets: 0,
        breached: 0,
        track: asset.compliance === null ? "not in standards data" : asset.compliance.bucketLabel,
        hours: 0,
        unknownEffort: 0,
        replacement:
          asset.compliance?.obligations.find((o) => o.replacement !== undefined)?.replacement?.algorithm ?? null,
      };
      byAlgorithm.set(asset.algorithm, entry);
    }
    entry.assets += 1;
    if (asset.mosca.breachedScenarios.length > 0) entry.breached += 1;
    const effort = effortHoursFor(asset);
    if (effort === null) entry.unknownEffort += 1;
    else entry.hours += effort.hours;
  }

  return {
    id: "b-what",
    title: "Appendix B — what it is",
    summary:
      "The technical detail deliberately kept off page one. Grouping and replacement come from the standards data " +
      "at the version pinned in this document's header, not from anything stored against these rows.",
    columns: [
      { key: "algorithm", label: "Algorithm" },
      { key: "assets", label: "Items" },
      { key: "breached", label: "Already too late" },
      { key: "track", label: "Reported as" },
      { key: "replacement", label: "Recommended replacement" },
      { key: "hours", label: "Est. hours" },
    ],
    rows: [...byAlgorithm.entries()]
      .sort((a, b) => b[1].assets - a[1].assets || a[0].localeCompare(b[0]))
      .map(([algorithm, entry]) => ({
        algorithm,
        assets: entry.assets,
        breached: entry.breached,
        track: entry.track,
        replacement: entry.replacement,
        hours: Math.round(entry.hours * 10) / 10,
      })),
    notes: [
      "An algorithm with no recommended replacement here is one the standards data does not name one for, not one that needs no action.",
    ],
  };
}

function limitationsAppendix(input: ReportInput, coverage: CoverageLimitations): BoardPackAppendix {
  return {
    id: "c-limits",
    title: "Appendix C — what this pack does not cover",
    summary: coverage.statement,
    columns: [
      { key: "surface", label: "Surface" },
      { key: "status", label: "Catalogue status" },
      { key: "reason", label: "Why nothing is said about it" },
    ],
    rows: coverage.unexaminedSurfaces.map((s) => ({
      surface: s.name,
      status: s.catalogueStatus,
      reason: s.reason,
    })),
    notes: [
      coverage.estateFractionReason,
      ...coverage.caveats,
      `Collection provenance: ${
        input.runs.length === 0
          ? "no collection run has been recorded"
          : `${input.runs.length} run(s) across ${new Set(input.runs.map((r) => r.collector)).size} collector(s); versions are listed in the document header`
      }.`,
    ],
  };
}

export function summariseBoardPack(input: ReportInput): BoardPack {
  const coverage = buildCoverageLimitations(input);
  const header = buildHeader(input, coverage);
  const cost = buildCostEstimate(input);

  return {
    kind: "board-pack",
    header,
    page1: {
      exposure: buildExposure(input.assets, coverage),
      timing: buildTiming(input, header),
      cost,
      trend: buildTrend(input),
      coverage: page1Coverage(coverage),
    },
    appendices: [bySurfaceAppendix(input), byAlgorithmAppendix(input), limitationsAppendix(input, coverage)],
    assumptions: buildAssumptions(input, cost),
  };
}
