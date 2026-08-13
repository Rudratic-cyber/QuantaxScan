import { deriveAlgorithmMapping, MAPPINGS_DATA_VERSION } from "@workspace/collectors";
import {
  assessMoscaRisk,
  migrationYearsFromEffortHours,
  DEFAULT_AGILITY_SCORE,
  type MoscaAssessment,
} from "./mosca";
import type { QDayScenario } from "./qday";
import { splitFindingsByTrack, type TrackableFinding } from "./tracks";

/**
 * The scan-level half of A4: take a set of findings and produce a
 * **post-quantum exposure score** plus a **separate classical-hygiene panel**,
 * with the Mosca verdicts that justify the score.
 *
 * This is what closes docs/Claude/09-open-gaps.md G-10. The observed bug was
 * a 10-line file scoring risk 100 with 3 of 5 findings unrelated to quantum
 * computing. The fix is not a weighting tweak — hygiene findings contribute
 * *nothing* to `pqc.riskScore`, and a scan with only hygiene findings scores
 * zero. They are not discarded either: they surface in `hygiene`, with each
 * algorithm's own `reportingNote` from `algorithms.json` attached, because
 * "MD5 is not a quantum problem" and "MD5 is fine" are different statements.
 */

/** The consultant rate the estimated-cost figures are built on. Unchanged from the pre-A4 scanner. */
export const CONSULTANT_HOURLY_RATE_USD = 500;

export interface AlgorithmBreakdownEntry {
  algorithm: string;
  count: number;
  effortHours: number;
  /** `algorithms.json`'s own qualification. The panel should print it verbatim; it is why this finding is being reported the way it is. */
  reportingNote: string | null;
  nistReplacement: string | null;
  nistStandard: string | null;
  citation: { document: string; url: string } | null;
}

export interface PqcExposure {
  /**
   * 0-100. **Zero when no quantum-vulnerable algorithm was detected**,
   * whatever else the scan found.
   */
  riskScore: number;
  findingCount: number;
  effortHours: number;
  estimatedCost: number;
  byAlgorithm: AlgorithmBreakdownEntry[];
  /**
   * The two halves of `riskScore`, exposed so the UI can explain it. A score
   * that cannot be decomposed is the thing A4 exists to replace.
   */
  scoreComponents: {
    /** 0-60. How much quantum-vulnerable cryptography, relative to how much code was looked at. */
    detection: number;
    /** 0-40. How many Q-Day scenarios the Mosca inequality is breached under. */
    moscaBreach: number;
  };
}

export interface HygieneSummary {
  findingCount: number;
  effortHours: number;
  estimatedCost: number;
  byAlgorithm: AlgorithmBreakdownEntry[];
  /** Structural, not decorative: an assertion in the payload that these did not move the PQC number. */
  countedTowardPqcRisk: false;
  headline: string;
}

export interface RiskProfile {
  pqc: PqcExposure;
  hygiene: HygieneSummary;
  mosca: MoscaAssessment;
  /**
   * Algorithms with no entry in `algorithms.json`. Scored on neither track
   * and named here rather than silently bucketed — see `tracks.ts`.
   */
  unmappedAlgorithms: string[];
  /**
   * Algorithms the mappings data says are adequate as they stand (no
   * recommended replacement) — reported so nothing detected disappears
   * without a mention, but scored on neither track.
   */
  acceptableAlgorithms: string[];
  /** Which `algorithms.json` snapshot produced this profile. */
  dataVersion: string;
}

export interface RiskProfileOptions {
  /** Denominator for the detection component. */
  totalLines: number;
  /** X. Omit for the documented default — see `DEFAULT_SECRECY_LIFETIME_YEARS` and its TODO(A3). */
  secrecyLifetimeYears?: number;
  /** TODO(D5). */
  agilityScore?: number;
  /** Injected for reproducibility. */
  now?: Date;
  scenarios?: readonly QDayScenario[];
  hourlyRate?: number;
}

const MAX_DETECTION_COMPONENT = 60;
const MAX_MOSCA_COMPONENT = 40;

