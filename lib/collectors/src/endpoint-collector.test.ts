import { describe, expect, it } from "vitest";
import {
  collectEndpointObservations,
  endpointCertificateStoreComponent,
  endpointLocation,
  ENDPOINT_CIPHER_SUITES_COMPONENT,
  ENDPOINT_CONFIDENCE,
  observationsFromEndpointHost,
} from "./endpoint-collector";
import { TLS_HANDSHAKE_CONFIDENCE } from "./tls-collector";
import { PROTOCOL_CONFIG_CONFIDENCE } from "./protocol-config-collector";
import { computeFingerprint, fingerprintForObservation } from "./fingerprint";
import { LocationDetailSchema } from "./location-detail";
import type { EndpointHostReport } from "./endpoint-report";

const REPO = "project:7";
const MACHINE = "9f5a1e2c-4b6d-4f21-9c11-6a7b8c9d0e1f";

function host(overrides: Partial<EndpointHostReport> = {}): EndpointHostReport {
  return {
    machineId: MACHINE,
    machineIdSource: "windows-machine-guid",
    hostname: "DC-01",
    os: { family: "windows", name: "Windows Server 2022 Datacenter", build: "20348.2402" },
    ...overrides,
  };
}

describe("observationsFromEndpointHost — what a host report becomes", () => {
  it("reports an enabled suite as permitted and a machine-store certificate as materialised", () => {
    const result = observationsFromEndpointHost(
      REPO,
      host({
        certificateStores: [
          {
            store: "LocalMachine\\My",
            certificates: [
              { thumbprint: "AA11", publicKeyAlgorithm: "RSA", keySize: 2048, subject: "CN=dc-01", hasPrivateKey: true },
            ],
          },
        ],
        tlsPolicy: { provider: "schannel", cipherSuites: [{ name: "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384", enabled: true }] },
      }),
    );

    const certificate = result.observations.find((o) => o.locationDetail?.kind === "endpoint" && o.locationDetail.endpoint.certificate);
    expect(certificate).toMatchObject({
      algorithm: "RSA",
      keySize: 2048,
      discoveryModality: "endpoint_monitoring",
      confidence: ENDPOINT_CONFIDENCE.materialised,
      location: `${REPO}:endpoint:${MACHINE}:certificate-store:LocalMachine\\My`,
    });

    const suites = result.observations.filter((o) => o.location.endsWith(ENDPOINT_CIPHER_SUITES_COMPONENT));
    expect(suites.map((o) => o.algorithm)).toEqual(["ECDH", "RSA", "AES"]);
    expect(suites.every((o) => o.confidence === ENDPOINT_CONFIDENCE.permitted)).toBe(true);
    expect(suites.find((o) => o.algorithm === "AES")?.keySize).toBe(256);
  });

  it("carries the host around the fact, and every profile validates", () => {
    const result = observationsFromEndpointHost(
      REPO,
      host({
        providers: [{ name: "Microsoft Platform Crypto Provider", kind: "cng-ksp", loaded: true }],
        tlsPolicy: {
          provider: "schannel",
          protocols: [{ name: "TLS 1.0", role: "Server", enabled: false }],
          cipherSuites: [{ name: "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384", enabled: true }],
        },
      }),
    );

    for (const observation of result.observations) {
      expect(LocationDetailSchema.safeParse(observation.locationDetail).success).toBe(true);
    }
    const detail = result.observations[0].locationDetail;
    expect(detail?.kind).toBe("endpoint");
    if (detail?.kind !== "endpoint") throw new Error("unreachable");
    expect(detail.endpoint.hostname).toBe("DC-01");
    expect(detail.endpoint.os?.build).toBe("20348.2402");
    expect(detail.endpoint.tlsPolicy?.disabledProtocols).toEqual(["TLS 1.0 (Server)"]);
    expect(detail.endpoint.providers?.[0].name).toBe("Microsoft Platform Crypto Provider");
  });

  it("takes the store's stated key size verbatim, and leaves it undetermined when the store states none", () => {
    const result = observationsFromEndpointHost(
      REPO,
      host({
        certificateStores: [
          {
            store: "LocalMachine\\My",
            certificates: [
              { thumbprint: "BB22", publicKeyAlgorithm: "ECC", keySize: 384 },
              // `ECC` names no curve. An undetermined size is the honest answer;
              // a defaulted 256 would be a fabricated measurement (G-05).
              { thumbprint: "CC33", publicKeyAlgorithm: "ECC" },
              // Ed25519's identifier fixes its size, so this one is a read.
              { thumbprint: "DD44", publicKeyAlgorithm: "ED25519" },
            ],
          },
        ],
      }),
    );
    expect(result.observations.map((o) => [o.algorithm, o.keySize])).toEqual([
      ["ECDSA", 384],
      ["ECDSA", undefined],
      ["EdDSA", 256],
    ]);
  });

  it("sits below B3's observed handshake and beside B6's equivalent claims", () => {
    // The evidence ladder is the product's credibility, so the ordering is
    // asserted against the other collectors rather than left to prose.
    expect(ENDPOINT_CONFIDENCE.permitted).toBe(PROTOCOL_CONFIG_CONFIDENCE.permitted);
    expect(ENDPOINT_CONFIDENCE.materialised).toBe(PROTOCOL_CONFIG_CONFIDENCE.materialised);
    expect(ENDPOINT_CONFIDENCE.permitted).toBeLessThan(ENDPOINT_CONFIDENCE.materialised);
    // A certificate as a store renders it is one remove from the artefact, so
    // it stays below B4's 0.9 for a parsed certificate...
    expect(ENDPOINT_CONFIDENCE.materialised).toBeLessThan(0.9);
    // ...and nothing here approaches an algorithm observed on the wire.
    expect(ENDPOINT_CONFIDENCE.materialised).toBeLessThan(TLS_HANDSHAKE_CONFIDENCE);
  });

  // ── false-positive controls ──

  it("reports nothing for a certificate whose key algorithm it does not recognise", () => {
    const result = observationsFromEndpointHost(
      REPO,
      host({
        certificateStores: [
          {
            store: "LocalMachine\\My",
            certificates: [
              // A post-quantum certificate: absent, not misclassified.
              { thumbprint: "EE55", publicKeyAlgorithm: "ML-DSA-65", keySize: 1952 },
              // No algorithm stated at all — and a subject that reads like one,
              // which must not be mined for a guess.
              { thumbprint: "FF66", subject: "CN=rsa-2048-legacy.example.com", keySize: 2048 },
            ],
          },
        ],
      }),
    );
    expect(result.observations).toEqual([]);
    // The store was still read, so its slot stays in scope: a certificate that
    // later disappears from it must still be retirable.
    expect(result.certificatesRead).toBe(2);
    expect(result.reobservedLocations).toEqual([`${REPO}:endpoint:${MACHINE}:certificate-store:LocalMachine\\My`]);
  });

  it("never reports a suite the host disabled by policy, even when the suite list still names it", () => {
    const result = observationsFromEndpointHost(
      REPO,
      host({
        tlsPolicy: {
          provider: "schannel",
          cipherSuites: [
            { name: "TLS_RSA_WITH_3DES_EDE_CBC_SHA", enabled: true },
            { name: "TLS_RSA_WITH_AES_128_CBC_SHA", enabled: true },
            { name: "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384", enabled: true },
          ],
          disabledAlgorithms: ["Triple DES 168", "AES 128/128"],
        },
      }),
    );
    // Only the surviving suite is reported, and it keeps its real 256-bit AES —
    // suppressing that too would be the mirror-image error.
    expect(result.observations.map((o) => [o.algorithm, o.keySize])).toEqual([
      ["ECDH", undefined],
      ["RSA", undefined],
      ["AES", 256],
    ]);
    expect(result.tlsPolicy?.suppressedSuites.map((s) => s.suite)).toEqual([
      "TLS_RSA_WITH_3DES_EDE_CBC_SHA",
      "TLS_RSA_WITH_AES_128_CBC_SHA",
    ]);
  });
});

