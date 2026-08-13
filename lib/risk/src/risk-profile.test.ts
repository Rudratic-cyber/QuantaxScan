import { describe, expect, it } from "vitest";
import { computeRiskProfile } from "./risk-profile";
import { MAPPINGS_DATA_VERSION } from "@workspace/collectors";

const NOW = new Date("2026-08-13T00:00:00Z");

/** Effort hours as `algorithms.json` states them, so the fixtures match a real scan. */
const RSA = { algorithm: "RSA", effortHours: 4 };
const ECDSA = { algorithm: "ECDSA", effortHours: 4 };
const MD5 = { algorithm: "MD5", effortHours: 0.5 };
const SHA1 = { algorithm: "SHA-1", effortHours: 0.5 };
const AES_ECB = { algorithm: "AES-ECB", effortHours: 1 };

describe("computeRiskProfile — G-10 regression: hygiene findings must not inflate the PQC score", () => {
  it("scores a hygiene-only scan at zero post-quantum risk", () => {
    // The gap register's own example, minus the quantum half: MD5, SHA-1 and
    // AES-ECB in a ten-line file. Before A4 this scored non-zero purely
    // because `alertCount > 0` added 10 and the alert count fed the density
    // term. There is no post-quantum exposure here and the number must say so.
    const profile = computeRiskProfile([MD5, SHA1, AES_ECB], { totalLines: 10, now: NOW });

    expect(profile.pqc.riskScore).toBe(0);
    expect(profile.pqc.findingCount).toBe(0);
    expect(profile.pqc.effortHours).toBe(0);
    expect(profile.pqc.scoreComponents).toEqual({ detection: 0, moscaBreach: 0 });

    // Zero PQC risk is not "nothing found" — the findings are all still here.
    expect(profile.hygiene.findingCount).toBe(3);
    expect(profile.hygiene.effortHours).toBe(2);
    expect(profile.hygiene.countedTowardPqcRisk).toBe(false);
    expect(profile.hygiene.byAlgorithm.map((a) => a.algorithm).sort()).toEqual(["AES-ECB", "MD5", "SHA-1"]);
  });

  it("keeps a hygiene-only scan at zero even with a 50-year secrecy lifetime", () => {
    // The strongest form of the regression: nothing about the business
    // context of the data can make MD5 a post-quantum problem.
    const profile = computeRiskProfile([MD5, SHA1, AES_ECB], {
      totalLines: 10,
      secrecyLifetimeYears: 50,
      now: NOW,
    });

    expect(profile.pqc.riskScore).toBe(0);
    expect(profile.mosca.applicable).toBe(false);
    expect(profile.mosca.breachedScenarioCount).toBe(0);
    expect(profile.mosca.verdicts).toHaveLength(3);
  });

  it("attaches each hygiene algorithm's own reportingNote from algorithms.json to the panel", () => {
    const profile = computeRiskProfile([MD5, AES_ECB], { totalLines: 10, now: NOW });
    const notes = Object.fromEntries(profile.hygiene.byAlgorithm.map((a) => [a.algorithm, a.reportingNote]));

    expect(notes["MD5"]).toMatch(/MUST NOT count toward the post-quantum risk score/);
    // G-09: ECB is an approved NIST mode. The panel must not imply otherwise.
    expect(notes["AES-ECB"]).toMatch(/BEST-PRACTICE finding rather than a compliance finding/);
    expect(profile.hygiene.headline).toMatch(/G-10/);
  });

  it("derives the score from the quantum-vulnerable findings alone in a mixed scan", () => {
    // Same two RSA/ECDSA findings, with and without three hygiene findings
    // beside them in the same file. The post-quantum number must not move.
    const pqcOnly = computeRiskProfile([RSA, ECDSA], { totalLines: 10, now: NOW });
    const mixed = computeRiskProfile([RSA, ECDSA, MD5, SHA1, AES_ECB], { totalLines: 10, now: NOW });

    expect(mixed.pqc.riskScore).toBe(pqcOnly.pqc.riskScore);
    expect(mixed.pqc.findingCount).toBe(2);
    expect(mixed.pqc.effortHours).toBe(8);
    expect(mixed.hygiene.findingCount).toBe(3);
    expect(mixed.mosca.y).toBe(pqcOnly.mosca.y);
  });

  it("no longer lets a ten-line file with three hygiene findings reach the observed risk 100", () => {
    // docs/Claude/09-open-gaps.md G-10, the live smoke test: "a 10-line file
    // scored risk 100, 3 critical / 2 alert, where 2 of the 5 findings had
    // nothing to do with quantum computing."
    const profile = computeRiskProfile([RSA, ECDSA, { algorithm: "ECDH/DH", effortHours: 8 }, MD5, SHA1], {
      totalLines: 10,
      now: NOW,
    });

    expect(profile.pqc.findingCount).toBe(3);
    expect(profile.hygiene.findingCount).toBe(2);
    // Detection alone is capped at 60; the rest has to be earned by a real
    // Mosca breach, and at the assumed default X of 3 years there is none.
    expect(profile.pqc.riskScore).toBe(60);
    expect(profile.pqc.riskScore).toBeLessThan(100);
  });
});

