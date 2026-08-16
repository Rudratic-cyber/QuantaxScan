import { describe, it, expect } from "vitest";
import { createMappingEngine, MappingVersionError } from "./engine";
import { defaultMappingData } from "./data";
import { parseMappingData, MappingDataError, type MappingData } from "./schema";
import { mappingEngine } from "./index";

/** A fixed resolution date, so no test depends on the wall clock. */
const ASOF = new Date("2026-08-13T00:00:00Z");

function clone(): MappingData {
  return JSON.parse(JSON.stringify(defaultMappingData)) as MappingData;
}

/** Rebuild the engine over an edited copy of the data — the same path a data PR takes. */
function engineOver(mutate: (data: MappingData) => void) {
  const data = clone();
  mutate(data);
  return createMappingEngine(parseMappingData(data.algorithms, data.frameworks));
}

describe("C1 acceptance — a standards-data update changes the answer with no code change", () => {
  it("moves RSA's disallowance date when only the JSON says so", () => {
    const before = mappingEngine.resolve({ algorithm: "RSA" }, { asOf: ASOF })!;
    expect(before.obligations.some((o) => o.deadline?.after === "2035")).toBe(true);
    expect(before.headline).toContain("2035");

    const after = engineOver((data) => {
      for (const deadline of data.algorithms.algorithms.find((a) => a.id === "rsa")!.deadlines) {
        if (deadline.after === "2035") deadline.after = "2040";
      }
    }).resolve({ algorithm: "RSA" }, { asOf: ASOF })!;

    expect(after.obligations.some((o) => o.deadline?.after === "2040")).toBe(true);
    expect(after.obligations.some((o) => o.deadline?.after === "2035")).toBe(false);
    expect(after.headline).toContain("2040");
    expect(after.headline).not.toContain("2035");
  });

  it("resolves an algorithm that did not exist when this file was written", () => {
    const engine = engineOver((data) => {
      data.algorithms.algorithms.push({
        id: "xmss-classical-placeholder",
        canonicalName: "EXAMPLE-SIG",
        aliases: ["ExampleSig"],
        family: "public-key",
        purposes: ["signature"],
        quantumVulnerable: true,
        replacements: [{ purpose: "signature", algorithm: "ML-DSA", standard: "FIPS 204" }],
        deadlines: [
          {
            framework: "NIST-IR-8547",
            type: "disallowed",
            after: "2031",
            appliesTo: "all signature use",
            confidence: "verified",
          },
        ],
        citation: { document: "Example Standard", url: "https://example.invalid", retrievedAt: "2026-08-13" },
        confidence: "verified",
      });
    });

    const result = engine.resolve({ algorithm: "ExampleSig" }, { asOf: ASOF })!;
    expect(result.algorithm).toBe("EXAMPLE-SIG");
    expect(result.bucket).toBe("pqc-migration");
    expect(result.headline).toContain("2031");
  });

  it("honours a new deadline-type term declared only in the data's own vocabulary block", () => {
    const engine = engineOver((data) => {
      data.algorithms.deadlineTypes["withdrawn"] = {
        label: "Withdrawn",
        effect: "prohibition",
        severity: "critical",
        definition: "Removed from the standard entirely.",
      };
      const rsa = data.algorithms.algorithms.find((a) => a.id === "rsa")!;
      rsa.deadlines.push({
        framework: "NIST-IR-8547",
        type: "withdrawn",
        since: "2026-01-01",
        appliesTo: "all uses",
        confidence: "verified",
      });
    });

    const result = engine.resolve({ algorithm: "RSA" }, { asOf: ASOF })!;
    expect(result.complianceStatus).toBe("immediate-failure");
    expect(result.headline).toContain("withdrawn");
  });

  it("degrades gracefully — an undeclared deadline type never manufactures a compliance failure", () => {
    const engine = engineOver((data) => {
      data.algorithms.algorithms.find((a) => a.id === "aes-ecb")!.deadlines.push({
        framework: "SP 800-38A",
        type: "some-future-term",
        appliesTo: "all uses",
        confidence: "verified",
      });
    });

    const result = engine.resolve({ algorithm: "AES-ECB" }, { asOf: ASOF })!;
    expect(result.complianceStatus).not.toBe("immediate-failure");
    expect(result.caveats.some((c) => c.includes("some-future-term"))).toBe(true);
  });
});

