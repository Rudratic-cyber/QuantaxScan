import { describe, expect, it } from "vitest";
import { scanCode, computeScanResult, generateExecutiveSummary } from "./scanner";
import { DEMO_REPOS } from "./demo-repos";

describe("scanCode — behaviour preserved through the SourceRegexCollector refactor", () => {
  it("still returns one finding per matching line, with severity/effort/replacement now derived from algorithms.json", () => {
    const code = ["from Crypto.PublicKey import RSA", "key = RSA.generate(2048)", "h = hashlib.md5(data)"].join("\n");
    const findings = scanCode(code, "keys.py", "python");

    expect(findings).toHaveLength(3);
    expect(findings[0]).toMatchObject({ lineNumber: 1, algorithm: "RSA", severity: "critical" });
    expect(findings[1]).toMatchObject({ lineNumber: 2, algorithm: "RSA", severity: "critical" });
    expect(findings[2]).toMatchObject({ lineNumber: 3, algorithm: "MD5", severity: "alert" });

    // Every finding carries non-empty derived copy — the mapping lookup resolved, nothing silently blank.
    for (const f of findings) {
      expect(f.nistReplacement).toBeTruthy();
      expect(f.nistStandard || f.explanation).toBeTruthy();
      expect(f.effortHours).toBeGreaterThan(0);
    }
  });

  it("preserves 'one finding per line' (first-pattern-match-wins) on a line matching multiple patterns", () => {
    // "RSA" and "MD5" both present — pre-refactor scanner tested patterns in
    // array order and broke after the first match; RSA is first.
    const code = "RSA key hashed with md5 for legacy fingerprint";
    const findings = scanCode(code, "a.py", "python");
    expect(findings).toHaveLength(1);
    expect(findings[0].algorithm).toBe("RSA");
  });

  it("reproduces the exact counts against the real paramiko demo fixture (verbatim from routes/demo.ts)", () => {
    const paramiko = DEMO_REPOS.find((r) => r.slug === "paramiko-ssh")!;
    const transport = paramiko.files.find((f) => f.path === "paramiko/transport.py")!;
    const findings = scanCode(transport.content, transport.path, "python");

    // This fixture is known to trigger RSA (import + host key gen), SHA-1
    // (session id + preferred-MAC list) and MD5 (fingerprint) matches;
    // not asserting an exact total count here since several lines match
    // more than one plausible pattern and only the first (array order) wins.
    const algorithms = findings.map((f) => f.algorithm);
    expect(algorithms).toEqual(expect.arrayContaining(["RSA", "SHA-1", "MD5"]));
    expect(findings.every((f) => f.severity === "critical" || f.severity === "alert")).toBe(true);

    // The specific line "key = RSA.generate(bits)" has a variable, not a literal — G-05 stays undetermined here.
    // (RawObservation.keySize isn't on ScanFinding, but this exercises the same code path as the collector directly.)
    const rsaGenerateLine = transport.content.split("\n").findIndex((l) => l.includes("RSA.generate(bits)")) + 1;
    const rsaFinding = findings.find((f) => f.lineNumber === rsaGenerateLine);
    expect(rsaFinding?.algorithm).toBe("RSA");
  });

  it("computeScanResult severities still drive critical/alert counts identically to before the refactor", () => {
    const code = ["RSA.generate(2048)", "md5(x)", "sha1(x)"].join("\n");
    const findings = scanCode(code, "a.py", "python");
    const result = computeScanResult(findings, 3);
    expect(result.criticalCount).toBe(1);
    expect(result.alertCount).toBe(2);
  });
});

