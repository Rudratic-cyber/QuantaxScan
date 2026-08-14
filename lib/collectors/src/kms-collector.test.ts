import { describe, expect, it } from "vitest";
import kmsKeySpecsData from "../../../docs/Claude/mappings/kms-key-specs.json" with { type: "json" };
import {
  KMS_KEY_CONFIDENCE,
  classifyKmsKeys,
  collectKmsObservations,
  kmsKeyLocation,
  type KmsKeyDescription,
} from "./kms-collector";
import { KMS_KEY_ALGORITHMS, KMS_KEY_SPECS, KMS_PROVIDER_VALUES, resolveKmsKeySpec } from "./kms-key-specs";
import { computeFingerprint, fingerprintForObservation } from "./fingerprint";
import { LocationDetailSchema } from "./location-detail";

const REPO = "project:7";

function key(overrides: Partial<KmsKeyDescription> & Pick<KmsKeyDescription, "provider" | "keyId">): KmsKeyDescription {
  return overrides as KmsKeyDescription;
}

describe("kms-key-specs.json — the curated table itself", () => {
  it("declares exactly the providers KMS_PROVIDER_VALUES names", () => {
    // The tuple exists for the literal union type; the data is the source of
    // truth for what is actually curated. This is the guard that stops them
    // drifting apart, which would let a submission name a provider that has
    // no spec rows at all and get `unrecognised-spec` for every key.
    expect(Object.keys(kmsKeySpecsData.providers).sort()).toEqual([...KMS_PROVIDER_VALUES].sort());
  });

  it("gives every spec row a verbatim quote, and every uncatalogued row a reason", () => {
    for (const entry of KMS_KEY_SPECS) {
      expect(entry.quote.length, `${entry.provider} ${entry.keySpec} has no quote`).toBeGreaterThan(0);
      if (entry.algorithm === null) {
        expect(entry.noAlgorithmReason, `${entry.provider} ${entry.keySpec}`).toBeTruthy();
      } else {
        expect(entry.noAlgorithmReason, `${entry.provider} ${entry.keySpec}`).toBeUndefined();
      }
    }
  });

  it("dates a provider's citation only where the claim is verified — an unverified claim carries no retrievedAt", () => {
    // The rule crypto-packages.json states and check:standards depends on:
    // dating an unverified claim is the one failure the freshness check
    // cannot see.
    for (const [id, provider] of Object.entries(kmsKeySpecsData.providers)) {
      expect(provider.citation.url, id).toMatch(/^https:/);
      expect(provider.citation.retrievedAt, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const entry of KMS_KEY_SPECS) {
      // Rows carry no date of their own: four pages were read, not eighty-odd.
      expect(Object.keys(entry)).not.toContain("retrievedAt");
    }
  });

  it("never lists the same provider+spec twice", () => {
    const seen = KMS_KEY_SPECS.map((e) => `${e.provider} ${e.keySpec.toLowerCase()}`);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("resolves a spec case-insensitively but never across providers", () => {
    expect(resolveKmsKeySpec("aws-kms", "rsa_4096")?.keySize).toBe(4096);
    expect(resolveKmsKeySpec("hashicorp-vault", "AES256-GCM96")?.algorithm).toBe("AES");
    // AWS's RSA_4096 must not answer for a Vault key store that has no such
    // type: a provider id is our vocabulary and is matched exactly.
    expect(resolveKmsKeySpec("hashicorp-vault", "RSA_4096")).toBeUndefined();
  });
});

describe("classifyKmsKeys — the four outcomes", () => {
  it("maps a self-describing asymmetric spec to its algorithm and stated size", () => {
    const [outcome] = classifyKmsKeys(REPO, [
      key({ provider: "aws-kms", keyId: "arn:aws:kms:eu-west-2:111122223333:key/abc", keySpec: "RSA_4096" }),
    ]);
    expect(outcome.kind).toBe("observed");
    if (outcome.kind !== "observed") return;
    expect(outcome.observation.algorithm).toBe("RSA");
    expect(outcome.observation.keySize).toBe(4096);
    expect(outcome.observation.confidence).toBe(KMS_KEY_CONFIDENCE);
    expect(outcome.observation.discoveryModality).toBe("configuration_information");
    expect(outcome.observation.evidence["keySizeSource"]).toBe("key-spec");
  });

  it("maps a spec whose name states nothing, using the provider's own documented claim", () => {
    // The rows the citation actually earns its keep on: neither name says
    // "AES" or "256".
    const outcomes = classifyKmsKeys(REPO, [
      key({ provider: "aws-kms", keyId: "k1", keySpec: "SYMMETRIC_DEFAULT" }),
      key({ provider: "gcp-kms", keyId: "k2", keySpec: "GOOGLE_SYMMETRIC_ENCRYPTION" }),
    ]);
    for (const outcome of outcomes) {
      expect(outcome.kind).toBe("observed");
      if (outcome.kind !== "observed") continue;
      expect(outcome.observation.algorithm).toBe("AES");
      expect(outcome.observation.keySize).toBe(256);
      expect(String(outcome.observation.evidence["keySpecQuote"])).toMatch(/AES/);
    }
  });

  it("records a null key size for a key whose provider states none — never a guessed default (G-05)", () => {
    // An Azure JsonWebKey has no key_size member and its list operation
    // returns no key type at all, so `kty: RSA` with nothing else is the
    // real shape of an Azure export, not a contrived one.
    const [outcome] = classifyKmsKeys(REPO, [
      key({ provider: "azure-key-vault", keyId: "https://v.vault.azure.net/keys/signing/9f", keySpec: "RSA" }),
    ]);
    expect(outcome.kind).toBe("observed");
    if (outcome.kind !== "observed") return;
    expect(outcome.observation.algorithm).toBe("RSA");
    expect(outcome.observation.keySize).toBeUndefined();
    expect("keySize" in outcome.observation).toBe(false);
    expect(outcome.observation.evidence["keySizeSource"]).toBe("not-supplied");
  });

  it("resolves an Azure EC key's size from its curve, through the shared named-curve table", () => {
    const [outcome] = classifyKmsKeys(REPO, [
      key({ provider: "azure-key-vault", keyId: "kid", keySpec: "EC-HSM", curve: "P-384" }),
    ]);
    expect(outcome.kind).toBe("observed");
    if (outcome.kind !== "observed") return;
    expect(outcome.observation.algorithm).toBe("ECDSA");
    expect(outcome.observation.keySize).toBe(384);
    expect(outcome.observation.evidence["keySizeSource"]).toBe("curve");
  });

  it("accepts a caller-supplied size only where the provider states none, and never over one it does state", () => {
    const [azure, aws] = classifyKmsKeys(REPO, [
      key({ provider: "azure-key-vault", keyId: "kid", keySpec: "RSA", keySize: 3072 }),
      // A typo, or an operator's stale note. The AWS guide is not overridable
      // by it: RSA_2048 is 2048 bits by definition.
      key({ provider: "aws-kms", keyId: "k", keySpec: "RSA_2048", keySize: 4096 }),
    ]);
    expect(azure.kind === "observed" && azure.observation.keySize).toBe(3072);
    expect(azure.kind === "observed" && azure.observation.evidence["keySizeSource"]).toBe("submitted");
    expect(aws.kind === "observed" && aws.observation.keySize).toBe(2048);
    expect(aws.kind === "observed" && aws.observation.evidence["keySizeSource"]).toBe("key-spec");
  });

  it("reports a known spec with an uncatalogued primitive as examined-and-unreportable, not as a failure", () => {
    const outcomes = classifyKmsKeys(REPO, [
      key({ provider: "aws-kms", keyId: "h", keySpec: "HMAC_512" }),
      key({ provider: "hashicorp-vault", keyId: "c", keySpec: "chacha20-poly1305" }),
      key({ provider: "azure-key-vault", keyId: "o", keySpec: "oct-HSM" }),
      key({ provider: "gcp-kms", keyId: "m", keySpec: "PQ_SIGN_ML_DSA_87" }),
    ]);
    for (const outcome of outcomes) {
      expect(outcome.kind, JSON.stringify(outcome.key)).toBe("no-algorithm");
      if (outcome.kind !== "no-algorithm") continue;
      expect(outcome.reason.length).toBeGreaterThan(0);
    }
    // And none of them produced an observation: an uncatalogued primitive
    // must not arrive as the nearest catalogued name.
    expect(collectKmsObservations(REPO, outcomes.map((o) => o.key))).toEqual([]);
  });

  it("distinguishes a spec our table lacks from one the export never stated", () => {
    const [unknown, absent, blank] = classifyKmsKeys(REPO, [
      key({ provider: "aws-kms", keyId: "k", keySpec: "RSA_8192" }),
      key({ provider: "aws-kms", keyId: "arn:aws:kms:eu-west-2:1:key/listed-only" }),
      key({ provider: "aws-kms", keyId: "k2", keySpec: "   " }),
    ]);
    // Our data is behind the provider — the actionable one.
    expect(unknown.kind).toBe("unrecognised-spec");
    // A list-without-describe export. Not actionable by a data update.
    expect(absent.kind).toBe("no-spec");
    expect(blank.kind).toBe("no-spec");
  });

  it("never emits an algorithm outside the curated table's own list", () => {
    const observations = collectKmsObservations(
      REPO,
      KMS_KEY_SPECS.map((entry, i) => key({ provider: entry.provider as never, keyId: `k${i}`, keySpec: entry.keySpec })),
    );
    for (const observation of observations) {
      expect(KMS_KEY_ALGORITHMS).toContain(observation.algorithm);
    }
    expect(observations.length).toBe(KMS_KEY_SPECS.filter((e) => e.algorithm !== null).length);
  });
});

describe("rotation state — 'not stated' and 'not rotated' are different claims", () => {
  it("omits rotationEnabled entirely when the export did not state it", () => {
    const [outcome] = classifyKmsKeys(REPO, [key({ provider: "aws-kms", keyId: "k", keySpec: "RSA_2048" })]);
    expect(outcome.kind).toBe("observed");
    if (outcome.kind !== "observed") return;
    const detail = outcome.observation.locationDetail;
    expect(detail?.kind).toBe("kms");
    if (detail?.kind !== "kms") return;
    // Not `false`. A default of false would state that this key is not
    // rotated, which is a finding nobody made a claim about.
    expect("rotationEnabled" in detail.kms).toBe(false);
    expect("rotationEnabled" in outcome.observation.evidence).toBe(false);
  });

  it("carries rotation state through verbatim when the export does state it, including false", () => {
    const [on, off] = classifyKmsKeys(REPO, [
      key({ provider: "aws-kms", keyId: "a", keySpec: "RSA_2048", rotationEnabled: true, rotationPeriodDays: 365 }),
      key({ provider: "aws-kms", keyId: "b", keySpec: "RSA_2048", rotationEnabled: false }),
    ]);
    expect(on.kind === "observed" && on.observation.locationDetail?.kind === "kms" && on.observation.locationDetail.kms.rotationEnabled).toBe(true);
    expect(on.kind === "observed" && on.observation.locationDetail?.kind === "kms" && on.observation.locationDetail.kms.rotationPeriodDays).toBe(365);
    expect(off.kind === "observed" && off.observation.locationDetail?.kind === "kms" && off.observation.locationDetail.kms.rotationEnabled).toBe(false);
  });
});

describe("identity — location, locationDetail and fingerprint", () => {
  it("produces a locationDetail the shared schema validates", () => {
    const [outcome] = classifyKmsKeys(REPO, [
      key({
        provider: "gcp-kms",
        keyId: "projects/p/locations/eu/keyRings/r/cryptoKeys/c/cryptoKeyVersions/3",
        keySpec: "EC_SIGN_P256_SHA256",
        alias: "signing",
        keyState: "ENABLED",
        keyStore: "r",
        region: "eu",
      }),
    ]);
    expect(outcome.kind).toBe("observed");
    if (outcome.kind !== "observed") return;
    expect(LocationDetailSchema.safeParse(outcome.observation.locationDetail).success).toBe(true);
  });

  it("locates a key by provider and key id, never by its repointable alias", () => {
    const [outcome] = classifyKmsKeys(REPO, [
      key({ provider: "aws-kms", keyId: "arn:aws:kms:eu-west-2:1:key/abc", keySpec: "RSA_2048", alias: "alias/payments" }),
    ]);
    expect(outcome.key.keyId).toBe("arn:aws:kms:eu-west-2:1:key/abc");
    if (outcome.kind !== "observed") return;
    expect(outcome.observation.location).toBe(kmsKeyLocation(REPO, "aws-kms", "arn:aws:kms:eu-west-2:1:key/abc"));
    expect(outcome.observation.location).not.toContain("alias/payments");
  });

  it("fingerprints to the kms surface, carrying the project so two projects sharing one key get two assets", () => {
    const description = key({ provider: "aws-kms", keyId: "arn:shared", keySpec: "RSA_2048" });
    const [mine] = collectKmsObservations("project:1", [description]);
    const [theirs] = collectKmsObservations("project:2", [description]);

    const a = fingerprintForObservation(mine, { repo: "project:1" });
    const b = fingerprintForObservation(theirs, { repo: "project:2" });
    expect(a?.surface).toBe("kms");
    expect(b?.surface).toBe("kms");
    // The whole reason `repo` was added to the variant: without it these
    // collide and the second submission silently steals the first
    // project's asset.
    expect(computeFingerprint(a!)).not.toBe(computeFingerprint(b!));
  });

  it("keeps one key's identity stable when its algorithm, size or rotation state changes", () => {
    // A re-keyed or rotated KMS key is the same key. If identity moved with
    // the algorithm, a modulus upgrade would render as a remediation
    // followed by a regression — the anti-requirement fingerprint.ts opens with.
    const before = collectKmsObservations(REPO, [key({ provider: "aws-kms", keyId: "k", keySpec: "RSA_2048" })])[0];
    const after = collectKmsObservations(REPO, [
      key({ provider: "aws-kms", keyId: "k", keySpec: "RSA_4096", rotationEnabled: true }),
    ])[0];
    expect(after.keySize).toBe(4096);
    expect(computeFingerprint(fingerprintForObservation(before, { repo: REPO })!)).toBe(
      computeFingerprint(fingerprintForObservation(after, { repo: REPO })!),
    );
  });
});