const HYGIENE_HEADLINE =
  "Classical hygiene — real cryptographic defects with no post-quantum content. Excluded from the PQC exposure score by design (docs/Claude/09-open-gaps.md G-10); fix them on their own merits, not on a Q-Day deadline.";

function breakdown<T extends TrackableFinding>(findings: readonly T[]): AlgorithmBreakdownEntry[] {
  const byName = new Map<string, AlgorithmBreakdownEntry>();
  for (const finding of findings) {
    let entry = byName.get(finding.algorithm);
    if (!entry) {
      const mapping = deriveAlgorithmMapping(finding.algorithm);
      entry = {
        algorithm: finding.algorithm,
        count: 0,
        effortHours: 0,
        reportingNote: mapping?.reportingNote ?? null,
        nistReplacement: mapping?.nistReplacement ?? null,
        nistStandard: mapping?.nistStandard ?? null,
        citation: mapping?.citation ?? null,
      };
      byName.set(finding.algorithm, entry);
    }
    entry.count += 1;
    entry.effortHours += finding.effortHours;
  }
  return [...byName.values()].sort((a, b) => b.count - a.count || a.algorithm.localeCompare(b.algorithm));
}

function sumEffort(findings: readonly TrackableFinding[]): number {
  return findings.reduce((total, f) => total + f.effortHours, 0);
}

export function computeRiskProfile<T extends TrackableFinding>(
  findings: readonly T[],
  options: RiskProfileOptions,
): RiskProfile {
  const { totalLines, secrecyLifetimeYears, agilityScore = DEFAULT_AGILITY_SCORE, now, scenarios } = options;
  const hourlyRate = options.hourlyRate ?? CONSULTANT_HOURLY_RATE_USD;

  const split = splitFindingsByTrack(findings);
  const pqcEffortHours = sumEffort(split.pqc);
  const hygieneEffortHours = sumEffort(split.hygiene);

  const mosca = assessMoscaRisk({
    secrecyLifetimeYears,
    migrationYears: migrationYearsFromEffortHours(pqcEffortHours, agilityScore),
    hasQuantumVulnerableCrypto: split.pqc.length > 0,
    now,
    scenarios,
  });

  // Density, on the same shape as the pre-A4 formula (weight 3 per critical
  // finding, per thousand lines) but counting *only* the post-quantum track,
  // and capped so that detection alone can never assert the maximum score —
  // the remaining 40 has to be earned by an actual Mosca breach.
  const detection =
    split.pqc.length === 0
      ? 0
      : Math.min(MAX_DETECTION_COMPONENT, Math.round(((split.pqc.length * 3) / Math.max(1, totalLines)) * 1000));

  const moscaBreach =
    split.pqc.length === 0 || mosca.scenarioCount === 0
      ? 0
      : Math.round((MAX_MOSCA_COMPONENT * mosca.breachedScenarioCount) / mosca.scenarioCount);

  const riskScore = split.pqc.length === 0 ? 0 : Math.min(100, detection + moscaBreach);

  return {
    pqc: {
      riskScore,
      findingCount: split.pqc.length,
      effortHours: pqcEffortHours,
      estimatedCost: Math.round(pqcEffortHours * hourlyRate),
      byAlgorithm: breakdown(split.pqc),
      scoreComponents: { detection, moscaBreach },
    },
    hygiene: {
      findingCount: split.hygiene.length,
      effortHours: hygieneEffortHours,
      estimatedCost: Math.round(hygieneEffortHours * hourlyRate),
      byAlgorithm: breakdown(split.hygiene),
      countedTowardPqcRisk: false,
      headline: HYGIENE_HEADLINE,
    },
    mosca,
    unmappedAlgorithms: [...new Set(split.unmapped.map((f) => f.algorithm))].sort(),
    acceptableAlgorithms: [...new Set(split.acceptable.map((f) => f.algorithm))].sort(),
    dataVersion: MAPPINGS_DATA_VERSION,
  };
}
