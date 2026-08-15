import { describe, expect, it } from "vitest";
import {
  canonicalCertificateKeyAlgorithm,
  cipherSuiteTokens,
  decodeCipherSuite,
  decodeTlsPolicy,
  resolveHostIdentity,
  type EndpointHostReport,
} from "./endpoint-report";

/**
 * EP's decoding, and specifically the things it must refuse to say.
 *
 * Every `describe` below except the first is a false-positive control. The
 * positive cases are here to prove the parser is running at all — on their own
 * they would prove nothing about the failure this surface is prone to, which is
 * reporting cryptography a machine *lists* but cannot *negotiate*.
 */

const enabled = (name: string) => ({ name, enabled: true });

describe("cipherSuiteTokens — both spellings reduce to the same whole tokens", () => {
  it("splits the IANA form", () => {
    expect(cipherSuiteTokens("TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384")).toEqual([
      "TLS",
      "ECDHE",
      "RSA",
      "WITH",
      "AES",
      "256",
      "GCM",
      "SHA384",
    ]);
  });

  it("splits the OpenSSL form and unjoins the bulk cipher's width", () => {
    // `AES256` must become `AES` + `256`, or the width is lost on exactly the
    // spelling a Linux host's `CipherString` uses.
    expect(cipherSuiteTokens("ECDHE-RSA-AES256-GCM-SHA384")).toEqual(["ECDHE", "RSA", "AES", "256", "GCM", "SHA384"]);
  });
});

describe("decodeCipherSuite — what a suite name states", () => {
  it("reads key exchange, authentication and the bulk cipher with its width", () => {
    expect(decodeCipherSuite("TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384")).toEqual([
      { token: "ECDHE", algorithm: "ECDH/DH", keySize: undefined },
      { token: "RSA", algorithm: "RSA", keySize: undefined },
      { token: "AES_256", algorithm: "AES", keySize: 256 },
    ]);
  });

  it("reads the same facts from the OpenSSL spelling, width included", () => {
    expect(decodeCipherSuite("ECDHE-ECDSA-AES128-SHA256")).toEqual([
      { token: "ECDHE", algorithm: "ECDH/DH", keySize: undefined },
      { token: "ECDSA", algorithm: "ECDSA", keySize: undefined },
      { token: "AES_128", algorithm: "AES", keySize: 128 },
    ]);
  });

  it("resolves DSS through the DSA alias rather than dropping it", () => {
    expect(decodeCipherSuite("TLS_DHE_DSS_WITH_AES_128_CBC_SHA").map((c) => c.algorithm)).toEqual([
      "ECDH/DH",
      "DSA",
      "AES",
      "SHA-1",
    ]);
  });

  // ── false-positive controls ──

  it("does NOT invent a key exchange for a TLS 1.3 suite that names none", () => {
    // RFC 8446 removed the key exchange from the suite name because it is
    // negotiated separately. "It is TLS 1.3 so there must be an ECDHE" is an
    // inference, and this product does not report inferences.
    const decoded = decodeCipherSuite("TLS_AES_256_GCM_SHA384");
    expect(decoded).toEqual([{ token: "AES_256", algorithm: "AES", keySize: 256 }]);
    expect(decoded.some((c) => c.algorithm === "ECDH/DH")).toBe(false);
    expect(decoded.some((c) => c.algorithm === "RSA")).toBe(false);
  });

  it("does NOT read SHA-1 out of a SHA-2 suite", () => {
    // `SHA` alone is HMAC-SHA-1 (RFC 5246 §A.5); `SHA256`/`SHA384` are not.
    // A substring match would put a SHA-1 hygiene finding on every modern
    // suite in an estate.
    expect(decodeCipherSuite("TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256").some((c) => c.algorithm === "SHA-1")).toBe(false);
    expect(decodeCipherSuite("TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384").some((c) => c.algorithm === "SHA-1")).toBe(false);
    // ...while the suite that genuinely does name it still reports it, which is
    // what proves the absence above is matching rather than silence.
    expect(decodeCipherSuite("TLS_RSA_WITH_AES_128_CBC_SHA").some((c) => c.algorithm === "SHA-1")).toBe(true);
  });

  it("reports nothing for tokens with no canonical name, rather than approximating them", () => {
    // ChaCha20-Poly1305 has no entry in algorithms.json; the suite's ECDHE and
    // ECDSA are real and reported, and the AEAD contributes nothing.
    expect(decodeCipherSuite("TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256").map((c) => c.algorithm)).toEqual([
      "ECDH/DH",
      "ECDSA",
    ]);
    // A suite this table recognises nothing in is empty, not a guess.
    expect(decodeCipherSuite("TLS_KRB5_WITH_IDEA_CBC_MD5").map((c) => c.algorithm)).toEqual(["MD5"]);
    expect(decodeCipherSuite("TLS_ECDHE_PSK_WITH_CAMELLIA_128_CBC_SHA256").map((c) => c.algorithm)).toEqual(["ECDH/DH"]);
    expect(decodeCipherSuite("TLS_MLKEM768_SOMETHING_UNKNOWN")).toEqual([]);
  });

  it("does not report an anonymous key exchange as Diffie-Hellman", () => {
    // `ADH`/`AECDH` are unauthenticated suites no supported stack enables, and
    // every real appearance is inside a disabled-by-default list. Reporting
    // them would put quantum-vulnerable key agreement on a machine that cannot
    // negotiate it.
    expect(decodeCipherSuite("ADH-AES256-SHA").some((c) => c.algorithm === "ECDH/DH")).toBe(false);
    expect(decodeCipherSuite("AECDH-AES128-SHA").some((c) => c.algorithm === "ECDH/DH")).toBe(false);
  });

  it("does not double-count an algorithm a suite names twice", () => {
    expect(decodeCipherSuite("TLS_RSA_WITH_AES_128_CBC_SHA").filter((c) => c.algorithm === "RSA")).toHaveLength(1);
  });
});