describe("purity and provenance", () => {
  it("is a pure function of (input, data, asOf)", () => {
    const a = mappingEngine.resolve({ algorithm: "RSA", confidence: 0.7 }, { asOf: ASOF });
    const b = mappingEngine.resolve({ algorithm: "RSA", confidence: 0.7 }, { asOf: ASOF });
    expect(a).toEqual(b);
  });

  it("stamps the data version that produced the answer", () => {
    const result = mappingEngine.resolve({ algorithm: "RSA" }, { asOf: ASOF })!;
    expect(result.dataVersion).toBe(defaultMappingData.algorithms.dataVersion);
    expect(result.asOf).toBe("2026-08-13");
  });

  it("refuses to answer for a data version it does not hold, rather than answering wrongly", () => {
    expect(() => mappingEngine.resolve({ algorithm: "RSA" }, { version: "0.0.1-not-loaded" })).toThrow(
      MappingVersionError,
    );
    expect(() =>
      mappingEngine.resolve({ algorithm: "RSA" }, { version: defaultMappingData.algorithms.dataVersion }),
    ).not.toThrow();
  });

  it("returns undefined for an unmapped algorithm instead of inventing standards data", () => {
    expect(mappingEngine.resolve({ algorithm: "Not A Real Algorithm" })).toBeUndefined();
  });

  it("rejects structurally malformed data at load", () => {
    expect(() => parseMappingData({ schemaVersion: "1.0.0" }, defaultMappingData.frameworks)).toThrow(MappingDataError);
  });
});

describe("PQC migration items keep their runway (RSA, ECDSA, ECDH, DH)", () => {
  it("files RSA as a migration item with both IR 8547 milestones", () => {
    const result = mappingEngine.resolve({ algorithm: "RSA" }, { asOf: ASOF })!;
    expect(result.bucket).toBe("pqc-migration");
    expect(result.complianceStatus).toBe("future-obligation");
    expect(result.riskTrack).toBe("post-quantum");
    expect(result.obligations.some((o) => o.deadline?.after === "2030" && o.deadline.type === "deprecated")).toBe(true);
    expect(result.obligations.some((o) => o.deadline?.after === "2035" && o.deadline.type === "disallowed")).toBe(true);
    expect(result.obligations.some((o) => o.replacement?.algorithm === "ML-KEM")).toBe(true);
  });

  it("labels every IR 8547 obligation as draft guidance", () => {
    const result = mappingEngine.resolve({ algorithm: "ECDSA" }, { asOf: ASOF })!;
    const ir8547 = result.obligations.filter((o) => o.framework === "NIST-IR-8547");
    expect(ir8547.length).toBeGreaterThan(0);
    for (const obligation of ir8547) expect(obligation.draftStatus).toMatch(/DRAFT/);
    expect(result.caveats.some((c) => c.includes("INITIAL PUBLIC DRAFT"))).toBe(true);
  });

  it("crosses into an immediate failure once the disallowance date passes", () => {
    const result = mappingEngine.resolve({ algorithm: "RSA" }, { asOf: new Date("2036-01-01T00:00:00Z") })!;
    expect(result.complianceStatus).toBe("immediate-failure");
    expect(result.bucket).toBe("immediate-compliance-failure");
  });

  it("does not let a larger key buy time — the 2035 date is the same at every strength", () => {
    const disallowed = mappingEngine
      .resolve({ algorithm: "RSA" }, { asOf: ASOF })!
      .obligations.filter((o) => o.deadline?.type === "disallowed");
    expect(disallowed.length).toBeGreaterThan(1);
    expect(new Set(disallowed.map((o) => o.deadline!.after))).toEqual(new Set(["2035"]));
  });
});

