import { describe, it, expect } from "vitest";
import {
  canonicalDataAtRestAlgorithm,
  collectDataAtRestObservations,
  dataAtRestLocation,
  observationsFromDataAtRestStore,
  type DataAtRestStoreInput,
} from "./data-at-rest-collector";
import { computeFingerprint, fingerprintForObservation } from "./fingerprint";
import { LocationDetailSchema } from "./location-detail";

const REPO = "project:7";

function store(overrides: Partial<DataAtRestStoreInput> = {}): DataAtRestStoreInput {
  return { storeId: "billing", engine: "postgresql", ...overrides };
}

describe("canonicalDataAtRestAlgorithm", () => {
  it("reads the size a string states, in every spelling a config file uses", () => {
    expect(canonicalDataAtRestAlgorithm("AES-256-CBC")).toEqual({ algorithm: "AES", keySize: 256 });
    expect(canonicalDataAtRestAlgorithm("aes256")).toEqual({ algorithm: "AES", keySize: 256 });
    expect(canonicalDataAtRestAlgorithm("AES_128_GCM")).toEqual({ algorithm: "AES", keySize: 128 });
    expect(canonicalDataAtRestAlgorithm("rsa-2048")).toEqual({ algorithm: "RSA", keySize: 2048 });
  });

  it("gives a bare family name NO key size — the one place a helpful regex would invent a number", () => {
    // The failure this guards: "AES" quietly becoming 256 because that is the
    // common case. An invented size is indistinguishable from a measured one
    // once it is a row (G-05).
    expect(canonicalDataAtRestAlgorithm("AES")).toEqual({ algorithm: "AES" });
    expect(canonicalDataAtRestAlgorithm("RSA")).toEqual({ algorithm: "RSA" });
    expect(canonicalDataAtRestAlgorithm("aes-gcm")).toEqual({ algorithm: "AES" });
  });

  it("resolves ECB to its own entry, because it is a different standards position, not a mode footnote", () => {
    expect(canonicalDataAtRestAlgorithm("AES-128-ECB")).toEqual({ algorithm: "AES-ECB", keySize: 128 });
    // Every other mode is evidence, not identity.
    expect(canonicalDataAtRestAlgorithm("AES-256-XTS")).toEqual({ algorithm: "AES", keySize: 256 });
  });

  it("maps every key-agreement spelling onto the one entry the standards data has", () => {
    for (const reported of ["ECDH", "ECDHE", "DH", "X25519"]) {
      expect(canonicalDataAtRestAlgorithm(reported)?.algorithm, reported).toBe("ECDH/DH");
    }
    expect(canonicalDataAtRestAlgorithm("ECDH-P-384")).toEqual({ algorithm: "ECDH/DH", keySize: 384 });
  });

  it("takes the size that follows the family, not the first number in the string", () => {
    expect(canonicalDataAtRestAlgorithm("TLS_AES_256_GCM_SHA384")).toEqual({ algorithm: "AES", keySize: 256 });
  });

  it("returns undefined for a name the standards data has no entry for, rather than the nearest neighbour", () => {
    // 3DES, ChaCha20 and Blowfish are all real answers a store might give and
    // none of them are in algorithms.json. Bending them onto AES would put a
    // wrong algorithm in the inventory, which is worse than a reported gap.
    expect(canonicalDataAtRestAlgorithm("3DES")).toBeUndefined();
    expect(canonicalDataAtRestAlgorithm("ChaCha20-Poly1305")).toBeUndefined();
    expect(canonicalDataAtRestAlgorithm("vendor-proprietary")).toBeUndefined();
  });
});