describe("the reobservation scope is paired with what the host actually reported", () => {
  it("leaves a section the agent did not collect entirely out of scope", () => {
    // An agent that can read the TLS policy but not the machine stores must not
    // silently retire a host's keys — the silent false remediation
    // `ReobservationScope` exists to prevent.
    const result = observationsFromEndpointHost(
      REPO,
      host({ tlsPolicy: { provider: "schannel", cipherSuites: [{ name: "TLS_AES_256_GCM_SHA384", enabled: true }] } }),
    );
    expect(result.reobservedLocations).toEqual([endpointLocation(REPO, MACHINE, ENDPOINT_CIPHER_SUITES_COMPONENT)]);
  });

  it("puts a section that was read and is empty IN scope, so a removal retires", () => {
    // The case a scope derived from observations would miss: a host that pruned
    // its last weak suite produces nothing for that slot, and the removed suite
    // would stay `active` forever.
    const emptied = observationsFromEndpointHost(REPO, host({ tlsPolicy: { provider: "schannel", cipherSuites: [] } }));
    expect(emptied.observations).toEqual([]);
    expect(emptied.reobservedLocations).toEqual([endpointLocation(REPO, MACHINE, ENDPOINT_CIPHER_SUITES_COMPONENT)]);

    const emptyStore = observationsFromEndpointHost(
      REPO,
      host({ certificateStores: [{ store: "LocalMachine\\My", certificates: [] }] }),
    );
    expect(emptyStore.reobservedLocations).toEqual([
      endpointLocation(REPO, MACHINE, endpointCertificateStoreComponent("LocalMachine\\My")),
    ]);
  });

  it("keeps a policy that reports only protocols out of the cipher-suite slot", () => {
    const result = observationsFromEndpointHost(
      REPO,
      host({ tlsPolicy: { provider: "schannel", protocols: [{ name: "TLS 1.2", enabled: true }] } }),
    );
    expect(result.reobservedLocations).toEqual([]);
  });
});

