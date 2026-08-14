import { DEFAULT_QDAY_SCENARIOS, QDAY_FRAMING, type QDayScenario, type QDayScenarioName } from "@workspace/risk";

/**
 * B8's payoff calculation: is a device fleet's replacement decision already
 * too late for a given Q-Day scenario?
 *
 * The register's whole point (docs/Claude/02-roadmap.md, "Phase 5 —
 * Long-lead surfaces") is that OT lead time is a hardware replacement cycle,
 * 7-15 years — so if the *next scheduled procurement* falls after a
 * scenario's Q-Day year, there is no replacement in flight that could have
 * swapped the fleet's cryptography out before that deadline. That fleet is
 * exposed under that scenario **by definition**, independent of what crypto
 * it actually runs: the decision window has already closed.
 *
 * This is deliberately a separate, simpler calculation from A4's Mosca
 * inequality (`assessMoscaRisk` in `@workspace/risk`), not a reuse of it.
 * Mosca answers "does X + Y exceed Z for a specific piece of detected
 * cryptography", which needs a secrecy lifetime and a migration-effort
 * estimate this register never collects. B8 answers a cruder but load-bearing
 * question — "will *any* replacement happen before Z at all" — from the one
 * fact a manual register reliably has: the next procurement date. Both reuse
 * the same `DEFAULT_QDAY_SCENARIOS` so neither ever hardcodes a Q-Day year.
 *
 * **Unknown is not safe.** A fleet with no recorded procurement date has an
 * `"unknown"` verdict under every scenario, never `"clear"` — nobody has
 * asserted a replacement is coming, so reporting one behind the scenes would
 * be the exact "guessed value that looks supplied" CLAUDE.md warns against.
 */

export type OtExposureState = "exposed" | "clear" | "unknown";

export interface OtExposureVerdict {
  scenario: QDayScenarioName;
  qDayYear: number;
  state: OtExposureState;
  narrative: string;
}

export interface OtExposureAssessment {
  /** Echoed back so a client never has to re-derive what was evaluated against. */
  nextProcurementDate: string | null;
  verdicts: OtExposureVerdict[];
  exposedScenarioCount: number;
  unknownScenarioCount: number;
  scenarioCount: number;
  framing: string;
}

function narrate(scenario: QDayScenario, state: OtExposureState, nextProcurementDate: Date | null): string {
  if (state === "unknown") {
    return (
      `No next procurement date is recorded for this fleet, so exposure under the ${scenario.name} ` +
      `scenario (Q-Day ${scenario.qDayYear}) is unknown — not clear. Record a date, even a tentative one, ` +
      `to get a real verdict.`
    );
  }

  const dateStr = nextProcurementDate!.toISOString().slice(0, 10);
  return state === "exposed"
    ? `The next procurement (${dateStr}) falls after the ${scenario.name} scenario's Q-Day of ` +
      `${scenario.qDayYear}. No replacement decision is scheduled before that deadline, so this fleet is ` +
      `already exposed under this scenario — the migration window has closed before it opened.`
    : `The next procurement (${dateStr}) falls before the ${scenario.name} scenario's Q-Day of ` +
      `${scenario.qDayYear}, so a replacement decision is scheduled in time to act under this scenario. ` +
      `This says nothing about whether that decision will actually replace the vulnerable cryptography — ` +
      `only that the window to do so has not yet closed.`;
}

export interface AssessOtExposureInput {
  /** Null when nobody has recorded a next procurement date for this fleet. */
  nextProcurementDate: Date | null;
  /** Customer-overridable; defaults to `DEFAULT_QDAY_SCENARIOS`. Never hardcode a scenario year. */
  scenarios?: readonly QDayScenario[];
}

export function assessOtExposure(input: AssessOtExposureInput): OtExposureAssessment {
  const scenarios = input.scenarios ?? DEFAULT_QDAY_SCENARIOS;
  const date = input.nextProcurementDate;

  const verdicts: OtExposureVerdict[] = scenarios.map((scenario) => {
    const qDayInstant = Date.UTC(scenario.qDayYear, 0, 1);
    const state: OtExposureState = date === null ? "unknown" : date.getTime() > qDayInstant ? "exposed" : "clear";
    return {
      scenario: scenario.name,
      qDayYear: scenario.qDayYear,
      state,
      narrative: narrate(scenario, state, date),
    };
  });

  return {
    nextProcurementDate: date?.toISOString() ?? null,
    verdicts,
    exposedScenarioCount: verdicts.filter((v) => v.state === "exposed").length,
    unknownScenarioCount: verdicts.filter((v) => v.state === "unknown").length,
    scenarioCount: verdicts.length,
    framing: QDAY_FRAMING,
  };
}
