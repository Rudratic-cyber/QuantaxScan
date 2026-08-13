import { describe, expect, it } from "vitest";
import {
  assessMoscaRisk,
  migrationYearsFromEffortHours,
  DEFAULT_SECRECY_LIFETIME_YEARS,
  MIGRATION_HOURS_PER_CALENDAR_YEAR,
} from "./mosca";
import { DEFAULT_QDAY_SCENARIOS } from "./qday";

/**
 * `now` is pinned in every test here. Z is "years remaining", so an
 * un-injected clock would make these assertions mean something slightly
 * different every day and something very different every January.
 */
const NOW = new Date("2026-08-13T00:00:00Z");

describe("assessMoscaRisk — X + Y > Z, per scenario", () => {
  it("returns one verdict per Q-Day scenario and exposes all three inputs on each", () => {
    const assessment = assessMoscaRisk({ secrecyLifetimeYears: 7, migrationYears: 0.5, now: NOW });

    expect(assessment.verdicts).toHaveLength(3);
    expect(assessment.verdicts.map((v) => v.scenario)).toEqual(["conservative", "central", "aggressive"]);

    // A4's acceptance criterion is "the UI shows *why* — the three input
    // values, not just a number". Every verdict must carry them.
    for (const verdict of assessment.verdicts) {
      expect(verdict.x).toBe(7);
      expect(verdict.y).toBe(0.5);
      expect(typeof verdict.z).toBe("number");
      expect(verdict.narrative).toContain("X");
      expect(verdict.narrative).toContain("Y");
      expect(verdict.narrative).toContain("Z");
    }
  });

  it("computes Z from the injected clock, one figure per scenario year", () => {
    const assessment = assessMoscaRisk({ secrecyLifetimeYears: 1, migrationYears: 0, now: NOW });
    expect(assessment.verdicts.map((v) => ({ year: v.qDayYear, z: v.z }))).toEqual([
      { year: 2030, z: 3.4 },
      { year: 2035, z: 8.4 },
      { year: 2040, z: 13.4 },
    ]);
  });

  it("breaches every scenario when the secrecy lifetime outlives even the aggressive Q-Day", () => {
    // A 25-year secrecy lifetime is A3's "Regulated" preset: health records,
    // insurance, government.
    const assessment = assessMoscaRisk({ secrecyLifetimeYears: 25, migrationYears: 0.1, now: NOW });

    expect(assessment.breachedScenarioCount).toBe(3);
    expect(assessment.verdicts.every((v) => v.breached)).toBe(true);
    // Worst breach is the earliest Q-Day — least runway, largest margin.
    expect(assessment.worstBreach?.scenario).toBe("conservative");
    expect(assessment.worstBreach?.breachMarginYears).toBe(21.7);
    expect(assessment.worstBreach?.narrative).toContain("already too late");
  });

  it("breaches nothing when X + Y fits inside the nearest Q-Day", () => {
    const assessment = assessMoscaRisk({ secrecyLifetimeYears: 1, migrationYears: 0.1, now: NOW });

    expect(assessment.breachedScenarioCount).toBe(0);
    expect(assessment.worstBreach).toBeNull();
    expect(assessment.verdicts[0].breachMarginYears).toBeLessThan(0);
    expect(assessment.verdicts[0].narrative).toContain("within the migration window");
  });

  it("uses the architecture's sign convention: margin is (X + Y) - Z, negative is safe", () => {
    const assessment = assessMoscaRisk({ secrecyLifetimeYears: 4, migrationYears: 1, now: NOW });
    const conservative = assessment.verdicts[0];
    expect(conservative.breachMarginYears).toBeCloseTo(conservative.x + conservative.y - conservative.z, 1);
    expect(conservative.breached).toBe(conservative.breachMarginYears > 0);
  });

  it("marks an unsupplied X as an assumption rather than presenting it as fact", () => {
    const assumed = assessMoscaRisk({ migrationYears: 0, now: NOW });
    expect(assumed.x).toBe(DEFAULT_SECRECY_LIFETIME_YEARS);
    expect(assumed.secrecyLifetimeSource).toBe("assumed-default");

    // TODO(A3): once data classification lands, the caller supplies X per
    // asset and this becomes the exceptional path rather than the normal one.
    const provided = assessMoscaRisk({ secrecyLifetimeYears: 7, migrationYears: 0, now: NOW });
    expect(provided.secrecyLifetimeSource).toBe("provided");
  });

  it("does not apply the inequality to an asset with no quantum-vulnerable cryptography", () => {
    // Without this guard, a 50-year secrecy lifetime plus three MD5 findings
    // would report a Mosca breach caused by MD5 — G-10's error, relocated
    // from the score into the verdict.
    const assessment = assessMoscaRisk({
      secrecyLifetimeYears: 50,
      migrationYears: 2,
      hasQuantumVulnerableCrypto: false,
      now: NOW,
    });

    expect(assessment.applicable).toBe(false);
    expect(assessment.breachedScenarioCount).toBe(0);
    expect(assessment.y).toBe(0);
    expect(assessment.verdicts).toHaveLength(3);
    expect(assessment.verdicts[0].narrative).toContain("does not apply");
  });

  it("reports a Q-Day year that has already passed as negative runway rather than clamping it", () => {
    const assessment = assessMoscaRisk({
      secrecyLifetimeYears: 1,
      migrationYears: 0,
      now: new Date("2036-01-01T00:00:00Z"),
    });
    const conservative = assessment.verdicts[0];
    expect(conservative.z).toBeLessThan(0);
    expect(conservative.breached).toBe(true);
    expect(conservative.narrative).toContain("already");
  });

  it("carries the regulatory-deadline framing and each scenario's confidence, both needed before a customer sees a year", () => {
    const assessment = assessMoscaRisk({ migrationYears: 0, now: NOW });
    expect(assessment.framing).toMatch(/not predictions/);
    expect(assessment.verdicts.every((v) => v.scenarioConfidence === "needs-check")).toBe(true);
  });

  it("accepts customer-supplied scenarios instead of the defaults", () => {
    const assessment = assessMoscaRisk({
      secrecyLifetimeYears: 5,
      migrationYears: 0,
      now: NOW,
      scenarios: [{ ...DEFAULT_QDAY_SCENARIOS[1], qDayYear: 2028 }],
    });
    expect(assessment.scenarioCount).toBe(1);
    expect(assessment.verdicts[0].qDayYear).toBe(2028);
    expect(assessment.verdicts[0].breached).toBe(true);
  });
});

describe("migrationYearsFromEffortHours — Y", () => {
  it("converts effort hours to calendar years through the documented capacity constant", () => {
    expect(migrationYearsFromEffortHours(MIGRATION_HOURS_PER_CALENDAR_YEAR)).toBe(1);
    expect(migrationYearsFromEffortHours(500)).toBe(0.5);
  });

  it("returns zero for no effort rather than a floor", () => {
    expect(migrationYearsFromEffortHours(0)).toBe(0);
  });

  it("stretches Y for a low-agility asset (TODO(D5) supplies the real score)", () => {
    expect(migrationYearsFromEffortHours(1000, 0.5)).toBe(2);
    expect(migrationYearsFromEffortHours(1000, 1)).toBe(1);
  });
});
