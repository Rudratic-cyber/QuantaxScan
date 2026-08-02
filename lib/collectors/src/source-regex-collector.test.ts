import { describe, expect, it } from "vitest";
import { SourceRegexCollector, extractKeySizeFromLine } from "./source-regex-collector";

async function collectAll(files: Array<{ path: string; content: string; language: string }>) {
  const collector = new SourceRegexCollector();
  const out = [];
  for await (const obs of collector.collect({ kind: "source", repo: "acme/widget", files }, { organizationId: 1 })) {
    out.push(obs);
  }
  return out;
}

describe("SourceRegexCollector — behaviour parity with the pre-refactor scanner", () => {
  it("emits one observation per matching line, first-pattern-wins, matching the old 'break' semantics", async () => {
    const content = ["import RSA from 'crypto'", "// nothing here", "const h = md5(data)"].join("\n");
    const obs = await collectAll([{ path: "a.py", content, language: "python" }]);
    expect(obs).toHaveLength(2);
    expect(obs[0]).toMatchObject({ algorithm: "RSA", evidence: { lineNumber: 1 } });
    expect(obs[1]).toMatchObject({ algorithm: "MD5", evidence: { lineNumber: 3 } });
  });

  it("sets discoveryModality to static_artifact_analysis and confidence to 0.7 for every observation", async () => {
    const content = "const k = new RSA()";
    const [obs] = await collectAll([{ path: "a.js", content, language: "javascript" }]);
    expect(obs.discoveryModality).toBe("static_artifact_analysis");
    expect(obs.confidence).toBe(0.7);
  });

  it("reproduces the real paramiko/go-tls-server demo fixture lines (fileName, lineNumber, algorithm) exactly", async () => {
    // Lines lifted verbatim from artifacts/api-server/src/routes/demo.ts's
    // DEMO_REPOS fixtures, used as the parity check the qx-sp1800-38b
    // investigation recommended.
    const goTls = [
      "func SelfSignedConfig() (*tls.Config, error) {",
      "\tprivateKey, err := rsa.GenerateKey(rand.Reader, 2048)",
      "\tif err != nil {",
      "\t\treturn nil, err",
      "\t}",
    ].join("\n");
    const obsRsa = await collectAll([{ path: "tls/config.go", content: goTls, language: "go" }]);
    expect(obsRsa).toHaveLength(1);
    expect(obsRsa[0].algorithm).toBe("RSA");
    expect(obsRsa[0].evidence.lineNumber).toBe(2);
    expect(obsRsa[0].keySize).toBe(2048); // literal on the same matched line — G-05 closes here

    const goEcdsa = "\tkey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)";
    const obsEcdsa = await collectAll([{ path: "tls/config.go", content: goEcdsa, language: "go" }]);
    expect(obsEcdsa).toHaveLength(1);
    expect(obsEcdsa[0].algorithm).toBe("ECDSA");
    expect(obsEcdsa[0].keySize).toBe(256); // curve name on the matched line

    // The paramiko fixture's RSA.generate(bits) call: bits is a parameter,
    // not a literal, on this exact line — genuinely undeterminable.
    const paramiko = '        key = RSA.generate(bits)';
    const obsParamiko = await collectAll([{ path: "paramiko/transport.py", content: paramiko, language: "python" }]);
    expect(obsParamiko).toHaveLength(1);
    expect(obsParamiko[0].algorithm).toBe("RSA");
    expect(obsParamiko[0].keySize).toBeUndefined();
  });
});

describe("extractKeySizeFromLine — G-05", () => {
  it("extracts a literal RSA modulus size on the same line", () => {
    expect(extractKeySizeFromLine("RSA.generate(2048)", "RSA")).toBe(2048);
    expect(extractKeySizeFromLine("modulusLength: this.keySize || 2048,", "RSA")).toBe(2048);
  });

  it("extracts a named curve's bit size", () => {
    expect(extractKeySizeFromLine("const ecdh = crypto.createECDH('secp256k1')", "ECDH/DH")).toBe(256);
    expect(extractKeySizeFromLine("ecdsa.GenerateKey(elliptic.P384(), rand.Reader)", "ECDSA")).toBe(384);
  });

  it("never guesses a default — returns undefined, not a plausible-looking number, when nothing is on the line", () => {
    expect(extractKeySizeFromLine("from Crypto.PublicKey import RSA", "RSA")).toBeUndefined();
    expect(extractKeySizeFromLine("key = RSA.generate(bits)", "RSA")).toBeUndefined();
  });

  it("does not mistake an unrelated number (a year, an RFC number) for a key size", () => {
    expect(extractKeySizeFromLine("Implements SSH-2.0 (RFC 4253) RSA handshake", "RSA")).toBeUndefined();
    expect(extractKeySizeFromLine("RSA key rotation policy: review by 2030", "RSA")).toBeUndefined();
  });
});
