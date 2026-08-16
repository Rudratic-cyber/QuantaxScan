import { describe, expect, it } from "vitest";
import { parseCipherSuite, type CipherSuiteRole } from "./cipher-suite";

function algorithmFor(name: string, role: CipherSuiteRole): string | undefined {
  return parseCipherSuite(name)?.components.find((c) => c.role === role)?.algorithm;
}

function rolesOf(name: string): CipherSuiteRole[] {
  return (parseCipherSuite(name)?.components ?? []).map((c) => c.role);
}

describe("parseCipherSuite — positive cases", () => {
  it("reads key exchange, authentication and record protection off an IANA TLS 1.2 name", () => {
    const parsed = parseCipherSuite("TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256");
    expect(parsed?.form).toBe("iana-legacy");
    expect(parsed?.components).toEqual([
      { role: "key-exchange", algorithm: "ECDH", token: "ECDHE", keySize: undefined },
      { role: "authentication", algorithm: "RSA", token: "RSA" },
      { role: "bulk-cipher", algorithm: "AES", keySize: 128, token: "AES" },
    ]);
    expect(parsed?.gaps).toEqual([]);
  });

  it("reads the same three components off OpenSSL's spelling of the same suite", () => {
    expect(algorithmFor("ECDHE-RSA-AES128-GCM-SHA256", "key-exchange")).toBe("ECDH");
    expect(algorithmFor("ECDHE-RSA-AES128-GCM-SHA256", "authentication")).toBe("RSA");
    expect(parseCipherSuite("ECDHE-RSA-AES128-GCM-SHA256")?.form).toBe("openssl-legacy");
    expect(parseCipherSuite("ECDHE-RSA-AES128-GCM-SHA256")?.components.find((c) => c.role === "bulk-cipher")).toEqual({
      role: "bulk-cipher",
      algorithm: "AES",
      keySize: 128,
      token: "AES",
    });
  });

  it("maps DSS to DSA, and each DH spelling to the family it actually names (G-24)", () => {
    expect(algorithmFor("TLS_DHE_DSS_WITH_AES_256_CBC_SHA", "authentication")).toBe("DSA");
    // Both spellings of each family, because the suite name is the only
    // evidence there is: nothing downstream can recover which Diffie-Hellman
    // was meant once this returns the wrong one, and the two band a stated
    // size against different tables (G-24).
    for (const name of ["TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256", "TLS_ECDH_RSA_WITH_AES_128_GCM_SHA256"]) {
      expect(algorithmFor(name, "key-exchange"), name).toBe("ECDH");
    }
    for (const name of ["TLS_DHE_RSA_WITH_AES_256_GCM_SHA384", "EDH-RSA-AES256-SHA"]) {
      expect(algorithmFor(name, "key-exchange"), name).toBe("DH");
    }
  });

  it("takes the key size the name states, and only for the bulk cipher", () => {
    const parsed = parseCipherSuite("TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384");
    // 384 is the KDF/MAC hash, not a key size. The size must come from after
    // the cipher family, never from the trailing hash.
    expect(parsed?.components.find((c) => c.role === "bulk-cipher")?.keySize).toBe(256);
    expect(parsed?.components.find((c) => c.role === "key-exchange")?.keySize).toBeUndefined();
    expect(parsed?.components.find((c) => c.role === "authentication")?.keySize).toBeUndefined();
  });

  it("keeps a static-RSA suite's two RSA facts as two components with different roles", () => {
    // Not cosmetic: `fingerprint.ts`'s network-flow variant carries the role
    // precisely so these two do not collapse into one asset.
    const parsed = parseCipherSuite("TLS_RSA_WITH_AES_256_CBC_SHA");
    expect(parsed?.components).toEqual([
      { role: "key-exchange", algorithm: "RSA", token: "RSA" },
      { role: "authentication", algorithm: "RSA", token: "RSA" },
      { role: "bulk-cipher", algorithm: "AES", keySize: 256, token: "AES" },
    ]);
  });
});

