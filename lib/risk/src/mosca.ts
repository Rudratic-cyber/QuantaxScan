import { DEFAULT_QDAY_SCENARIOS, QDAY_FRAMING, yearsUntilQDay, type QDayScenario, type QDayScenarioName } from "./qday";

/**
 * A4 — Mosca's inequality, split out of detection.
 *
 *     X + Y > Z  →  you are already too late.
 *
 *   X — how long this data must remain confidential
 *   Y — how long it will take to migrate this asset
 *   Z — time remaining until a cryptographically-relevant quantum computer
 *
 * docs/Claude/03-features.md §A4's acceptance criterion is not "returns a
 * number": it is "returns a verdict per Q-Day scenario, and the UI shows
 * *why* — the three input values, not just a number." So every verdict below
 * carries `x`, `y` and `z` alongside the boolean, and the module exports no
 * way to obtain a score without them.
 *
 * Shape follows docs/Claude/04-architecture.md §3 ("Split the risk engine
 * from detection"), including its sign convention: `breachMarginYears` is
 * `(X + Y) - Z`, so negative is safe and positive means the data outlives the
 * cryptography protecting it.
 */

/**
 * X, when nobody has told us. **TODO(A3):** data classification
 * (docs/Claude/03-features.md §A3) is the feature that supplies a real X per
 * asset, defaulting to a project-level setting and overridable per asset. It
 * is being built separately; until it lands, every caller that does not pass
 * `secrecyLifetimeYears` gets this value and the assessment reports
 * `secrecyLifetimeSource: "assumed-default"` so a report can mark it as an
 * assumption rather than presenting it as a customer-supplied fact (A3's own
 * acceptance criterion requires exactly that marking).
 *
 * 3 years is A3's "Internal" preset. Chosen because it is the *low* end of
 * the plausible range: defaulting to "Regulated" (25) would breach every
 * scenario for every customer and inflate the headline number, which is the
 * same class of error G-10 is about. An understated default that is labelled
 * as an assumption is recoverable; an overstated one is what loses the room.
 */
export const DEFAULT_SECRECY_LIFETIME_YEARS = 3;

/**
 * Y's conversion from effort hours to calendar years.
 *
 * **This is the least defensible number in the engine and it is a guess.**
 * It models one engineer able to give roughly half a 2,000-hour working year
 * to migration work. There is no source for it in `docs/Claude/`; the
 * architecture only says `Y = effortHours ÷ agilityScore`, which is a ratio,
 * not a unit conversion. It is exported and overridable per call so a
 * customer can substitute their own delivery capacity, and it should be
 * replaced by a real staffing input before Y is quoted to anyone.
 *
 * Practical consequence worth knowing when reading a verdict: at today's
 * `baseEffortHours` (4-8 hours per finding) Y is small next to X for anything
 * short of thousands of findings, so most verdicts are decided by X vs Z.
 */
export const MIGRATION_HOURS_PER_CALENDAR_YEAR = 1000;

/**
 * **TODO(D5):** crypto-agility scoring is unbuilt
 * (docs/Claude/03-features.md §D5), so Y is raw effort with no agility
 * divisor. docs/Claude/04-architecture.md §3: "Y is not just effort hours —
 * `effortHours ÷ agilityScore`; a low-agility asset takes disproportionately
 * longer than its raw hour count suggests." 1.0 is the neutral element, so
 * wiring D5 in later changes results without changing this signature.
 */
export const DEFAULT_AGILITY_SCORE = 1;

/** Y, in calendar years, from an effort estimate in hours. */
export function migrationYearsFromEffortHours(
  effortHours: number,
  agilityScore: number = DEFAULT_AGILITY_SCORE,
  hoursPerYear: number = MIGRATION_HOURS_PER_CALENDAR_YEAR,
): number {
  if (effortHours <= 0) return 0;
  const agility = agilityScore > 0 ? agilityScore : DEFAULT_AGILITY_SCORE;
  return effortHours / agility / hoursPerYear;
}

export interface MoscaInput {
  /** X, in years. Omit to accept `DEFAULT_SECRECY_LIFETIME_YEARS` — see the TODO(A3) on it. */
  secrecyLifetimeYears?: number;
  /** Y, in years. Use `migrationYearsFromEffortHours()` to derive it from an effort estimate. */
  migrationYears: number;
  /**
   * Whether the asset actually contains quantum-vulnerable cryptography.
   * Defaults to `true` because the normal case for this engine is assessing
   * a vulnerable asset. Pass `false` and every verdict comes back
   * not-breached with an explicit reason: the inequality asks when your data
   * outlives *the cryptography protecting it*, and if nothing quantum-
   * vulnerable is protecting it there is nothing for Q-Day to break. Without
   * this guard a hygiene-only scan with a long X would report a breach
   * caused by MD5 — the exact G-10 error, relocated.
   */
  hasQuantumVulnerableCrypto?: boolean;
  /** Injected so verdicts are reproducible. Defaults to the current time. */
  now?: Date;
  /** Customer-overridable; defaults to `DEFAULT_QDAY_SCENARIOS`. */
  scenarios?: readonly QDayScenario[];
}

