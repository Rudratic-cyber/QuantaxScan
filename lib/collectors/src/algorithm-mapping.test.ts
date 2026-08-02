import { describe, expect, it } from "vitest";
import { deriveAlgorithmMapping } from "./algorithm-mapping";

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

  it("returns undefined for a name not present in algorithms.json rather than inventing data", () => {
    expect(deriveAlgorithmMapping("Not A Real Algorithm")).toBeUndefined();
  });

  it("carries reportingNote through for hygiene findings (G-10 support: caller can separate PQC vs classical hygiene)", () => {
    expect(deriveAlgorithmMapping("MD5")?.reportingNote).toMatch(/MUST NOT count toward the post-quantum risk score/);
    expect(deriveAlgorithmMapping("RSA")?.reportingNote).toBeNull();
  });

  it("is sourced from the current mappings dataVersion, not a frozen copy", () => {
    expect(deriveAlgorithmMapping("RSA")?.dataVersion).toBe("0.3.0");
  });
});