describe("parseCipherSuite — the false positives it must refuse", () => {
  it("does NOT report a key exchange for a TLS 1.3 suite name (RFC 8446 §1.2)", () => {
    // The headline control. TLS 1.3 mandates an (EC)DHE exchange, and B3's
    // prober records one — because it completed the handshake. A log line
    // does not let us say that, so the name's silence stays silence.
    for (const name of ["TLS_AES_128_GCM_SHA256", "TLS_AES_256_GCM_SHA384", "TLS_CHACHA20_POLY1305_SHA256"]) {
      const parsed = parseCipherSuite(name);
      expect(parsed?.form, name).toBe("tls13");
      expect(rolesOf(name), name).not.toContain("key-exchange");
      expect(rolesOf(name), name).not.toContain("authentication");
      expect(parsed?.gaps, name).toContain("key-exchange-not-named");
      expect(parsed?.gaps, name).toContain("authentication-not-named");
    }
    // …and the AEAD it *does* name is still reported.
    expect(algorithmFor("TLS_AES_128_GCM_SHA256", "bulk-cipher")).toBe("AES");
  });

  it("does NOT invent an authentication algorithm for an anonymous suite", () => {
    const parsed = parseCipherSuite("TLS_DH_anon_WITH_AES_128_CBC_SHA");
    expect(rolesOf("TLS_DH_anon_WITH_AES_128_CBC_SHA")).not.toContain("authentication");
    expect(parsed?.gaps).toContain("authentication-not-named");
    // The DH key exchange it really does name is still reported.
    expect(algorithmFor("TLS_DH_anon_WITH_AES_128_CBC_SHA", "key-exchange")).toBe("DH");
  });

  it("does NOT invent an authentication algorithm for a PSK suite", () => {
    expect(rolesOf("TLS_ECDHE_PSK_WITH_AES_128_GCM_SHA256")).not.toContain("authentication");
    expect(algorithmFor("TLS_ECDHE_PSK_WITH_AES_128_GCM_SHA256", "key-exchange")).toBe("ECDH");
    // A PSK-only suite names neither half.
    expect(rolesOf("TLS_PSK_WITH_AES_128_CBC_SHA")).toEqual(["bulk-cipher"]);
  });

  it("never reports the trailing MAC/KDF hash as an algorithm", () => {
    // The B6 bug in its exact shape: a `sha1` token turned into a key's
    // algorithm. SHA-1 inside HMAC is ACCEPTABLE per SP 800-131A Rev 2, so a
    // SHA-1 asset off this name would be a false positive with a citation
    // against it.
    for (const name of ["ECDHE-RSA-AES128-SHA", "TLS_RSA_WITH_AES_128_CBC_SHA", "TLS_AES_128_GCM_SHA256"]) {
      const algorithms = (parseCipherSuite(name)?.components ?? []).map((c) => c.algorithm);
      expect(algorithms, name).not.toContain("SHA-1");
      expect(algorithms, name).not.toContain("MD5");
      expect(algorithms.every((a) => !a.startsWith("SHA")), name).toBe(true);
    }
  });

  it("does NOT fill in OpenSSL's omitted static-RSA prefix", () => {
    // `AES256-SHA` *is* TLS_RSA_WITH_AES_256_CBC_SHA. The string does not say
    // so, and a reader who knows the registry is not evidence.
    const parsed = parseCipherSuite("AES256-SHA");
    expect(rolesOf("AES256-SHA")).toEqual(["bulk-cipher"]);
    expect(parsed?.gaps).toContain("key-exchange-not-named");
    expect(parsed?.gaps).toContain("authentication-not-named");
    expect(algorithmFor("AES256-SHA", "bulk-cipher")).toBe("AES");
    expect(parsed?.components[0].keySize).toBe(256);
  });

  it("does not resolve a `dh` substring hiding inside another token", () => {
    // The IPsec `dh` bug, transplanted: only whole tokens are looked up, so a
    // name that merely contains those two letters resolves nothing.
    expect(rolesOf("TLS_XDHY_ZZZ_WITH_AES_128_GCM_SHA256")).toEqual(["bulk-cipher"]);
    expect(parseCipherSuite("TLS_XDHY_ZZZ_WITH_AES_128_GCM_SHA256")?.gaps).toContain("key-exchange-not-named");
  });

  it("reports an unrecognised record cipher rather than bending it onto AES", () => {
    const parsed = parseCipherSuite("ECDHE-ECDSA-CHACHA20-POLY1305");
    expect(rolesOf("ECDHE-ECDSA-CHACHA20-POLY1305")).toEqual(["key-exchange", "authentication"]);
    expect(parsed?.gaps).toContain("bulk-cipher-not-recognised");
    for (const name of ["TLS_RSA_WITH_3DES_EDE_CBC_SHA", "TLS_RSA_WITH_CAMELLIA_128_CBC_SHA", "RC4-MD5"]) {
      expect((parseCipherSuite(name)?.components ?? []).some((c) => c.role === "bulk-cipher"), name).toBe(false);
    }
  });

  it("separates `no encryption at all` from `a cipher we do not know`", () => {
    expect(parseCipherSuite("TLS_RSA_WITH_NULL_SHA")?.gaps).toContain("bulk-cipher-none");
    expect(parseCipherSuite("NULL-SHA")?.gaps).toContain("bulk-cipher-none");
    expect(parseCipherSuite("TLS_RSA_WITH_NULL_SHA")?.components.some((c) => c.role === "bulk-cipher")).toBe(false);
  });

  it("refuses to split a kex/auth section it has never been shown", () => {
    // `TLS_SRP_SHA_RSA_WITH_…` has a three-token section. A guessed split is a
    // confident wrong answer; a gap is a true one.
    const parsed = parseCipherSuite("TLS_SRP_SHA_RSA_WITH_AES_128_CBC_SHA");
    expect(rolesOf("TLS_SRP_SHA_RSA_WITH_AES_128_CBC_SHA")).toEqual(["bulk-cipher"]);
    expect(parsed?.gaps).toContain("key-exchange-not-named");
    expect(parsed?.gaps).toContain("authentication-not-named");
  });

  it("returns undefined for a string that is not a suite name at all", () => {
    expect(parseCipherSuite("")).toBeUndefined();
    expect(parseCipherSuite("   ")).toBeUndefined();
    expect(parseCipherSuite("---")).toBeUndefined();
  });

  it("carries the tokens it parsed, so a stored observation can be audited", () => {
    expect(parseCipherSuite("ECDHE-RSA-AES128-GCM-SHA256")?.tokens).toEqual([
      "ECDHE",
      "RSA",
      "AES",
      "128",
      "GCM",
      "SHA256",
    ]);
  });
});