export interface MoscaVerdict {
  scenario: QDayScenarioName;
  qDayYear: number;
  /** Secrecy lifetime, years. */
  x: number;
  /** Migration time, years. */
  y: number;
  /** Years remaining until this scenario's Q-Day. Negative once the year has passed. */
  z: number;
  breached: boolean;
  /** `(x + y) - z`. Negative = margin remaining. Positive = already too late, by this many years. */
  breachMarginYears: number;
  /** The board-deck sentence. Names all three inputs, per A4's acceptance criterion. */
  narrative: string;
  scenarioRationale: string;
  scenarioConfidence: QDayScenario["confidence"];
}

export interface MoscaAssessment {
  /** X as used, after defaulting. */
  x: number;
  /** Y as used. */
  y: number;
  /** Whether X was supplied by the caller or assumed. Reports must say which. */
  secrecyLifetimeSource: "provided" | "assumed-default";
  /** False when the asset carries no quantum-vulnerable cryptography; every verdict is then trivially not-breached. */
  applicable: boolean;
  evaluatedAt: string;
  verdicts: MoscaVerdict[];
  breachedScenarioCount: number;
  scenarioCount: number;
  /** The breached verdict with the largest margin, or `null` when nothing breaches. */
  worstBreach: MoscaVerdict | null;
  /** Mandatory framing for any customer-facing use of these years. */
  framing: string;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function narrate(
  scenario: QDayScenario,
  x: number,
  y: number,
  z: number,
  margin: number,
  breached: boolean,
  applicable: boolean,
  nowYear: number,
): string {
  const zPhrase =
    z >= 0
      ? `the ${scenario.name} scenario puts Q-Day at ${scenario.qDayYear}, ${round1(z)} years away`
      : `the ${scenario.name} scenario's Q-Day of ${scenario.qDayYear} is already ${round1(-z)} years past`;

  if (!applicable) {
    return `No quantum-vulnerable cryptography was detected, so Mosca's inequality does not apply: ${zPhrase}, and there is nothing here for it to break. Classical-hygiene findings, if any, are reported separately.`;
  }

  const inputs = `Data must stay confidential for ${round1(x)} years (X, to ${nowYear + Math.round(x)}); migration takes ${round1(y)} years (Y); ${zPhrase} (Z).`;

  return breached
    ? `${inputs} X + Y = ${round1(x + y)} exceeds Z by ${round1(margin)} years — this asset is already too late under the ${scenario.name} scenario.`
    : `${inputs} X + Y = ${round1(x + y)} is inside Z by ${round1(-margin)} years — this asset is within the migration window under the ${scenario.name} scenario.`;
}

/**
 * `(asset, X, Y, Z-scenario) -> verdict`, evaluated across every scenario at
 * once. Pure: no I/O, no clock read unless `now` is omitted.
 */
export function assessMoscaRisk(input: MoscaInput): MoscaAssessment {
  const now = input.now ?? new Date();
  const scenarios = input.scenarios ?? DEFAULT_QDAY_SCENARIOS;
  const applicable = input.hasQuantumVulnerableCrypto ?? true;

  const secrecyLifetimeSource = input.secrecyLifetimeYears === undefined ? "assumed-default" : "provided";
  const x = Math.max(0, input.secrecyLifetimeYears ?? DEFAULT_SECRECY_LIFETIME_YEARS);
  const y = Math.max(0, applicable ? input.migrationYears : 0);
  const nowYear = now.getUTCFullYear();

  const verdicts = scenarios.map((scenario): MoscaVerdict => {
    const z = yearsUntilQDay(scenario, now);
    const margin = x + y - z;
    const breached = applicable && margin > 0;
    return {
      scenario: scenario.name,
      qDayYear: scenario.qDayYear,
      x: round1(x),
      y: round1(y),
      z: round1(z),
      breached,
      breachMarginYears: round1(margin),
      narrative: narrate(scenario, x, y, z, margin, breached, applicable, nowYear),
      scenarioRationale: scenario.rationale,
      scenarioConfidence: scenario.confidence,
    };
  });

  const breachedVerdicts = verdicts.filter((v) => v.breached);
  const worstBreach = breachedVerdicts.reduce<MoscaVerdict | null>(
    (worst, v) => (worst === null || v.breachMarginYears > worst.breachMarginYears ? v : worst),
    null,
  );

  return {
    x: round1(x),
    y: round1(y),
    secrecyLifetimeSource,
    applicable,
    evaluatedAt: now.toISOString(),
    verdicts,
    breachedScenarioCount: breachedVerdicts.length,
    scenarioCount: verdicts.length,
    worstBreach,
    framing: QDAY_FRAMING,
  };
}