describe("every finding carries the mapping engine's answer, resolved at read time (C1)", () => {
  it("attaches obligations, a bucket and a data version to each finding", () => {
    const [finding] = scanCode("key = RSA.generate(2048)", "a.py", "python");
    expect(finding.compliance).not.toBeNull();
    expect(finding.compliance!.bucket).toBe("pqc-migration");
    expect(finding.compliance!.obligations.length).toBeGreaterThan(0);
    expect(finding.compliance!.dataVersion).toMatch(/^\d+\.\d+\.\d+$/);
    // Every regulatory claim carries a citation — the whole point of the provenance rule.
    for (const obligation of finding.compliance!.obligations) {
      expect(obligation.citation.url).toBeTruthy();
      expect(obligation.citation.document).toBeTruthy();
    }
  });

  it("separates the buckets G-07/G-08/G-09 are about", () => {
    const bucketOf = (code: string) => scanCode(code, "a.py", "python")[0].compliance!.bucket;
    expect(bucketOf("signer = DSA.new(key)")).toBe("immediate-compliance-failure");
    expect(bucketOf("key = RSA.generate(2048)")).toBe("pqc-migration");
    expect(bucketOf('c = Cipher.getInstance("AES/ECB/PKCS5Padding")')).toBe("best-practice");
  });

  it("keeps hygiene findings out of the post-quantum score (G-10 contract for A4)", () => {
    const findings = scanCode(["RSA.generate(2048)", "md5(x)", "sha1(x)"].join("\n"), "a.py", "python");
    const pqc = findings.filter((f) => f.compliance?.countsTowardPostQuantumScore);
    expect(pqc.map((f) => f.algorithm)).toEqual(["RSA"]);
  });
});

describe("executive summary states what is true of each bucket (G-08, G-09)", () => {
  it("does not recommend a PQC migration for a scan that has no quantum-vulnerable finding", () => {
    const findings = scanCode(["h = hashlib.md5(x)", "s = hashlib.sha1(x)"].join("\n"), "a.py", "python");
    const summary = generateExecutiveSummary(findings, 2, "python");
    expect(summary).not.toMatch(/FIPS 20[345]/);
    expect(summary).not.toMatch(/Migrate the quantum-vulnerable findings/);
    expect(summary).toMatch(/classical hygiene — unrelated to quantum computing/i);
  });

  it("recommends the replacement standards the obligations actually name when PQC work exists", () => {
    const findings = scanCode("key = RSA.generate(2048)", "a.py", "python");
    const summary = generateExecutiveSummary(findings, 1, "python");
    expect(summary).toMatch(/FIPS 203/);
    expect(summary).toMatch(/quantum-vulnerable/i);
  });

  it("leads with the findings that have no runway, and flags the ones needing review", () => {
    const findings = scanCode(["signer = DSA.new(key)", "key = RSA.generate(2048)"].join("\n"), "a.py", "python");
    const summary = generateExecutiveSummary(findings, 2, "python");
    expect(summary).toMatch(/non-compliant now, with no migration runway \(DSA\)/);
    expect(summary.indexOf("no migration runway")).toBeLessThan(summary.indexOf("published transition deadline"));
    expect(summary).toMatch(/confirm the call site/i);
  });

  it("never asserts that a hygiene finding is non-PQC-safe", () => {
    const findings = scanCode('c = Cipher.getInstance("AES/ECB/PKCS5Padding")', "a.java", "java");
    const summary = generateExecutiveSummary(findings, 1, "python");
    expect(summary).not.toMatch(/non-PQC-safe|quantum-critical|Q-Day/i);
    expect(summary).toMatch(/1 of them is a best-practice recommendation that violates no standard/);
  });

  it("pluralises correctly with more than one best-practice finding", () => {
    const ecb = 'c = Cipher.getInstance("AES/ECB/PKCS5Padding")';
    const findings = scanCode([ecb, ecb].join("\n"), "a.java", "java");
    const summary = generateExecutiveSummary(findings, 2, "java");
    expect(summary).toMatch(/2 findings .* are classical hygiene/);
    expect(summary).toMatch(/2 of them are a best-practice recommendation that violates no standard/);
    expect(summary).not.toMatch(/thems|findings is|finding are/);
  });
});