describe("C4 — IR 8547 is a ceiling, not a schedule (§4.2 / §4.1.2 / §3.2)", () => {
  const obligationsOf = (algorithm: string, id: string) =>
    mappingEngine
      .resolve({ algorithm }, { asOf: ASOF })!
      .obligations.filter((o) => o.framework === "NIST-IR-8547" && o.requirement.length > 0 && o.source === "framework" && idMatches(o.requirement, id));

  /** The engine does not surface rule ids, so match on the sentence each rule contributes. */
  function idMatches(requirement: string, id: string): boolean {
    if (id === "ceiling") return /Do not treat 2035 as the migration target/.test(requirement);
    if (id === "key-establishment") return /Migrate this key-establishment use ahead of the general timeline/.test(requirement);
    if (id === "hybrid") return /hybrid construction is an approved migration path/.test(requirement);
    throw new Error(`unknown rule id ${id}`);
  }

  it("tells a quantum-vulnerable finding that 2035 is not the target date", () => {
    const [ceiling] = obligationsOf("RSA", "ceiling");
    expect(ceiling).toBeDefined();
    expect(ceiling.citation.section).toMatch(/4\.2/);
    // The claim is only worth as much as the quote behind it.
    expect(ceiling.caveats.join(" ")).toMatch(/may specify earlier transitions/);
  });

  it("carries the draft label on every one of them, like the deadline rows already do", () => {
    for (const id of ["ceiling", "hybrid"] as const) {
      const [obligation] = obligationsOf("ECDSA", id);
      expect(obligation.draftStatus).toMatch(/DRAFT/);
      expect(obligation.confidence).toBe("verified");
    }
  });

  it("adds no deadline, so it cannot move a bucket or manufacture a failure", () => {
    const result = mappingEngine.resolve({ algorithm: "RSA" }, { asOf: ASOF })!;
    const added = result.obligations.filter((o) => o.source === "framework" && o.framework === "NIST-IR-8547");
    expect(added.length).toBeGreaterThan(0);
    for (const obligation of added) expect(obligation.deadline).toBeUndefined();
    expect(result.bucket).toBe("pqc-migration");
    expect(result.complianceStatus).toBe("future-obligation");
  });

  it("prioritises key establishment for the harvest-now-decrypt-later purpose, and only that purpose", () => {
    // RSA declares key-establishment among its purposes (IR 8547 Table 4, SP 800-56B); ECDSA does not.
    expect(obligationsOf("ECDH", "key-establishment")).toHaveLength(1);
    expect(obligationsOf("RSA", "key-establishment")).toHaveLength(1);
    expect(obligationsOf("ECDSA", "key-establishment")).toHaveLength(0);
    expect(obligationsOf("ECDH", "key-establishment")[0].severity).toBe("high");
    expect(obligationsOf("ECDH", "key-establishment")[0].caveats.join(" ")).toMatch(
      /before the classical schemes are generally disallowed/,
    );
  });

  it("offers the hybrid allowance without letting it read as compliance", () => {
    const [hybrid] = obligationsOf("ECDH", "hybrid");
    expect(hybrid.severity).toBe("informational");
    expect(hybrid.caveats.join(" ")).toMatch(/does not by itself satisfy/i);
    expect(hybrid.requirement.toLowerCase()).not.toMatch(/violat|non-compliant/);
  });

  it("leaves algorithms IR 8547 does not call quantum-vulnerable entirely alone", () => {
    const aes = mappingEngine.resolve({ algorithm: "AES-256" }, { asOf: ASOF })!;
    expect(aes.obligations.some((o) => o.framework === "NIST-IR-8547")).toBe(false);
    expect(aes.bucket).toBe("no-obligation");
  });

  it("claims no algorithm for the §4.1.3 112-bit symmetric row, because IR 8547 names none", () => {
    // The row is recorded on the framework so it is not lost, but attaching it to (say) 3DES or
    // SHA-224 would be an over-claim: IR 8547 says only "a few symmetric cryptography standards".
    for (const name of mappingEngine.listAlgorithms()) {
      const result = mappingEngine.resolve({ algorithm: name }, { asOf: ASOF })!;
      expect(result.obligations.some((o) => o.framework === "NIST-IR-8547" && o.deadline?.in === "2030")).toBe(false);
    }
  });

  it("follows the JSON — rewording the §4.2 rule changes the output with no code edit", () => {
    const engine = engineOver((data) => {
      const framework = data.frameworks.frameworks.find((f) => f.id === "NIST-IR-8547")!;
      const rule = framework.findingObligations.find((r) => r.id === "ir8547-2035-is-a-ceiling")!;
      rule.requirement = "REWORDED BY THE DATA, NOT THE ENGINE.";
      rule.severity = "critical";
    });

    const rewritten = engine
      .resolve({ algorithm: "RSA" }, { asOf: ASOF })!
      .obligations.find((o) => o.requirement === "REWORDED BY THE DATA, NOT THE ENGINE.")!;
    expect(rewritten.severity).toBe("critical");
    expect(rewritten.framework).toBe("NIST-IR-8547");
  });
});

