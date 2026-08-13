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

  it("matches getInstance(\"SHA-1\", provider) — a comma, not a closing paren, follows the quoted value", async () => {
    // MessageDigest.getInstance("SHA-1", "SUN"): a comma follows the quoted
    // "SHA-1", not `)`. This is the only SOURCE_PATTERNS alternative that
    // can match a hyphenated "SHA-1" at all (the others require no hyphen),
    // so a stray required trailing `)` here silently drops this whole call
    // form. An earlier draft of this refactor introduced exactly that bug;
    // this line must keep matching it.
    const content = 'MessageDigest.getInstance("SHA-1", "SUN")';
    const [obs] = await collectAll([{ path: "a.java", content, language: "java" }]);
    expect(obs.algorithm).toBe("SHA-1");
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

describe("EdDSA detection — G-06", () => {
  it("detects Ed25519 in the call forms real code uses, and resolves the curve's bit size", async () => {
    const cases: Array<[string, string]> = [
      ["\tpub, priv, err := ed25519.GenerateKey(rand.Reader)", "go"],
      ["private_key = ed25519.Ed25519PrivateKey.generate()", "python"],
      ["const { publicKey } = crypto.generateKeyPairSync('ed25519')", "javascript"],
      ['KeyPairGenerator.getInstance("Ed25519")', "java"],
      ['_preferred_pubkeys = ("ssh-ed25519",)', "python"],
    ];
    for (const [content, language] of cases) {
      const [obs] = await collectAll([{ path: `a.${language}`, content, language }]);
      expect(obs, content).toBeDefined();
      expect(obs.algorithm, content).toBe("EdDSA");
      // KEY_SIZE_SOURCE has had `EdDSA: "curve"` and NAMED_CURVE_BIT_SIZES has
      // had ed25519/ed448 all along — with no pattern emitting "EdDSA" those
      // entries could never fire. This is the assertion that they now do.
      expect(obs.keySize, content).toBe(256);
    }
  });

  it("detects Ed448 and resolves 448, not 256", async () => {
    const [obs] = await collectAll([{ path: "a.java", content: 'Signature.getInstance("Ed448")', language: "java" }]);
    expect(obs.algorithm).toBe("EdDSA");
    expect(obs.keySize).toBe(448);
  });

  it("detects the bare EdDSA token (a JWS `alg`, an SSH config value)", async () => {
    const [obs] = await collectAll([{ path: "a.ts", content: "const header = { alg: 'EdDSA' }", language: "typescript" }]);
    expect(obs.algorithm).toBe("EdDSA");
    // No curve is named, so the key size is genuinely undeterminable here —
    // EdDSA is Ed25519 *or* Ed448 (G-05: null, not a guessed 256).
    expect(obs.keySize).toBeUndefined();
  });

  it("does not claim X25519/Curve25519 as EdDSA — those are key agreement, not signature", async () => {
    const [x25519] = await collectAll([
      { path: "a.js", content: "const ecdh = crypto.createECDH('x25519')", language: "javascript" },
    ]);
    expect(x25519.algorithm).toBe("ECDH/DH");
    const curve25519 = await collectAll([{ path: "a.go", content: "\tcurve25519.X25519(priv, pub)", language: "go" }]);
    expect(curve25519.every((o) => o.algorithm !== "EdDSA")).toBe(true);
  });

  it("leaves the pre-existing seven patterns' behaviour unchanged (first-pattern-wins order)", async () => {
    // The EdDSA entry sits after ECDSA, so an SSH key list naming both still
    // reports ECDSA for this line — same "one finding per line" semantics.
    const [obs] = await collectAll([
      { path: "a.py", content: '_preferred_keys = ["ecdsa-sha2-nistp256", "ssh-ed25519"]', language: "python" },
    ]);
    expect(obs.algorithm).toBe("ECDSA");
    expect(obs.keySize).toBe(256);

    // Same limitation, stated explicitly because it is the common real case:
    // an SSH preferred-key list naming ssh-rsa AND ssh-ed25519 on one line
    // reports RSA only. Closing G-06 does not change "one finding per line";
    // multi-algorithm lines need a parser, not another pattern.
    const [mixed] = await collectAll([
      { path: "a.py", content: '_preferred_pubkeys = ("ssh-ed25519", "ssh-rsa")', language: "python" },
    ]);
    expect(mixed.algorithm).toBe("RSA");
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

  it("never reads a curve name as an RSA/DSA key size — a curve on the line belongs to a different algorithm", () => {
    // The paramiko fixture's preferred-key list: the RSA pattern matches on
    // "rsa-sha2-256", but nistp256 is the ECDSA entry's curve, not an RSA
    // modulus (256 is not a possible one).
    expect(
      extractKeySizeFromLine('_preferred_keys = ["rsa-sha2-256", "ssh-rsa", "ecdsa-sha2-nistp256"]', "RSA"),
    ).toBeUndefined();
    expect(extractKeySizeFromLine("dsa_params(secp384r1)", "DSA")).toBeUndefined();
    // A literal modulus still wins on a line that also names a curve.
    expect(extractKeySizeFromLine("RSA.generate(2048)  # replaces secp256r1", "RSA")).toBe(2048);
  });

  it("returns undefined for algorithms whose key size is neither a modulus nor a curve", () => {
    expect(extractKeySizeFromLine("hashlib.md5(secp256r1_blob)", "MD5")).toBeUndefined();
    expect(extractKeySizeFromLine("createHash('sha1') // was P-384", "SHA-1")).toBeUndefined();
  });

  it("resolves an EdDSA curve — the KEY_SIZE_SOURCE entry that was unreachable before G-06", () => {
    expect(extractKeySizeFromLine("ed25519.GenerateKey(rand.Reader)", "EdDSA")).toBe(256);
    expect(extractKeySizeFromLine('Signature.getInstance("Ed448")', "EdDSA")).toBe(448);
    expect(extractKeySizeFromLine("const header = { alg: 'EdDSA' }", "EdDSA")).toBeUndefined();
  });
});