describe("collectEndpointObservations — host identity across a submission", () => {
  it("keeps a skipped host in the result so the caller can report it by name", () => {
    const results = collectEndpointObservations(REPO, [
      host({ machineId: "CLONE", certificateStores: [] }),
      host({ machineId: "clone", hostname: "DC-02", certificateStores: [] }),
      host({ machineId: "REAL", hostname: "DC-03", certificateStores: [] }),
    ]);
    expect(results.map((r) => [r.hostname, r.skipped])).toEqual([
      ["DC-01", "duplicate-machine-id"],
      ["DC-02", "duplicate-machine-id"],
      ["DC-03", undefined],
    ]);
    // A skipped host contributes no scope, so nothing of its previous state is
    // retired on the strength of a report we refused to trust.
    expect(results[0].reobservedLocations).toEqual([]);
  });

  it("gives two hosts with identical policy two different assets", () => {
    // The whole reason the machine, not the file, is the identity here.
    const [a, b] = collectEndpointObservations(REPO, [
      host({ machineId: "HOST-A", tlsPolicy: { provider: "schannel", cipherSuites: [{ name: "TLS_AES_256_GCM_SHA384", enabled: true }] } }),
      host({ machineId: "HOST-B", tlsPolicy: { provider: "schannel", cipherSuites: [{ name: "TLS_AES_256_GCM_SHA384", enabled: true }] } }),
    ]);
    const fingerprintOf = (observation: (typeof a.observations)[number]) => {
      const input = fingerprintForObservation(observation, { repo: REPO });
      if (input === undefined) throw new Error("endpoint observation must be fingerprintable");
      expect(input.surface).toBe("endpoint");
      return computeFingerprint(input);
    };
    expect(fingerprintOf(a.observations[0])).not.toBe(fingerprintOf(b.observations[0]));
  });

  it("gives one host's AES-128 and AES-256 suites two different assets", () => {
    // Without the token in the identity these collapse to one `AES` asset whose
    // size is whichever suite the deduplication saw last.
    const [only] = collectEndpointObservations(REPO, [
      host({
        tlsPolicy: {
          provider: "schannel",
          cipherSuites: [
            { name: "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256", enabled: true },
            { name: "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384", enabled: true },
          ],
        },
      }),
    ]);
    const aes = only.observations.filter((o) => o.algorithm === "AES");
    expect(aes.map((o) => o.keySize)).toEqual([128, 256]);
    const fingerprints = aes.map((o) => computeFingerprint(fingerprintForObservation(o, { repo: REPO })!));
    expect(new Set(fingerprints).size).toBe(2);
  });

  it("keeps a host's identity stable across a rename, and changes it on a re-image", () => {
    const before = observationsFromEndpointHost(
      REPO,
      host({ hostname: "web-01", tlsPolicy: { provider: "schannel", cipherSuites: [{ name: "TLS_AES_256_GCM_SHA384", enabled: true }] } }),
    );
    const renamed = observationsFromEndpointHost(
      REPO,
      host({ hostname: "web-01-renamed", os: { family: "windows", build: "20348.9999" }, tlsPolicy: { provider: "schannel", cipherSuites: [{ name: "TLS_AES_256_GCM_SHA384", enabled: true }] } }),
    );
    const reimaged = observationsFromEndpointHost(
      REPO,
      host({ machineId: "a-new-guid", hostname: "web-01", tlsPolicy: { provider: "schannel", cipherSuites: [{ name: "TLS_AES_256_GCM_SHA384", enabled: true }] } }),
    );
    const fp = (r: typeof before) => computeFingerprint(fingerprintForObservation(r.observations[0], { repo: REPO })!);

    // A rename, an OS patch and a new build are the same machine.
    expect(fp(renamed)).toBe(fp(before));
    // A re-image mints a new MachineGuid, and it is genuinely a new host — even
    // though it took the retired machine's name, which is exactly the collision
    // a hostname identity would have merged.
    expect(fp(reimaged)).not.toBe(fp(before));
  });
});