describe("G-07 — DSA is a present-tense compliance failure, not a 2035 migration item", () => {
  const result = mappingEngine.resolve({ algorithm: "DSA", confidence: 0.7 }, { asOf: ASOF })!;

  it("buckets DSA away from PQC migration items", () => {
    expect(result.bucket).toBe("immediate-compliance-failure");
    expect(result.complianceStatus).toBe("immediate-failure");
    expect(mappingEngine.resolve({ algorithm: "RSA" }, { asOf: ASOF })!.bucket).not.toBe(result.bucket);
  });

  it("cites FIPS 186-5 and the 2023 date, and offers no 2035 runway", () => {
    const binding = result.obligations.find((o) => o.deadline?.type === "not-approved")!;
    expect(binding.framework).toBe("FIPS 186-5");
    expect(binding.deadline!.since).toBe("2023-02-03");
    expect(binding.deadline!.inEffect).toBe(true);
    expect(result.obligations.some((o) => o.deadline?.after === "2035")).toBe(false);
    expect(result.headline).not.toContain("2035");
  });

  it("keeps verification of pre-2023 signatures visible as permitted legacy use", () => {
    const permitted = result.useConditions.filter((u) => u.permitted);
    expect(permitted.length).toBe(1);
    expect(permitted[0].use).toMatch(/verification/i);
    expect(result.useDependent).toBe(true);
  });

  it("reduces confidence and asks for review, because a regex cannot see generation vs verification", () => {
    expect(result.detection.reviewRequired).toBe(true);
    expect(result.detection.multiplier).toBeLessThan(1);
    expect(result.detection.adjustedConfidence).toBeCloseTo(0.7 * result.detection.multiplier);
    expect(result.detection.reason).toMatch(/verification/i);
  });
});

describe("G-08 — SHA-1's answer depends on the use, and the copy must say so", () => {
  const result = mappingEngine.resolve({ algorithm: "SHA-1", confidence: 0.7 }, { asOf: ASOF })!;

  it("states which uses are disallowed rather than banning the algorithm", () => {
    expect(result.useDependent).toBe(true);
    expect(result.useConditions.length).toBe(3);
    const disallowed = result.useConditions.filter((u) => !u.permitted);
    expect(disallowed.length).toBe(1);
    expect(disallowed[0].use).toMatch(/signature GENERATION/i);
    expect(result.headline).toMatch(/signature GENERATION/i);
    expect(result.headline).toMatch(/other uses .* remain permitted/i);
  });

  it("keeps the NIST-acceptable non-signature use (HMAC-SHA1) marked as permitted", () => {
    const acceptable = result.useConditions.find((u) => u.status.toLowerCase() === "acceptable")!;
    expect(acceptable.permitted).toBe(true);
    expect(acceptable.use).toMatch(/collision resistance/i);
  });

  it("stays on the classical-hygiene track so it cannot inflate a PQC score", () => {
    expect(result.riskTrack).toBe("classical-hygiene");
    expect(result.quantumVulnerable).toBe(false);
    expect(result.reportingNote).toMatch(/separately from PQC/i);
  });

  it("reduces confidence pending review", () => {
    expect(result.detection.reviewRequired).toBe(true);
    expect(result.detection.adjustedConfidence).toBeLessThan(0.7);
  });
});

describe("G-09 — AES-ECB is a best-practice finding, not a NIST violation", () => {
  const result = mappingEngine.resolve({ algorithm: "AES-ECB" }, { asOf: ASOF })!;

  it("carries no compliance obligation at all", () => {
    expect(result.complianceStatus).toBe("no-obligation");
    expect(result.bucket).toBe("best-practice");
    expect(result.obligations.some((o) => o.deadline)).toBe(false);
  });

  it("never claims a standard is being violated", () => {
    for (const obligation of result.obligations) {
      expect(obligation.requirement.toLowerCase()).not.toMatch(/violat|non-compliant|prohibited/);
    }
    expect(result.headline).toMatch(/approved/i);
  });

  it("cites SP 800-38A — the document an auditor will actually check", () => {
    const bestPractice = result.obligations.find((o) => o.source === "algorithm-best-practice")!;
    expect(bestPractice.citation.document).toContain("800-38A");
    expect(bestPractice.caveats.join(" ")).toMatch(/NOT a NIST compliance requirement/i);
    // SP 800-38D may only appear as the recommended replacement, never as the authority breached.
    expect(bestPractice.requirement).toContain("AES-GCM");
  });
});

describe("applicability — frameworks that do not bind the customer are hidden, not shown at 0%", () => {
  it("omits CNSA 2.0 for a customer with no declared profile", () => {
    const result = mappingEngine.resolve({ algorithm: "RSA" }, { asOf: ASOF })!;
    expect(result.obligations.some((o) => o.framework === "CNSA-2.0")).toBe(false);
  });

  it("includes CNSA 2.0 for a US national security system, flagged unverified", () => {
    const result = mappingEngine.resolve(
      { algorithm: "RSA" },
      { asOf: ASOF, profile: { jurisdiction: "US", sector: "government", systemType: "national-security-system" } },
    )!;
    const cnsa = result.obligations.find((o) => o.framework === "CNSA-2.0")!;
    expect(cnsa.confidence).toBe("needs-check");
    expect(cnsa.caveats.join(" ")).toMatch(/NOT VERIFIED/i);
    expect(cnsa.caveats.join(" ")).toMatch(/PER SYSTEM CATEGORY/i);
  });

  it("always emits the universally-applicable CISA inventory obligation", () => {
    const result = mappingEngine.resolve({ algorithm: "MD5" }, { asOf: ASOF })!;
    expect(result.obligations.some((o) => o.framework === "CISA-QR")).toBe(true);
  });
});

