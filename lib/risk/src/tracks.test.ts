import { describe, expect, it } from "vitest";
import { classifyRiskTrack, splitFindingsByTrack } from "./tracks";

describe("classifyRiskTrack — the G-10 split, derived from algorithms.json", () => {
  it("puts every quantum-vulnerable algorithm on the pqc track", () => {
    for (const algorithm of ["RSA", "ECDSA", "ECDH/DH", "DSA", "EdDSA"]) {
      expect(classifyRiskTrack(algorithm).track, algorithm).toBe("pqc");
    }
  });

  it("puts exactly the three non-quantum detection patterns on the hygiene track", () => {
    // docs/Claude/09-open-gaps.md G-10: "Three of the seven detection
    // patterns — MD5, SHA-1, AES-ECB — are not quantum vulnerabilities."
    for (const algorithm of ["MD5", "SHA-1", "AES-ECB"]) {
      expect(classifyRiskTrack(algorithm).track, algorithm).toBe("hygiene");
    }
  });

  it("reports an algorithm the mappings data says needs no replacement as acceptable, not as a hygiene defect", () => {
    // Plain AES: quantumVulnerable false, replacements empty. Its own
    // reportingNote says "DO NOT flag AES-128 as quantum-critical ...
    // flagging it inflates the risk score". No source pattern detects it
    // today, so this guards the classifier against a future one.
    expect(classifyRiskTrack("AES").track).toBe("acceptable");
  });

  it("refuses to guess a track for an algorithm absent from the mappings data", () => {
    const classification = classifyRiskTrack("Not A Real Algorithm");
    expect(classification.track).toBe("unmapped");
    expect(classification.mapping).toBeNull();
  });

  it("carries each hygiene algorithm's own reportingNote through, rather than restating it here", () => {
    expect(classifyRiskTrack("MD5").reportingNote).toMatch(/MUST NOT count toward the post-quantum risk score/);
    expect(classifyRiskTrack("AES-ECB").reportingNote).toMatch(/BEST-PRACTICE finding rather than a compliance finding/);
    // DSA is quantum-vulnerable AND carries a note demanding different
    // treatment. It stays on the pqc track (its note is G-07's job, which
    // the register places downstream of A4) but the note must survive so
    // G-07 has something to act on.
    const dsa = classifyRiskTrack("DSA");
    expect(dsa.track).toBe("pqc");
    expect(dsa.reportingNote).toMatch(/REPORT DIFFERENTLY FROM RSA\/ECDSA/);
  });
});

describe("splitFindingsByTrack", () => {
  it("partitions findings without losing or duplicating any", () => {
    const findings = [
      { algorithm: "RSA", effortHours: 4 },
      { algorithm: "MD5", effortHours: 0.5 },
      { algorithm: "SHA-1", effortHours: 0.5 },
      { algorithm: "Wat", effortHours: 1 },
    ];
    const split = splitFindingsByTrack(findings);
    expect(split.pqc).toHaveLength(1);
    expect(split.hygiene).toHaveLength(2);
    expect(split.unmapped).toHaveLength(1);
    expect(split.acceptable).toHaveLength(0);
    expect(split.pqc.length + split.hygiene.length + split.unmapped.length + split.acceptable.length).toBe(
      findings.length,
    );
  });
});
