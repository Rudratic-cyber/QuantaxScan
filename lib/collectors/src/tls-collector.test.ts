import { describe, expect, it } from "vitest";
import { observationsFromTlsHandshake, TLS_HANDSHAKE_CONFIDENCE } from "./tls-collector";
import { computeFingerprint, fingerprintForObservation } from "./fingerprint";

describe("observationsFromTlsHandshake", () => {
  it("emits a key-exchange observation and a peer-certificate observation for a TLS 1.3 handshake", () => {
    const observations = observationsFromTlsHandshake("project:1", {
      host: "example.com",
      port: 443,
      protocolVersion: "TLSv1.3",
      cipherSuiteName: "TLS_AES_256_GCM_SHA384",
      keyExchange: { type: "ECDH", name: "X25519" },
      peerCertificatePublicKey: { keyType: "rsa", modulusBits: 2048 },
    });

    expect(observations).toHaveLength(2);

    const kex = observations.find((o) => o.algorithm === "ECDH/DH");
    expect(kex).toBeDefined();
    expect(kex!.keySize).toBe(256);
    expect(kex!.location).toBe("project:1:example.com:443");
    expect(kex!.locationDetail).toEqual({
      kind: "network",
      network: { hostname: "example.com", destinationPort: 443 },
    });
    expect(kex!.discoveryModality).toBe("active_network_scan");
    expect(kex!.confidence).toBe(TLS_HANDSHAKE_CONFIDENCE);
    expect(kex!.confidence).toBe(1.0);

    const cert = observations.find((o) => o.algorithm === "RSA");
    expect(cert).toBeDefined();
    expect(cert!.keySize).toBe(2048);
    expect(cert!.location).toBe(kex!.location);
    expect((cert!.evidence as { note: string }).note).toContain("no certificate identity");
  });

  it("maps an EC certificate's named curve to a bit size via the shared named-curves table", () => {
    const observations = observationsFromTlsHandshake("project:1", {
      host: "example.com",
      port: 443,
      protocolVersion: "TLSv1.3",
      cipherSuiteName: "TLS_AES_256_GCM_SHA384",
      peerCertificatePublicKey: { keyType: "ec", namedCurve: "secp384r1" },
    });
    expect(observations).toHaveLength(1);
    expect(observations[0].algorithm).toBe("ECDSA");
    expect(observations[0].keySize).toBe(384);
  });

  it("maps Ed25519/Ed448 certificate keys to their fixed bit sizes with no namedCurve field", () => {
    const [ed25519] = observationsFromTlsHandshake("project:1", {
      host: "h",
      port: 1,
      protocolVersion: "TLSv1.3",
      cipherSuiteName: "x",
      peerCertificatePublicKey: { keyType: "ed25519" },
    });
    expect(ed25519.algorithm).toBe("EdDSA");
    expect(ed25519.keySize).toBe(256);

    const [ed448] = observationsFromTlsHandshake("project:1", {
      host: "h",
      port: 1,
      protocolVersion: "TLSv1.3",
      cipherSuiteName: "x",
      peerCertificatePublicKey: { keyType: "ed448" },
    });
    expect(ed448.algorithm).toBe("EdDSA");
    expect(ed448.keySize).toBe(448);
  });

  it("falls back to Node's reported bit count for a curve name not in the shared table (never a guessed default, but not silently undefined either)", () => {
    const [kex] = observationsFromTlsHandshake("project:1", {
      host: "h",
      port: 1,
      protocolVersion: "TLSv1.2",
      cipherSuiteName: "x",
      keyExchange: { type: "ECDH", name: "some-future-curve", bits: 512 },
    });
    expect(kex.keySize).toBe(512);
  });

  it("plain (non-elliptic) DH carries a bit size but no curve name", () => {
    const [kex] = observationsFromTlsHandshake("project:1", {
      host: "h",
      port: 1,
      protocolVersion: "TLSv1.2",
      cipherSuiteName: "DHE-RSA-AES256-GCM-SHA384",
      keyExchange: { type: "DH", bits: 2048 },
    });
    expect(kex.algorithm).toBe("ECDH/DH");
    expect(kex.keySize).toBe(2048);
    expect((kex.evidence as { keyExchangeGroup: string | null }).keyExchangeGroup).toBeNull();
  });

  it("emits only the certificate observation when the cipher offered no ephemeral key exchange (static RSA key transport)", () => {
    const observations = observationsFromTlsHandshake("project:1", {
      host: "h",
      port: 1,
      protocolVersion: "TLSv1.2",
      cipherSuiteName: "AES256-SHA",
      peerCertificatePublicKey: { keyType: "rsa", modulusBits: 2048 },
      // keyExchange deliberately absent — this is the case under test.
    });
    expect(observations).toHaveLength(1);
    expect(observations[0].algorithm).toBe("RSA");
  });

  it("TLS 1.3 with an undetermined group still emits a key-exchange observation, with keySize undefined — Node cannot report the group, but a group was mandatorily negotiated (RFC 8446)", () => {
    const [kex] = observationsFromTlsHandshake("project:1", {
      host: "h",
      port: 1,
      protocolVersion: "TLSv1.3",
      cipherSuiteName: "TLS_AES_256_GCM_SHA384",
      keyExchange: { type: "ECDH" }, // name/bits absent — the TLS 1.3 case
    });
    expect(kex.algorithm).toBe("ECDH/DH");
    expect(kex.keySize).toBeUndefined();
    expect((kex.evidence as { keyExchangeGroup: string | null }).keyExchangeGroup).toBeNull();
  });

  it("undetermined key size stays undefined, never a guessed default (G-05)", () => {
    const [kex] = observationsFromTlsHandshake("project:1", {
      host: "h",
      port: 1,
      protocolVersion: "TLSv1.2",
      cipherSuiteName: "x",
      keyExchange: { type: "DH" }, // no bits reported at all
    });
    expect(kex.keySize).toBeUndefined();
  });

  it("an unrecognised peer public key type is reported verbatim rather than mis-classified", () => {
    const [obs] = observationsFromTlsHandshake("project:1", {
      host: "h",
      port: 1,
      protocolVersion: "TLSv1.3",
      cipherSuiteName: "x",
      peerCertificatePublicKey: { keyType: "x25519" },
    });
    expect(obs.algorithm).toBe("X25519");
  });

  it("two projects probing the same host:port produce different locations, feeding the fingerprint's project scoping", () => {
    const [a] = observationsFromTlsHandshake("project:1", {
      host: "h", port: 443, protocolVersion: "TLSv1.3", cipherSuiteName: "x",
      keyExchange: { type: "ECDH", name: "X25519" },
    });
    const [b] = observationsFromTlsHandshake("project:2", {
      host: "h", port: 443, protocolVersion: "TLSv1.3", cipherSuiteName: "x",
      keyExchange: { type: "ECDH", name: "X25519" },
    });
    expect(a.location).not.toBe(b.location);
  });
});