describe("C5 — CNSA 2.0 resolves per purpose, and stays unverified while it does", () => {
  const NSS = { jurisdiction: "US", sector: "government", systemType: "national-security-system" };
  const cnsa = (algorithm: string) =>
    mappingEngine.resolve({ algorithm }, { asOf: ASOF, profile: NSS })!.obligations.filter((o) => o.framework === "CNSA-2.0");

  it("gives a signature finding the signature suite and a key-establishment finding the KEM", () => {
    const ecdsa = cnsa("ECDSA");
    expect(ecdsa).toHaveLength(1);
    expect(ecdsa[0].requirement).toContain("ML-DSA-87");
    expect(ecdsa[0].requirement).not.toContain("ML-KEM");

    const ecdh = cnsa("ECDH");
    expect(ecdh).toHaveLength(1);
    expect(ecdh[0].requirement).toContain("ML-KEM-1024");
    expect(ecdh[0].requirement).not.toContain("ML-DSA");
  });

  it("gives RSA both, because IR 8547 lists it under signatures AND key establishment", () => {
    expect(cnsa("RSA").map((o) => o.requirement).join(" ")).toMatch(/ML-DSA-87[\s\S]*ML-KEM-1024|ML-KEM-1024[\s\S]*ML-DSA-87/);
    expect(cnsa("RSA")).toHaveLength(2);
  });

  it("names LMS/XMSS only where CNSA 2.0 does — software and firmware signing", () => {
    expect(cnsa("ECDSA")[0].requirement).toMatch(/LMS or XMSS \(SP 800-208\)/);
    expect(cnsa("ECDH")[0].requirement).not.toMatch(/LMS|XMSS/);
  });

  it("reaches symmetric and hash findings without calling them a PQC migration item", () => {
    const aes = cnsa("AES-256");
    expect(aes).toHaveLength(1);
    expect(aes[0].requirement).toContain("AES-256");
    expect(aes[0].caveats.join(" ")).toMatch(/NOT quantum-vulnerable/);
    expect(aes[0].caveats.join(" ")).toMatch(/must not be counted toward a PQC score/);
    // The bucket is decided by deadlines, and CNSA contributes none — so AES stays where it was.
    expect(mappingEngine.resolve({ algorithm: "AES-256" }, { asOf: ASOF, profile: NSS })!.bucket).toBe("no-obligation");
    expect(cnsa("SHA-1")[0].requirement).toMatch(/SHA-384 or SHA-512/);
  });

  it("keeps every one of them needs-check and carries G-01 to each", () => {
    for (const algorithm of ["RSA", "ECDSA", "ECDH", "DH", "AES-256", "SHA-1", "MD5"]) {
      for (const obligation of cnsa(algorithm)) {
        expect(obligation.confidence).toBe("needs-check");
        expect(obligation.caveats.join(" ")).toMatch(/NOT VERIFIED AGAINST THE PRIMARY SOURCE/);
        expect(obligation.caveats.join(" ")).toMatch(/re-attempted 2026-08-16 and still 403/);
        expect(obligation.caveats.join(" ")).toMatch(/PER SYSTEM CATEGORY/);
      }
    }
  });

  it("dates no unverified claim — a needs-check citation carries no retrievedAt", () => {
    // `check:standards` measures the age of a `retrievedAt`; it cannot tell that one was written
    // for a document nobody opened. The only safe answer for a 403 source is to have no date.
    for (const obligation of cnsa("RSA")) {
      expect(obligation.citation.retrievedAt).toBeUndefined();
      expect(obligation.citation.document).toMatch(/NOT READ/);
    }
  });

  it("still disappears entirely for a customer who is not a US national security system", () => {
    const ukBank = { jurisdiction: "GB", sector: "financial-services", systemType: "payment-platform" };
    for (const algorithm of ["RSA", "ECDSA", "AES-256"]) {
      expect(
        mappingEngine.resolve({ algorithm }, { asOf: ASOF, profile: ukBank })!.obligations.some((o) => o.framework === "CNSA-2.0"),
      ).toBe(false);
    }
  });

  it("follows the JSON — promoting the confidence in a clone promotes it in the output", () => {
    // The shape of the eventual G-01 fix: a human reads the FAQ, edits JSON, and nothing else.
    const engine = engineOver((data) => {
      const framework = data.frameworks.frameworks.find((f) => f.id === "CNSA-2.0")!;
      for (const rule of framework.findingObligations) rule.confidence = "verified";
    });
    const promoted = engine
      .resolve({ algorithm: "ECDSA" }, { asOf: ASOF, profile: NSS })!
      .obligations.filter((o) => o.framework === "CNSA-2.0");
    expect(promoted).toHaveLength(1);
    expect(promoted[0].confidence).toBe("verified");
  });
});