describe("decodeTlsPolicy — a listed suite is not an enabled one", () => {
  it("reports the suites the policy enables", () => {
    const decoded = decodeTlsPolicy({
      provider: "schannel",
      cipherSuites: [enabled("TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384")],
    });
    expect(decoded.declarations.map((d) => d.component.algorithm)).toEqual(["ECDH/DH", "RSA", "AES"]);
  });

  // ── false-positive controls ──

  it("never reports a suite the policy marks disabled", () => {
    const decoded = decodeTlsPolicy({
      provider: "schannel",
      cipherSuites: [
        { name: "TLS_RSA_WITH_AES_128_CBC_SHA", enabled: false },
        enabled("TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384"),
      ],
    });
    expect(decoded.declarations.map((d) => d.suite)).toEqual([
      "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384",
      "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384",
      "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384",
    ]);
    expect(decoded.declarations.some((d) => d.component.algorithm === "SHA-1")).toBe(false);
  });

  it("suppresses a whole suite whose bulk cipher the host disabled by policy", () => {
    // The registry keeps the suite list and the per-algorithm switches in two
    // independent places, and a hardened server routinely has a suite listed
    // whose cipher is switched off. Reading only the list reports an algorithm
    // the machine cannot negotiate.
    const decoded = decodeTlsPolicy({
      provider: "schannel",
      cipherSuites: [enabled("TLS_RSA_WITH_AES_128_CBC_SHA")],
      disabledAlgorithms: ["AES 128/128"],
    });
    expect(decoded.declarations).toEqual([]);
    // Suppression is reported, not merely applied: an invisible suppression is
    // indistinguishable from a collector that missed the suite.
    expect(decoded.suppressedSuites).toEqual([{ suite: "TLS_RSA_WITH_AES_128_CBC_SHA", disabledBy: "AES 128/128" }]);
  });

  it("does NOT suppress a differently-sized suite — disabling AES-128 leaves AES-256 reported", () => {
    // The mirror-image error, and the more damaging one: a machine that
    // disabled AES-128 and kept AES-256 has hardened itself, and erasing its
    // real 256-bit cipher would understate the estate.
    const decoded = decodeTlsPolicy({
      provider: "schannel",
      cipherSuites: [enabled("TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256"), enabled("TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384")],
      disabledAlgorithms: ["AES 128/128"],
    });
    expect(decoded.suppressedSuites.map((s) => s.suite)).toEqual(["TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256"]);
    const aes = decoded.declarations.filter((d) => d.component.algorithm === "AES");
    expect(aes.map((d) => d.component.keySize)).toEqual([256]);
  });

  it("suppresses a suite whose MAC the host disabled, and only the suites that name it", () => {
    // `Hashes\SHA\Enabled = 0` is a real hardening step. It must retire the
    // SHA-1 suites and leave the SHA-2 ones alone — the same whole-token
    // discipline the decoder uses, applied to suppression.
    const decoded = decodeTlsPolicy({
      provider: "schannel",
      cipherSuites: [enabled("TLS_RSA_WITH_AES_256_CBC_SHA"), enabled("TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384")],
      disabledAlgorithms: ["SHA"],
    });
    expect(decoded.suppressedSuites.map((s) => s.suite)).toEqual(["TLS_RSA_WITH_AES_256_CBC_SHA"]);
    expect(decoded.declarations.map((d) => d.suite)).toEqual([
      "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384",
      "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384",
      "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384",
    ]);
  });

  it("suppresses a suite whose cipher this product does not itself report", () => {
    // `Triple DES 168` disabled means the suite cannot be negotiated at all, so
    // its RSA and SHA-1 must not be reported either — a suppression that only
    // removed the algorithm named by the disabled entry would leave the rest of
    // the suite standing, which is the same false positive one component down.
    const decoded = decodeTlsPolicy({
      provider: "schannel",
      cipherSuites: [enabled("TLS_RSA_WITH_3DES_EDE_CBC_SHA")],
      disabledAlgorithms: ["Triple DES 168"],
    });
    expect(decoded.declarations).toEqual([]);
  });

  it("reports a disabled-algorithm entry it cannot recognise rather than silently ignoring it", () => {
    // The one input whose misreading risks a false positive rather than an
    // omission: an unrecognised entry suppresses nothing, so the caller has to
    // be told it could not be acted on.
    const decoded = decodeTlsPolicy({
      provider: "schannel",
      cipherSuites: [enabled("TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384")],
      disabledAlgorithms: ["Some Vendor Cipher 999"],
    });
    expect(decoded.unrecognisedDisabledAlgorithms).toEqual(["Some Vendor Cipher 999"]);
  });

  it("separates undetermined protocol state from enabled and disabled", () => {
    // A Schannel `Enabled` REG_DWORD frequently does not exist, and the build
    // default then applies — which this product does not claim to know.
    const decoded = decodeTlsPolicy({
      provider: "schannel",
      protocols: [
        { name: "TLS 1.0", role: "Server", enabled: false },
        { name: "TLS 1.2", role: "Server", enabled: true },
        { name: "TLS 1.3", role: "Server" },
      ],
    });
    expect(decoded.disabledProtocols).toEqual(["TLS 1.0 (Server)"]);
    expect(decoded.enabledProtocols).toEqual(["TLS 1.2 (Server)"]);
    expect(decoded.undeterminedProtocols).toEqual(["TLS 1.3 (Server)"]);
    // No protocol version becomes an asset — see the module header.
    expect(decoded.declarations).toEqual([]);
  });
});

