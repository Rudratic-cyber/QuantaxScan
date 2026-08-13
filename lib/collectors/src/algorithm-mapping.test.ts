import { describe, expect, it } from "vitest";
import { deriveAlgorithmMapping } from "./algorithm-mapping";
import { SOURCE_PATTERN_ALGORITHMS } from "./source-regex-collector";
import { CRYPTO_PACKAGE_ALGORITHMS } from "./crypto-packages";

describe("deriveAlgorithmMapping — read-time derivation from docs/Claude/mappings/algorithms.json", () => {
  it("reproduces the pre-refactor scanner.ts severities exactly (quantumVulnerable -> critical, else alert)", () => {
    expect(deriveAlgorithmMapping("RSA")?.severity).toBe("critical");
    expect(deriveAlgorithmMapping("ECDSA")?.severity).toBe("critical");
    expect(deriveAlgorithmMapping("ECDH/DH")?.severity).toBe("critical");
    expect(deriveAlgorithmMapping("DSA")?.severity).toBe("critical");
    expect(deriveAlgorithmMapping("MD5")?.severity).toBe("alert");
    expect(deriveAlgorithmMapping("SHA-1")?.severity).toBe("alert");
    expect(deriveAlgorithmMapping("AES-ECB")?.severity).toBe("alert");
  });

  it("reproduces the pre-refactor scanner.ts baseEffortHours exactly", () => {
    expect(deriveAlgorithmMapping("RSA")?.effortHours).toBe(4);
    expect(deriveAlgorithmMapping("ECDSA")?.effortHours).toBe(4);
    expect(deriveAlgorithmMapping("ECDH/DH")?.effortHours).toBe(8);
    expect(deriveAlgorithmMapping("DSA")?.effortHours).toBe(6);
    expect(deriveAlgorithmMapping("MD5")?.effortHours).toBe(0.5);
    expect(deriveAlgorithmMapping("SHA-1")?.effortHours).toBe(0.5);
    expect(deriveAlgorithmMapping("AES-ECB")?.effortHours).toBe(1);
  });

  it("resolves EdDSA, which is now emitted by SourceRegexCollector (G-06) and the dependency collector", () => {
    const eddsa = deriveAlgorithmMapping("EdDSA");
    expect(eddsa?.severity).toBe("critical");
    expect(eddsa?.effortHours).toBe(4);
    expect(eddsa?.nistStandard).toBe("FIPS 204");
  });

  it("resolves EVERY canonical name any collector can emit — iterated, not hardcoded", () => {
    // scanner.ts's `toScanFinding` logs an error and falls back to placeholder
    // severity/effort when a detected algorithm has no mapping. That invariant
    // used to be asserted by a hand-listed set of seven names, which silently
    // stopped covering the collectors the moment one grew a new pattern.
    for (const algorithm of [...SOURCE_PATTERN_ALGORITHMS, ...CRYPTO_PACKAGE_ALGORITHMS]) {
      expect(deriveAlgorithmMapping(algorithm), algorithm).toBeDefined();
    }
  });

  it("returns undefined for a name not present in algorithms.json rather than inventing data", () => {
    expect(deriveAlgorithmMapping("Not A Real Algorithm")).toBeUndefined();
  });

  it("carries reportingNote through for hygiene findings (G-10 support: caller can separate PQC vs classical hygiene)", () => {
    expect(deriveAlgorithmMapping("MD5")?.reportingNote).toMatch(/MUST NOT count toward the post-quantum risk score/);
    expect(deriveAlgorithmMapping("RSA")?.reportingNote).toBeNull();
  });

  it("is sourced from the current mappings dataVersion, not a frozen copy", () => {
    expect(deriveAlgorithmMapping("RSA")?.dataVersion).toBe("0.3.1");
  });
});