describe("C6 — the CISA quantum-readiness roadmap, aligned section by section", () => {
  const cisa = (algorithm: string) =>
    mappingEngine.resolve({ algorithm }, { asOf: ASOF })!.obligations.filter((o) => o.framework === "CISA-QR");

  it("covers the four inventory-and-prioritisation instructions the factsheet actually gives", () => {
    const requirements = cisa("RSA").map((o) => o.requirement).join(" | ");
    expect(requirements).toMatch(/cryptographic inventory/i);
    expect(requirements).toMatch(/long secrecy lifetime/i);
    expect(requirements).toMatch(/risk assessment process/i);
    expect(requirements).toMatch(/industrial control system/i);
    expect(requirements).toMatch(/post-quantum roadmap/i);
  });

  it("cites the section each instruction is actually printed under", () => {
    const sectionOf = (fragment: RegExp) => cisa("RSA").find((o) => fragment.test(o.requirement))!.citation.section!;
    // Corrected 2026-08-16: the ICS/high-impact sentence is under SUPPLY CHAIN QUANTUM-READINESS,
    // not under PREPARE A CRYPTOGRAPHIC INVENTORY where it was previously grouped.
    expect(sectionOf(/industrial control system/i)).toBe("SUPPLY CHAIN QUANTUM-READINESS");
    expect(sectionOf(/risk assessment process/i)).toBe("PREPARE A CRYPTOGRAPHIC INVENTORY");
    expect(sectionOf(/post-quantum roadmap/i)).toBe("DISCUSS POST-QUANTUM ROADMAPS WITH TECHNOLOGY VENDORS");
    expect(sectionOf(/long secrecy lifetime/i)).toMatch(/WHY PREPARE NOW\?/);
  });

  it("puts the update path in scope for a signature algorithm, and only for one", () => {
    const updatePath = /software and firmware update path/i;
    expect(cisa("ECDSA").some((o) => updatePath.test(o.requirement))).toBe(true);
    expect(cisa("ECDH").some((o) => updatePath.test(o.requirement))).toBe(false);
  });

  it("carries the factsheet's own admission that discovery has blind spots", () => {
    const vendor = cisa("RSA").find((o) => /post-quantum roadmap/i.test(o.requirement))!;
    expect(vendor.caveats.join(" ")).toMatch(/may not be able to identify embedded cryptography/);
    expect(vendor.caveats.join(" ")).toMatch(/floor on vendor exposure/);
  });

  it("keeps the inventory instruction universal — it is the one obligation every finding gets", () => {
    for (const algorithm of ["RSA", "AES-256", "AES-ECB", "MD5", "SHA-1", "DSA"]) {
      expect(cisa(algorithm).some((o) => /cryptographic inventory/i.test(o.requirement))).toBe(true);
    }
    // ...and the quantum-vulnerable-only ones stay off a classical-hygiene finding.
    expect(cisa("MD5").some((o) => /industrial control system/i.test(o.requirement))).toBe(false);
  });

  it("adds no deadline, so a CISA obligation cannot change a bucket", () => {
    for (const obligation of cisa("RSA")) expect(obligation.deadline).toBeUndefined();
    expect(mappingEngine.resolve({ algorithm: "AES-256" }, { asOf: ASOF })!.bucket).toBe("no-obligation");
    expect(mappingEngine.resolve({ algorithm: "AES-ECB" }, { asOf: ASOF })!.bucket).toBe("best-practice");
  });

  it("never presents the factsheet's 2023 draft-standards language as current", () => {
    for (const obligation of cisa("RSA")) {
      expect(`${obligation.requirement} ${obligation.caveats.join(" ")}`).not.toMatch(/to be released in 2024|draft PQC standards/i);
    }
  });

  it("follows the JSON — a new section instruction becomes an obligation with no code edit", () => {
    const engine = engineOver((data) => {
      data.frameworks.frameworks
        .find((f) => f.id === "CISA-QR")!
        .findingObligations.push({
          id: "cisa-qr-example-future-section",
          match: { quantumVulnerable: true },
          requirement: "A section this file did not know about when the engine was written.",
          severity: "medium",
          citation: { document: "Example", url: "https://example.invalid", retrievedAt: "2026-08-16" },
          confidence: "verified",
        });
    });

    const added = engine
      .resolve({ algorithm: "RSA" }, { asOf: ASOF })!
      .obligations.filter((o) => o.framework === "CISA-QR");
    expect(added.some((o) => /did not know about/.test(o.requirement))).toBe(true);
    expect(added).toHaveLength(cisa("RSA").length + 1);
  });
});

