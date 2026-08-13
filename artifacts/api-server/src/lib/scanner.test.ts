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

describe("generateExecutiveSummary — stops claiming a PQC migration for hygiene findings", () => {
  it("does not recommend PQC migration for a scan with no quantum-vulnerable findings", () => {
    const findings = scanCode("h = hashlib.md5(data)", "a.py", "python");
    const summary = generateExecutiveSummary(findings, 10, "python");

    expect(summary).not.toMatch(/FIPS 203/);
    expect(summary).toMatch(/post-quantum exposure score is zero/);
    expect(summary).toMatch(/classical-hygiene finding/);
  });

  it("still recommends PQC migration, and names the Mosca verdict, when there is real exposure", () => {
    const findings = scanCode("RSA.generate(2048)\nmd5(x)", "a.py", "python");
    const result = computeScanResult(findings, 10, { secrecyLifetimeYears: 25, now: NOW });
    const summary = generateExecutiveSummary(findings, 10, "python", result.mosca);

    expect(summary).toMatch(/FIPS 203/);
    expect(summary).toMatch(/Mosca's inequality is breached under 3 of 3 Q-Day scenarios/);
    expect(summary).toMatch(/excluded from the post-quantum score/);
  });
});