describe("observationsFromDataAtRestStore", () => {
  it("records the bulk cipher and the key wrapping as two separate assets", () => {
    const result = observationsFromDataAtRestStore(
      REPO,
      store({
        encryptionState: "encrypted",
        dataEncryption: { algorithm: "AES-256-CBC" },
        keyProtection: { algorithm: "RSA-2048", source: "aws-kms" },
      }),
    );

    expect(result.observations.map((o) => o.algorithm)).toEqual(["AES", "RSA"]);
    expect(result.observations.map((o) => o.location)).toEqual([
      dataAtRestLocation(REPO, "postgresql", "billing", "data-encryption"),
      dataAtRestLocation(REPO, "postgresql", "billing", "key-protection"),
    ]);
    expect(result.gaps).toEqual([]);

    // The whole reason both halves are recorded: only one of them is what
    // Q-Day breaks, and a collector that recorded the cipher alone would report
    // this store as carrying nothing quantum-vulnerable.
    const fingerprints = result.observations.map((o) => {
      const input = fingerprintForObservation(o, { repo: REPO });
      expect(input?.surface).toBe("data-at-rest");
      return computeFingerprint(input!);
    });
    expect(new Set(fingerprints).size).toBe(2);
  });

  it("keeps a store's two halves distinct even when they are the same algorithm", () => {
    // An AES data key wrapped by an AES key-encryption key is an ordinary key
    // hierarchy. Without the role in the identity these two collide into one
    // asset — the reason `fingerprint.ts`'s variant carries it.
    const result = observationsFromDataAtRestStore(
      REPO,
      store({
        encryptionState: "encrypted",
        dataEncryption: { algorithm: "AES-256" },
        keyProtection: { algorithm: "AES-256" },
      }),
    );

    const fingerprints = result.observations.map((o) => computeFingerprint(fingerprintForObservation(o, { repo: REPO })!));
    expect(result.observations).toHaveLength(2);
    expect(new Set(fingerprints).size).toBe(2);
  });

  it("records NOTHING for a store reported as encrypted with no cipher named", () => {
    // The case B7 exists to keep honest. "Encrypted: yes" with no algorithm is
    // a real and common answer and must never become AES-256.
    const result = observationsFromDataAtRestStore(REPO, store({ encryptionState: "encrypted" }));

    expect(result.observations).toEqual([]);
    expect(result.gaps).toEqual([
      { role: "data-encryption", reason: "cipher-not-reported" },
      { role: "key-protection", reason: "key-protection-not-reported" },
    ]);
  });

  it("leaves an unreported cipher OUT of the reobservation scope, so a blank field cannot mark a prior asset gone", () => {
    // The silent-false-remediation case. A resubmission that still says
    // "encrypted" but leaves the cipher blank has observed nothing about that
    // slot; putting it in scope would retire a real recorded cipher because a
    // field was left empty.
    const blank = observationsFromDataAtRestStore(REPO, store({ encryptionState: "encrypted" }));
    expect(blank.reobservedLocations).toEqual([]);

    const unrecognised = observationsFromDataAtRestStore(
      REPO,
      store({ encryptionState: "encrypted", dataEncryption: { algorithm: "3DES" } }),
    );
    expect(unrecognised.reobservedLocations).toEqual([]);
    expect(unrecognised.gaps).toContainEqual({
      role: "data-encryption",
      reason: "algorithm-not-recognised",
      reported: "3DES",
    });
  });

  it("puts both slots in scope for a store stated to be NOT encrypted — a positive statement of absence", () => {
    const result = observationsFromDataAtRestStore(REPO, store({ encryptionState: "not-encrypted" }));

    expect(result.observations).toEqual([]);
    expect(result.reobservedLocations).toEqual([
      dataAtRestLocation(REPO, "postgresql", "billing", "data-encryption"),
      dataAtRestLocation(REPO, "postgresql", "billing", "key-protection"),
    ]);
  });

  it("says nothing at all about a store whose encryption state is unknown", () => {
    // `unknown` is not `not-encrypted`. Nobody checked, so nothing is in scope
    // and nothing is recorded — only the gap is reported.
    const result = observationsFromDataAtRestStore(REPO, store());

    expect(result.observations).toEqual([]);
    expect(result.reobservedLocations).toEqual([]);
    expect(result.gaps.map((g) => g.reason)).toEqual(["encryption-state-unknown", "encryption-state-unknown"]);
  });

  it("prefers the caller's explicit key size over anything parsed out of the string", () => {
    const result = observationsFromDataAtRestStore(
      REPO,
      store({ encryptionState: "encrypted", dataEncryption: { algorithm: "AES", keySize: 192 } }),
    );
    expect(result.observations[0].keySize).toBe(192);
  });

  it("leaves keySize undefined when neither the caller nor the string states one", () => {
    const result = observationsFromDataAtRestStore(
      REPO,
      store({ encryptionState: "encrypted", dataEncryption: { algorithm: "AES" } }),
    );
    expect(result.observations[0].keySize).toBeUndefined();
  });

  it("carries the evidence source into the modality and confidence, defaulting to the weaker of the two", () => {
    const configured = observationsFromDataAtRestStore(
      REPO,
      store({ encryptionState: "encrypted", evidenceSource: "configuration-report", dataEncryption: { algorithm: "AES-256" } }),
    );
    expect(configured.observations[0].discoveryModality).toBe("configuration_information");
    expect(configured.observations[0].confidence).toBe(0.6);

    const defaulted = observationsFromDataAtRestStore(
      REPO,
      store({ encryptionState: "encrypted", dataEncryption: { algorithm: "AES-256" } }),
    );
    expect(defaulted.observations[0].discoveryModality).toBe("manual_attestation");
    expect(defaulted.observations[0].confidence).toBe(0.4);
    expect(defaulted.observations[0].confidence).toBeLessThan(configured.observations[0].confidence);
  });

  it("emits a locationDetail the persistence boundary actually accepts, carrying the caller's original string", () => {
    const result = observationsFromDataAtRestStore(
      REPO,
      store({ encryptionState: "encrypted", dataEncryption: { algorithm: "AES-256-XTS", source: "software-keystore" } }),
    );

    const parsed = LocationDetailSchema.safeParse(result.observations[0].locationDetail);
    expect(parsed.success).toBe(true);
    expect(result.observations[0].locationDetail).toMatchObject({
      kind: "data-at-rest",
      dataAtRest: { reportedAlgorithm: "AES-256-XTS", keySource: "software-keystore", role: "data-encryption" },
    });
  });

  it("does not put the algorithm in the location, so a migration lands on the same slot", () => {
    // The case that matters on this surface: a store's key protection moving
    // off RSA. Same slot, so the ingest's reobservation scope covers the
    // superseded asset and marks it `gone`; different identity, so the new
    // algorithm is a new asset rather than an edit to the old one.
    const before = observationsFromDataAtRestStore(
      REPO,
      store({ encryptionState: "encrypted", keyProtection: { algorithm: "RSA-2048" } }),
    );
    const after = observationsFromDataAtRestStore(
      REPO,
      store({ encryptionState: "encrypted", keyProtection: { algorithm: "ECDH" } }),
    );

    expect(after.observations[0].location).toBe(before.observations[0].location);
    expect(computeFingerprint(fingerprintForObservation(after.observations[0], { repo: REPO })!)).not.toBe(
      computeFingerprint(fingerprintForObservation(before.observations[0], { repo: REPO })!),
    );
  });

  it("treats a key-size change as the same asset re-measured, exactly as every other surface does", () => {
    // AES-128 -> AES-256 is one asset whose measured key size moved, not a
    // replacement: `keySize` is deliberately absent from every fingerprint
    // variant (see the anti-requirement in fingerprint.ts). Recording it as a
    // new asset plus a `gone` one would render a routine rekey as a
    // remediation followed by a regression in the trend chart.
    const before = observationsFromDataAtRestStore(
      REPO,
      store({ encryptionState: "encrypted", dataEncryption: { algorithm: "AES-128" } }),
    );
    const after = observationsFromDataAtRestStore(
      REPO,
      store({ encryptionState: "encrypted", dataEncryption: { algorithm: "AES-256" } }),
    );

    expect(computeFingerprint(fingerprintForObservation(after.observations[0], { repo: REPO })!)).toBe(
      computeFingerprint(fingerprintForObservation(before.observations[0], { repo: REPO })!),
    );
    expect(before.observations[0].keySize).toBe(128);
    expect(after.observations[0].keySize).toBe(256);
  });

  it("keeps two projects' identically-named stores apart", () => {
    const mine = observationsFromDataAtRestStore(
      "project:1",
      store({ encryptionState: "encrypted", dataEncryption: { algorithm: "AES-256" } }),
    );
    const theirs = observationsFromDataAtRestStore(
      "project:2",
      store({ encryptionState: "encrypted", dataEncryption: { algorithm: "AES-256" } }),
    );

    expect(computeFingerprint(fingerprintForObservation(mine.observations[0], { repo: "project:1" })!)).not.toBe(
      computeFingerprint(fingerprintForObservation(theirs.observations[0], { repo: "project:2" })!),
    );
  });
});

describe("collectDataAtRestObservations", () => {
  it("returns one result per submitted store, in submission order", () => {
    const results = collectDataAtRestObservations(REPO, [
      store({ storeId: "a", encryptionState: "encrypted", dataEncryption: { algorithm: "AES-256" } }),
      store({ storeId: "b", encryptionState: "unknown" }),
    ]);

    expect(results.map((r) => r.storeId)).toEqual(["a", "b"]);
    expect(results[0].observations).toHaveLength(1);
    expect(results[1].observations).toHaveLength(0);
  });
});