describe("MD5 — never approved, so no transition deadline may be cited", () => {
  const result = mappingEngine.resolve({ algorithm: "MD5" }, { asOf: ASOF })!;

  it("is an immediate failure on the classical-hygiene track", () => {
    expect(result.bucket).toBe("immediate-compliance-failure");
    expect(result.riskTrack).toBe("classical-hygiene");
  });

  it("cites FIPS 180-4 and quotes no deadline year", () => {
    const binding = result.obligations.find((o) => o.deadline?.type === "never-approved")!;
    expect(binding.framework).toBe("FIPS 180-4");
    expect(binding.deadline!.after).toBeUndefined();
    expect(binding.deadline!.since).toBeUndefined();
  });
});

describe("AES — adequate, and the engine says so", () => {
  it("raises no obligation and no bucket that implies action", () => {
    const result = mappingEngine.resolve({ algorithm: "AES-256" }, { asOf: ASOF })!;
    expect(result.algorithm).toBe("AES");
    expect(result.bucket).toBe("no-obligation");
    expect(result.obligations.filter((o) => o.deadline).length).toBe(0);
  });
});


describe("G-05 — key size and the security-strength band the rule is keyed on", () => {
  const ir8547 = (r: { obligations: Array<{ framework: string; deadline?: { securityStrength?: string; after?: string } }> }) =>
    r.obligations.filter((o) => o.framework === "NIST-IR-8547" && o.deadline?.securityStrength);

  it("returns BOTH candidate obligations when the key size is undetermined", () => {
    // The register's requirement, verbatim: "Where it is genuinely undeterminable, emit
    // keySize: null and have the mapping engine return BOTH candidate obligations, flagged
    // as 'key size undetermined — assumed 112-bit'."
    const result = mappingEngine.resolve({ algorithm: "RSA" }, { asOf: ASOF })!;
    const strengths = new Set(ir8547(result).map((o) => o.deadline!.securityStrength));
    expect(strengths).toEqual(new Set(["112 bits", ">= 128 bits"]));
  });

  it("flags every one of them as assumed, naming the band and telling the reader to confirm", () => {
    const result = mappingEngine.resolve({ algorithm: "RSA", keySize: null }, { asOf: ASOF })!;
    for (const obligation of ir8547(result)) {
      expect(obligation.caveats.join(" ")).toMatch(/Key size undetermined — assumed 112 bits/);
      expect(obligation.caveats.join(" ")).toMatch(/Confirm the key size before acting/);
    }
  });

  it("narrows to the 112-bit band for RSA-2048, which is the one with the 2030 deadline", () => {
    const result = mappingEngine.resolve({ algorithm: "RSA", keySize: 2048 }, { asOf: ASOF })!;
    const rows = ir8547(result);
    expect(new Set(rows.map((o) => o.deadline!.securityStrength))).toEqual(new Set(["112 bits"]));
    // 2030 deprecation is the consequence that only applies to this band.
    expect(rows.some((o) => o.deadline!.after === "2030")).toBe(true);
    for (const row of rows) expect(row.caveats.join(" ")).not.toMatch(/undetermined/);
  });

  it("narrows to >= 128 bits for RSA-4096, and that band has no 2030 deprecation", () => {
    const rows = ir8547(mappingEngine.resolve({ algorithm: "RSA", keySize: 4096 }, { asOf: ASOF })!);
    expect(new Set(rows.map((o) => o.deadline!.securityStrength))).toEqual(new Set([">= 128 bits"]));
    expect(rows.some((o) => o.deadline!.after === "2030")).toBe(false);
    // ...but larger keys still buy no time past 2035, which is the data's own IMPORTANT note.
    expect(rows.some((o) => o.deadline!.after === "2035")).toBe(true);
  });

  it("reads a curve size against the curve range, not the modulus range", () => {
    // P-256 is 112-bit security. Reading 256 against the modulus range would have put it in
    // the <= 2048 band by luck; reading 384 there would silently mis-band it.
    expect(new Set(ir8547(mappingEngine.resolve({ algorithm: "ECDSA", keySize: 256 }, { asOf: ASOF })!).map((o) => o.deadline!.securityStrength)))
      .toEqual(new Set(["112 bits"]));
    expect(new Set(ir8547(mappingEngine.resolve({ algorithm: "ECDSA", keySize: 384 }, { asOf: ASOF })!).map((o) => o.deadline!.securityStrength)))
      .toEqual(new Set([">= 128 bits"]));
  });

  it("treats a size that falls in no band as undetermined rather than forcing it into one", () => {
    const rows = ir8547(mappingEngine.resolve({ algorithm: "RSA", keySize: 2560 }, { asOf: ASOF })!);
    expect(new Set(rows.map((o) => o.deadline!.securityStrength))).toEqual(
      new Set(["112 bits", ">= 128 bits"]),
    );
    expect(rows[0].caveats.join(" ")).toMatch(/undetermined/);
  });

  it("leaves an algorithm with no key size at all untouched by any of this", () => {
    // MD5 has no keySizeKind, so strength filtering must not apply and must not add a caveat.
    const result = mappingEngine.resolve({ algorithm: "MD5" }, { asOf: ASOF })!;
    expect(result.obligations.length).toBeGreaterThan(0);
    expect(result.obligations.flatMap((o) => o.caveats).join(" ")).not.toMatch(/Key size undetermined/);
  });

  it("G-24 — a finite-field DH modulus keeps its 2030 deprecation, and a curve of the same number does not", () => {
    // This test asserted the DEFECT until 2026-08-16, deliberately, so the fix
    // could not land silently. What it pinned: IR 8547 Table 4 lists Finite
    // Field DH/MQV and Elliptic Curve DH/MQV as separate families whose stated
    // parameter means different things — a modulus against a curve order —
    // while `algorithms.json` had one `ECDH/DH` entry with keySizeKind
    // "curve". So a 2048-bit MODP group was read against curveBits, missed the
    // 112-bit band {0,256}, matched `>= 128 bits` {384,100000}, and lost the
    // 2030 deprecation that actually applied. No error, no caveat.
    //
    // The entry is split now. 2048 means different things in the two, and the
    // pair below is the whole point: same number, different obligation.
    const ff = ir8547(mappingEngine.resolve({ algorithm: "DH", keySize: 2048 }, { asOf: ASOF })!);
    expect(new Set(ff.map((o) => o.deadline!.securityStrength))).toEqual(new Set(["112 bits"]));
    expect(ff.some((o) => o.deadline!.after === "2030")).toBe(true);

    const ec = ir8547(mappingEngine.resolve({ algorithm: "ECDH", keySize: 384 }, { asOf: ASOF })!);
    expect(new Set(ec.map((o) => o.deadline!.securityStrength))).toEqual(new Set([">= 128 bits"]));
    expect(ec.some((o) => o.deadline!.after === "2030")).toBe(false);

    // A token that names no group still yields no size, and the engine reports
    // both candidate bands as assumed rather than picking the generous one —
    // the G-05 answer, which the split does not change.
    const unsized = ir8547(mappingEngine.resolve({ algorithm: "DH" }, { asOf: ASOF })!);
    expect(unsized.flatMap((o) => o.caveats).join(" ")).toMatch(/undetermined/);
  });

  it("keys the bands off the data, so a revised band changes the answer with no code edit", () => {
    // The C1 acceptance criterion applied to G-05's addition: move the boundary in a clone and
    // the engine must follow. If this needs a TypeScript change, the band table is in the wrong place.
    const data = clone();
    const bands = (data.algorithms as unknown as {
      securityStrengthBands: { bands: Array<{ modulusBits?: { min: number; max: number } }> };
    }).securityStrengthBands.bands;
    bands[0].modulusBits = { min: 0, max: 4096 };
    bands[1].modulusBits = { min: 8192, max: 100000 };

    const rows = createMappingEngine(parseMappingData(data.algorithms, data.frameworks))
      .resolve({ algorithm: "RSA", keySize: 4096 }, { asOf: ASOF })!
      .obligations.filter((o) => o.framework === "NIST-IR-8547" && o.deadline?.securityStrength);

    expect(new Set(rows.map((o) => o.deadline!.securityStrength))).toEqual(new Set(["112 bits"]));
  });
});
