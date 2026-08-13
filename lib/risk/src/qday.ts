/**
 * Z — the Q-Day estimate, as a *set of scenarios* rather than a date.
 *
 * docs/Claude/01-strategy.md ("On Z, honestly"): nobody knows when Q-Day is,
 * and a product that asserts a single date is making a claim it cannot
 * defend. So the engine scores every asset against all three scenarios and
 * lets the customer decide which one they argue from — a CISO who can say
 * "we are exposed under all three" has a stronger case than one quoting a
 * vendor's number.
 *
 * These live here and not in `@workspace/collectors` (where the project's
 * other shared const tuples live, see AGENTS.md) for two reasons: nothing
 * here is persisted, so no `CHECK` constraint needs the tuple; and
 * `@workspace/collectors` is deliberately able to ship as a standalone
 * on-prem collector, which has no business knowing about risk scenarios.
 */

export const QDAY_SCENARIO_NAMES = ["conservative", "central", "aggressive"] as const;
export type QDayScenarioName = (typeof QDAY_SCENARIO_NAMES)[number];

export interface QDayScenario {
  name: QDayScenarioName;
  /** The calendar year the scenario places Q-Day in. Evaluated as 1 January of that year. */
  qDayYear: number;
  rationale: string;
  /**
   * Mirrors the `confidence` discipline used by `docs/Claude/mappings/*.json`.
   * All three are `needs-check` because 01-strategy.md marks them so — the
   * CNSA 2.0 half of the rationale is blocked on G-01.
   */
  confidence: "verified" | "needs-check";
}

/**
 * docs/Claude/01-strategy.md, "Default scenario set (customer-overridable)".
 * Customer-overridable is why every entry point takes `scenarios` as a
 * parameter — scenario *management* across an estate is the Enterprise half
 * of A4 (docs/Claude/10-editions.md), and it needs this to be data, not a
 * hardcoded branch.
 */
export const DEFAULT_QDAY_SCENARIOS: readonly QDayScenario[] = [
  {
    name: "conservative",
    qDayYear: 2030,
    rationale: "Aligns with the NIST IR 8547 draft deprecation of 112-bit classical cryptography.",
    confidence: "needs-check",
  },
  {
    name: "central",
    qDayYear: 2035,
    rationale: "Aligns with the NIST IR 8547 draft 'disallowed after' date and the CNSA 2.0 end state.",
    confidence: "needs-check",
  },
  {
    name: "aggressive",
    qDayYear: 2040,
    rationale: "Slower-than-expected quantum hardware scaling.",
    confidence: "needs-check",
  },
];

/**
 * The sentence that must accompany any scenario figure shown to a customer.
 * IR 8547 is an initial public draft and these years are compliance dates,
 * not predictions about physics — see `algorithms.json`'s `criticalCaveat`
 * for the same discipline applied to the algorithm data.
 */
export const QDAY_FRAMING =
  "Q-Day scenarios are regulatory deadlines drawn from draft NIST guidance (IR 8547 ipd) and CNSA 2.0, not predictions about when a quantum computer will exist. Compliance dates bind before physics does.";

const MS_PER_YEAR = 365.2425 * 24 * 60 * 60 * 1000;

/**
 * Z, in years from `now`. Deliberately allowed to go negative: once a
 * scenario's year has passed, "minus 1.2 years of runway" is the honest
 * reading, and clamping it to zero would quietly turn an overdue asset into
 * a merely-urgent one.
 */
export function yearsUntilQDay(scenario: QDayScenario, now: Date): number {
  return (Date.UTC(scenario.qDayYear, 0, 1) - now.getTime()) / MS_PER_YEAR;
}
