import { describe, it, expect } from "vitest";
import { assessOtExposure } from "./ot-exposure";

const CONSERVATIVE_SCENARIO = { name: "conservative" as const, qDayYear: 2030, rationale: "test", confidence: "needs-check" as const };
const AGGRESSIVE_SCENARIO = { name: "aggressive" as const, qDayYear: 2040, rationale: "test", confidence: "needs-check" as const };
const SCENARIOS = [CONSERVATIVE_SCENARIO, AGGRESSIVE_SCENARIO];

describe("assessOtExposure — B8's payoff calculation", () => {
  it("reads as unknown, not clear, when no procurement date is recorded", () => {
    const result = assessOtExposure({ nextProcurementDate: null, scenarios: SCENARIOS });

    expect(result.nextProcurementDate).toBeNull();
    expect(result.unknownScenarioCount).toBe(2);
    expect(result.exposedScenarioCount).toBe(0);
    for (const verdict of result.verdicts) {
      expect(verdict.state).toBe("unknown");
      // The narrative may say "not clear" as part of explaining the unknown
      // state, but must never assert the fleet *is* clear or safe.
      expect(verdict.narrative).not.toMatch(/\bis clear\b/i);
      expect(verdict.narrative).not.toMatch(/\bsafe\b/i);
    }
  });

  it("is exposed under a scenario whose Q-Day the next procurement falls after", () => {
    const result = assessOtExposure({
      nextProcurementDate: new Date("2032-01-01T00:00:00Z"),
      scenarios: SCENARIOS,
    });

    const conservative = result.verdicts.find((v) => v.scenario === "conservative")!;
    const aggressive = result.verdicts.find((v) => v.scenario === "aggressive")!;

    // 2032 is after the conservative scenario's 2030 Q-Day — the replacement
    // decision has already been missed under that scenario.
    expect(conservative.state).toBe("exposed");
    // 2032 is before the aggressive scenario's 2040 Q-Day.
    expect(aggressive.state).toBe("clear");
    expect(result.exposedScenarioCount).toBe(1);
    expect(result.unknownScenarioCount).toBe(0);
  });

  it("is clear under every scenario when the next procurement precedes all of them", () => {
    const result = assessOtExposure({
      nextProcurementDate: new Date("2027-01-01T00:00:00Z"),
      scenarios: SCENARIOS,
    });

    expect(result.verdicts.every((v) => v.state === "clear")).toBe(true);
    expect(result.exposedScenarioCount).toBe(0);
  });

  it("never hardcodes a scenario year — a caller-supplied scenario set changes the verdict", () => {
    const nearTermOnly = [{ name: "conservative" as const, qDayYear: 2026, rationale: "test", confidence: "needs-check" as const }];
    const result = assessOtExposure({
      nextProcurementDate: new Date("2030-01-01T00:00:00Z"),
      scenarios: nearTermOnly,
    });
    expect(result.scenarioCount).toBe(1);
    expect(result.verdicts[0].state).toBe("exposed");
  });

  it("defaults to DEFAULT_QDAY_SCENARIOS when none is supplied", () => {
    const result = assessOtExposure({ nextProcurementDate: null });
    expect(result.scenarioCount).toBeGreaterThanOrEqual(3);
  });
});