describe("computeRiskProfile — the score is explainable", () => {
  it("splits the score into a detection component and a Mosca-breach component that sum to it", () => {
    const profile = computeRiskProfile([RSA], { totalLines: 1000, secrecyLifetimeYears: 25, now: NOW });

    expect(profile.mosca.breachedScenarioCount).toBe(3);
    expect(profile.pqc.scoreComponents.moscaBreach).toBe(40);
    expect(profile.pqc.scoreComponents.detection).toBe(3);
    expect(profile.pqc.riskScore).toBe(43);
  });

  it("scores the same crypto differently for differently-classified data — the whole point of A4", () => {
    // docs/Claude/01-strategy.md: "An RSA key protecting a public marketing
    // site and an RSA key protecting 30-year patient records score
    // identically today. That is the first thing a sophisticated buyer will
    // attack, and they will be right."
    const marketingSite = computeRiskProfile([RSA], { totalLines: 100, secrecyLifetimeYears: 0, now: NOW });
    const patientRecords = computeRiskProfile([RSA], { totalLines: 100, secrecyLifetimeYears: 25, now: NOW });

    expect(marketingSite.pqc.findingCount).toBe(patientRecords.pqc.findingCount);
    expect(patientRecords.pqc.riskScore).toBeGreaterThan(marketingSite.pqc.riskScore);
    expect(marketingSite.mosca.breachedScenarioCount).toBe(0);
    expect(patientRecords.mosca.breachedScenarioCount).toBe(3);
  });

  it("stamps the mappings dataVersion it derived from", () => {
    // Compared against the data, not a literal. The point of this assertion is that the profile
    // reports whichever version it actually read — pinning a number here just means the test
    // breaks every time the mappings are legitimately revised, which says nothing about the code.
    expect(computeRiskProfile([RSA], { totalLines: 10, now: NOW }).dataVersion)
      .toBe(MAPPINGS_DATA_VERSION);
  });

  it("names an unmapped algorithm instead of scoring it on either track", () => {
    const profile = computeRiskProfile([RSA, { algorithm: "Kryptonite", effortHours: 3 }], {
      totalLines: 10,
      now: NOW,
    });
    expect(profile.unmappedAlgorithms).toEqual(["Kryptonite"]);
    expect(profile.pqc.findingCount).toBe(1);
    expect(profile.hygiene.findingCount).toBe(0);
  });

  it("reports an algorithm the data calls adequate as neither exposure nor hygiene", () => {
    const profile = computeRiskProfile([{ algorithm: "AES", effortHours: 0 }], { totalLines: 10, now: NOW });
    expect(profile.acceptableAlgorithms).toEqual(["AES"]);
    expect(profile.pqc.riskScore).toBe(0);
    expect(profile.hygiene.findingCount).toBe(0);
  });

  it("produces an empty profile, not a crash, for a clean scan", () => {
    const profile = computeRiskProfile([], { totalLines: 500, now: NOW });
    expect(profile.pqc.riskScore).toBe(0);
    expect(profile.hygiene.findingCount).toBe(0);
    expect(profile.mosca.applicable).toBe(false);
  });
});