describe("canonicalCertificateKeyAlgorithm — the store's word, canonicalised or refused", () => {
  it("reads the three vocabularies a store may use", () => {
    expect(canonicalCertificateKeyAlgorithm("RSA")?.algorithm).toBe("RSA");
    expect(canonicalCertificateKeyAlgorithm("rsaEncryption")?.algorithm).toBe("RSA");
    expect(canonicalCertificateKeyAlgorithm("1.2.840.113549.1.1.1")?.algorithm).toBe("RSA");
    expect(canonicalCertificateKeyAlgorithm("ECC")?.algorithm).toBe("ECDSA");
    expect(canonicalCertificateKeyAlgorithm("id-ecPublicKey")?.algorithm).toBe("ECDSA");
  });

  it("gives a fixed size only where the identifier itself fixes one", () => {
    expect(canonicalCertificateKeyAlgorithm("ED25519")).toEqual({ algorithm: "EdDSA", keySize: 256 });
    expect(canonicalCertificateKeyAlgorithm("1.3.101.113")).toEqual({ algorithm: "EdDSA", keySize: 448 });
    // `ECC` names no curve, so it names no size. Deriving 256 from it would be
    // a fabricated measurement — G-05.
    expect(canonicalCertificateKeyAlgorithm("ECC")?.keySize).toBeUndefined();
    expect(canonicalCertificateKeyAlgorithm("RSA")?.keySize).toBeUndefined();
  });

  it("refuses a string it does not carry, including a post-quantum one", () => {
    // Silently absent beats confidently classical.
    expect(canonicalCertificateKeyAlgorithm("ML-DSA-65")).toBeUndefined();
    expect(canonicalCertificateKeyAlgorithm("2.16.840.1.101.3.4.3.18")).toBeUndefined();
    expect(canonicalCertificateKeyAlgorithm("")).toBeUndefined();
    // A substring of a name this table does carry is not that name.
    expect(canonicalCertificateKeyAlgorithm("RSA-Something-Else")).toBeUndefined();
  });
});