describe("fingerprintForObservation — the network locationDetail bridge", () => {
  it("turns a TLS collector's network-kind observation into a tls FingerprintInput", () => {
    const [kex] = observationsFromTlsHandshake("project:1", {
      host: "example.com",
      port: 443,
      protocolVersion: "TLSv1.3",
      cipherSuiteName: "TLS_AES_256_GCM_SHA384",
      keyExchange: { type: "ECDH", name: "X25519" },
    });
    const input = fingerprintForObservation(kex, { repo: "project:1" });
    expect(input).toEqual({ surface: "tls", repo: "project:1", host: "example.com", port: 443, algorithm: "ECDH/DH" });
  });

  it("is stable and matches computeFingerprint's own tls test", () => {
    const [kex] = observationsFromTlsHandshake("project:1", {
      host: "example.com",
      port: 443,
      protocolVersion: "TLSv1.3",
      cipherSuiteName: "x",
      keyExchange: { type: "ECDH", name: "X25519" },
    });
    const input = fingerprintForObservation(kex, { repo: "project:1" })!;
    expect(computeFingerprint(input)).toBe(
      computeFingerprint({ surface: "tls", repo: "project:1", host: "example.com", port: 443, algorithm: "ECDH/DH" }),
    );
  });

  it("returns undefined for a network locationDetail with no destinationPort — the tls variant cannot be built without one", () => {
    const observation = {
      algorithm: "RSA",
      location: "project:1:example.com",
      locationDetail: { kind: "network" as const, network: { hostname: "example.com" } },
      discoveryModality: "active_network_scan" as const,
      confidence: 1,
      evidence: {},
    };
    expect(fingerprintForObservation(observation, { repo: "project:1" })).toBeUndefined();
  });
});
