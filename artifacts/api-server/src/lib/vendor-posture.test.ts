import { describe, it, expect } from "vitest";
import {
  assessVendorPosture,
  VENDOR_ATTESTATION_CONFIDENCE,
  type AssessVendorPostureInput,
} from "./vendor-posture";

const CONSERVATIVE_SCENARIO = { name: "conservative" as const, qDayYear: 2030, rationale: "test", confidence: "needs-check" as const };
const AGGRESSIVE_SCENARIO = { name: "aggressive" as const, qDayYear: 2040, rationale: "test", confidence: "needs-check" as const };
const SCENARIOS = [CONSERVATIVE_SCENARIO, AGGRESSIVE_SCENARIO];

/** A vendor nobody has asked, or who has not replied — every field null. */
function unanswered(overrides: Partial<AssessVendorPostureInput> = {}): AssessVendorPostureInput {
  return {
    respondedAt: null,
    pqcRoadmapStatus: null,
    statedPqcReadyDate: null,
    cryptoDisclosed: null,
    contractPqcClause: null,
    contractRenewalDate: null,
    scenarios: SCENARIOS,
    ...overrides,
  };
}

describe("assessVendorPosture — a claim is not an observation", () => {
  it("stamps every answered assessment manual_attestation, below every collector's confidence", () => {
    const result = assessVendorPosture(
      unanswered({ respondedAt: new Date("2026-01-01T00:00:00Z"), pqcRoadmapStatus: "roadmap_published" }),
    );

    expect(result.attestation.discoveryModality).toBe("manual_attestation");
    expect(result.attestation.confidence).toBe(VENDOR_ATTESTATION_CONFIDENCE);
    // The anchors documented on `RawObservation.confidence`: regex 0.7, a
    // completed TLS handshake 1.0. A vendor's self-report must sit under both,
    // or the two are being presented with the same authority.
    expect(result.attestation.confidence!).toBeLessThan(0.7);
    expect(result.attestation.caveat).toMatch(/not.*verified|verified by/i);
  });

  it("gives an unanswered vendor no confidence at all — null, not a floor value", () => {
    const result = assessVendorPosture(unanswered());

    expect(result.responseState).toBe("awaiting_response");
    expect(result.answeredQuestionCount).toBe(0);
    // A floor confidence would be a claim about a claim that does not exist.
    expect(result.attestation.confidence).toBeNull();
    expect(result.attestation.caveat).toMatch(/has not answered/i);
  });

  it("counts only the vendor's own answers, so the customer's contract filing cannot fake a response", () => {
    const result = assessVendorPosture(
      unanswered({ contractPqcClause: "present", contractRenewalDate: new Date("2027-01-01T00:00:00Z") }),
    );

    // Both contract fields are supplied, and the vendor has still said nothing.
    expect(result.responseState).toBe("awaiting_response");
    expect(result.answeredQuestionCount).toBe(0);
    expect(result.clause.state).toBe("present");
  });

  it("does not tell the reader a vendor never answered when the register says they replied", () => {
    // Replied, disclosed nothing. Same absence of evidence as silence — so the
    // state and the null confidence are identical — but the customer-facing
    // caveat must not assert something the register itself contradicts, and a
    // refusal to disclose is a procurement fact worth reading.
    const refused = assessVendorPosture(unanswered({ respondedAt: new Date("2026-02-01T00:00:00Z") }));

    expect(refused.responseState).toBe("awaiting_response");
    expect(refused.attestation.confidence).toBeNull();
    expect(refused.respondedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(refused.attestation.caveat).toMatch(/responded and disclosed nothing/i);
    expect(refused.attestation.caveat).not.toMatch(/has not answered/i);
    // And a refusal is still not a clean result.
    expect(refused.attestation.caveat).not.toMatch(/\bcompliant\b/i);

    // Silence keeps the other wording.
    expect(assessVendorPosture(unanswered()).attestation.caveat).toMatch(/has not answered/i);
  });

  it("reports partial when the vendor answered some questions and not others", () => {
    const result = assessVendorPosture(unanswered({ pqcRoadmapStatus: "assessing" }));

    expect(result.responseState).toBe("partial");
    expect(result.answeredQuestionCount).toBe(1);
    expect(result.questionCount).toBe(3);
  });
});

describe("assessVendorPosture — an unanswered vendor is unknown, never compliant", () => {
  it("is unknown under every scenario when no PQC-ready date was given", () => {
    const result = assessVendorPosture(unanswered());

    expect(result.statedPqcReadyDate).toBeNull();
    expect(result.unknownScenarioCount).toBe(2);
    expect(result.exposedScenarioCount).toBe(0);
    for (const verdict of result.verdicts) {
      expect(verdict.state).toBe("unknown");
      // The narrative may say "not clear" while explaining the unknown state,
      // but must never assert the vendor *is* clear, ready or safe.
      expect(verdict.narrative).not.toMatch(/\bis clear\b/i);
      expect(verdict.narrative).not.toMatch(/\bsafe\b/i);
      expect(verdict.narrative).not.toMatch(/\bcompliant\b/i);
    }
  });

  it("stays unknown when the vendor says it has no plan — a status is not a date", () => {
    // "We have no roadmap" is an answer, and a bad one, but it is still not a
    // date. Inferring `exposed` from it would be manufacturing a commitment
    // the vendor never made; inferring `clear` would be worse.
    const result = assessVendorPosture(unanswered({ pqcRoadmapStatus: "none" }));

    expect(result.pqcRoadmapStatus).toBe("none");
    expect(result.unknownScenarioCount).toBe(2);
    expect(result.exposedScenarioCount).toBe(0);
    expect(result.verdicts[0].narrative).toMatch(/no post-quantum migration plan/i);
  });

  it("is exposed under a scenario whose Q-Day the vendor's own stated date falls after", () => {
    const result = assessVendorPosture(
      unanswered({ respondedAt: new Date("2026-01-01T00:00:00Z"), statedPqcReadyDate: new Date("2032-06-01T00:00:00Z") }),
    );

    const conservative = result.verdicts.find((v) => v.scenario === "conservative")!;
    const aggressive = result.verdicts.find((v) => v.scenario === "aggressive")!;

    expect(conservative.state).toBe("exposed");
    expect(aggressive.state).toBe("clear");
    expect(result.exposedScenarioCount).toBe(1);
    expect(result.unknownScenarioCount).toBe(0);
    // Even the good verdict is stated as the vendor's claim, not as a fact.
    expect(aggressive.narrative).toMatch(/vendor states/i);
    expect(aggressive.narrative).toMatch(/claim, not an observation/i);
  });

  it("never hardcodes a Q-Day year — a scenario change moves the verdict", () => {
    const input = unanswered({ statedPqcReadyDate: new Date("2032-06-01T00:00:00Z") });

    const withDefault = assessVendorPosture(input);
    const withLaterQDay = assessVendorPosture({
      ...input,
      scenarios: [{ ...CONSERVATIVE_SCENARIO, qDayYear: 2035 }],
    });

    expect(withDefault.verdicts.find((v) => v.scenario === "conservative")!.state).toBe("exposed");
    expect(withLaterQDay.verdicts[0].state).toBe("clear");
  });
});

describe("assessVendorPosture — 'no clause' and 'nobody looked' are different facts", () => {
  it("reads unknown, not absent, when nobody has read the contract", () => {
    const result = assessVendorPosture(unanswered());

    expect(result.clause.state).toBe("unknown");
    // The failure this asserts against: an unchecked contract rendered as a
    // finding. Unknown must not claim the clause is missing.
    expect(result.clause.narrative).toMatch(/has not been read/i);
    expect(result.clause.narrative).toMatch(/not the same as there being none/i);
    // And it is not a lever either way — `noLeverScheduled` is a claim about a
    // contract somebody actually read.
    expect(result.clause.noLeverScheduled).toBe(false);
  });

  it("reads absent, and says so as a finding, when the contract was read and has no clause", () => {
    const result = assessVendorPosture(unanswered({ contractPqcClause: "absent" }));

    expect(result.clause.state).toBe("absent");
    expect(result.clause.narrative).toMatch(/no contractual obligation to migrate/i);
    // No clause and no renewal date: no obligation and no scheduled moment at
    // which one could be created. That combination is the actionable one.
    expect(result.clause.noLeverScheduled).toBe(true);
  });

  it("does not call a missing clause leverless when a renewal is scheduled", () => {
    const result = assessVendorPosture(
      unanswered({ contractPqcClause: "absent", contractRenewalDate: new Date("2027-03-01T00:00:00Z") }),
    );

    expect(result.clause.noLeverScheduled).toBe(false);
    expect(result.clause.narrative).toMatch(/2027-03-01/);
  });

  it("treats an in-negotiation clause as not in force", () => {
    const result = assessVendorPosture(unanswered({ contractPqcClause: "in_negotiation" }));

    expect(result.clause.state).toBe("in_negotiation");
    expect(result.clause.narrative).toMatch(/not in force yet/i);
    expect(result.clause.noLeverScheduled).toBe(false);
  });

  it("carries the mandatory Q-Day framing on every assessment", () => {
    expect(assessVendorPosture(unanswered()).framing).toMatch(/regulatory deadlines/i);
  });
});