describe("resolveHostIdentity — what identity survives a reboot and changes on a re-image", () => {
  const host = (machineId: string, extra: Partial<EndpointHostReport> = {}): EndpointHostReport => ({
    machineId,
    tlsPolicy: { provider: "schannel", cipherSuites: [] },
    ...extra,
  });

  it("accepts a host with a durable machine identity and something collected", () => {
    expect(resolveHostIdentity([host("9f5a1e2c-4b6d-4f21-9c11-6a7b8c9d0e1f")])[0].skipped).toBeUndefined();
  });

  it("refuses a placeholder identity rather than fingerprinting every re-imaged machine as one host", () => {
    // A cleared MachineGuid and an all-zero /etc/machine-id are the *absence*
    // of an identity wearing the shape of one.
    for (const id of ["00000000-0000-0000-0000-000000000000", "00000000000000000000000000000000", "   "]) {
      expect(resolveHostIdentity([host(id)])[0].skipped, id).toBe("placeholder-machine-id");
    }
  });

  it("refuses BOTH hosts of a clone collision, not just the second", () => {
    // A cloned VM inherits its template's identifier. Merging the two would
    // produce one host asset whose stores and policy interleave two different
    // machines — a wrong answer that reads as a confident one. There is no
    // basis for preferring either, so neither is kept.
    const resolved = resolveHostIdentity([host("SHARED-ID"), host("shared-id"), host("UNIQUE-ID")]);
    expect(resolved.map((r) => r.skipped)).toEqual(["duplicate-machine-id", "duplicate-machine-id", undefined]);
  });

  it("refuses a host that collected nothing, which is not the same as one that found nothing", () => {
    expect(resolveHostIdentity([{ machineId: "UNIQUE-ID" }])[0].skipped).toBe("nothing-collected");
    // A section present and empty IS a collection: the store was read and holds
    // nothing, which is a real answer and must reach the ingest.
    expect(resolveHostIdentity([{ machineId: "UNIQUE-ID", certificateStores: [] }])[0].skipped).toBeUndefined();
  });
});
