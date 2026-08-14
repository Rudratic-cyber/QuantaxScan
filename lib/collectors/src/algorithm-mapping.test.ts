import { describe, expect, it } from "vitest";
import algorithmsData from "../../../docs/Claude/mappings/algorithms.json" with { type: "json" };
import { deriveAlgorithmMapping, MAPPINGS_DATA_VERSION } from "./algorithm-mapping";
import { SOURCE_PATTERN_ALGORITHMS } from "./source-regex-collector";
import { CRYPTO_PACKAGE_ALGORITHMS } from "./crypto-packages";
import { CERTIFICATE_KEY_ALGORITHMS } from "./certificate-collector";
import { PROTOCOL_CONFIG_ALGORITHMS } from "./protocol-config";

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
    for (const algorithm of [
      ...SOURCE_PATTERN_ALGORITHMS,
      ...CRYPTO_PACKAGE_ALGORITHMS,
      ...CERTIFICATE_KEY_ALGORITHMS,
      ...PROTOCOL_CONFIG_ALGORITHMS,
    ]) {
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
    // Compared against the file rather than a literal: a standards-data pull request
    // bumps `dataVersion`, and that must not break a test in the detection layer.
    expect(deriveAlgorithmMapping("RSA")?.dataVersion).toBe(algorithmsData.dataVersion);
    expect(deriveAlgorithmMapping("RSA")?.dataVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(MAPPINGS_DATA_VERSION).toBe(algorithmsData.dataVersion);
  });

  it("surfaces quantumVulnerable verbatim, so the A4 risk split reads the data rather than a name list", () => {
    for (const algorithm of ["RSA", "ECDSA", "ECDH/DH", "DSA", "EdDSA"]) {
      expect(deriveAlgorithmMapping(algorithm)?.quantumVulnerable, algorithm).toBe(true);
    }
    for (const algorithm of ["MD5", "SHA-1", "AES-ECB", "AES"]) {
      expect(deriveAlgorithmMapping(algorithm)?.quantumVulnerable, algorithm).toBe(false);
    }
  });
});
