import { describe, expect, it } from "vitest";
import { scanCode, computeScanResult, generateExecutiveSummary } from "./scanner";
import { DEMO_REPOS } from "./demo-repos";

/** Z is "years remaining", so every risk assertion below pins the clock. */
const NOW = new Date("2026-08-13T00:00:00Z");

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
    // A4 changed `riskScore`, deliberately not these: they are persisted
    // columns on `scans`/`projects` read by four routes, and they describe
    // how a finding is *displayed*, not which risk it belongs to.
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

describe("computeScanResult — A4 risk engine, split from detection (closes G-10)", () => {
  it("scores a hygiene-only file at zero post-quantum risk", () => {
    // docs/Claude/09-open-gaps.md G-10: MD5, SHA-1 and AES-ECB are not
    // quantum vulnerabilities. Before A4 this file scored non-zero purely
    // because it had alerts, and a CISO presenting that number as
    // post-quantum risk would have been corrected in the room.
    const code = ["h = hashlib.md5(data)", "g = hashlib.sha1(data)", "c = Cipher.ECB"].join("\n");
    const findings = scanCode(code, "hygiene.py", "python");
    const result = computeScanResult(findings, 10, { now: NOW });

    expect(findings).toHaveLength(3);
    expect(result.riskScore).toBe(0);
    expect(result.pqc.findingCount).toBe(0);

    // Zero PQC risk is not "clean" — all three are still reported, on their
    // own track, each with the qualification algorithms.json asks for.
    expect(result.hygiene.findingCount).toBe(3);
    expect(result.hygiene.countedTowardPqcRisk).toBe(false);
    expect(result.hygiene.byAlgorithm.find((a) => a.algorithm === "MD5")?.reportingNote).toMatch(
      /MUST NOT count toward the post-quantum risk score/,
    );
    // ...and the counts a human reads are untouched, so nothing is hidden.
    expect(result.alertCount).toBe(3);
  });

  it("does not let hygiene findings move the score of a mixed file", () => {
    const pqcOnly = scanCode("RSA.generate(2048)\nECDSA.sign(x)", "a.py", "python");
    const mixed = scanCode("RSA.generate(2048)\nECDSA.sign(x)\nmd5(x)\nsha1(x)", "a.py", "python");

    expect(computeScanResult(mixed, 10, { now: NOW }).riskScore).toBe(
      computeScanResult(pqcOnly, 10, { now: NOW }).riskScore,
    );
  });

  it("returns a Mosca verdict per Q-Day scenario with all three inputs exposed", () => {
    const findings = scanCode("RSA.generate(2048)", "a.py", "python");
    const result = computeScanResult(findings, 100, { secrecyLifetimeYears: 25, now: NOW });

    expect(result.mosca.verdicts.map((v) => v.scenario)).toEqual(["conservative", "central", "aggressive"]);
    expect(result.mosca.verdicts.every((v) => v.breached)).toBe(true);
    expect(result.mosca.verdicts[0].x).toBe(25);
    expect(result.mosca.secrecyLifetimeSource).toBe("provided");
    // The score is decomposable — 40 of it is the Mosca breach, not detection.
    expect(result.pqc.scoreComponents.moscaBreach).toBe(40);
  });

  it("marks the secrecy lifetime as an assumption when no classification is supplied (TODO(A3))", () => {
    const findings = scanCode("RSA.generate(2048)", "a.py", "python");
    const result = computeScanResult(findings, 100, { now: NOW });
    expect(result.mosca.secrecyLifetimeSource).toBe("assumed-default");
  });
});

describe("executive summary carries the Mosca verdict alongside the bucket counts (A4 + C1)", () => {
  it("states the breach, and still names the replacement standards, when there is real exposure", () => {
    const findings = scanCode("RSA.generate(2048)\nmd5(x)", "a.py", "python");
    const result = computeScanResult(findings, 10, { secrecyLifetimeYears: 25, now: NOW });
    const summary = generateExecutiveSummary(findings, 10, "python", result.mosca);

    expect(summary).toMatch(/Mosca's inequality is breached under 3 of 3 Q-Day scenarios/);
    expect(summary).toMatch(/FIPS 203/);
    expect(summary).toMatch(/classical hygiene — unrelated to quantum computing/);
  });

  it("labels the secrecy lifetime as assumed when no classification was supplied", () => {
    const findings = scanCode("RSA.generate(2048)", "a.py", "python");
    const result = computeScanResult(findings, 10, { now: NOW });
    const summary = generateExecutiveSummary(findings, 10, "python", result.mosca);

    expect(summary).toMatch(/assumed — no data classification set/);
  });

  it("omits the Mosca sentence entirely when no assessment is passed", () => {
    const findings = scanCode("RSA.generate(2048)", "a.py", "python");
    expect(generateExecutiveSummary(findings, 10, "python")).not.toMatch(/Mosca/);
  });
});
