/**
 * B5 — the KMS / secret-store collector, end to end against the real stack:
 * real Postgres, real API server, real row-level security. No `page.route`
 * appears in this file; every assertion is against the real HTTP response
 * from the real server (`tests/e2e/support/fixtures.ts`'s one rule).
 *
 * This spec needs no environment flag and no network egress, which is a
 * property of the design rather than a convenience: the collector is
 * submission-based, so the key inventory under test is data in the request
 * body, not a credentialed call to a cloud provider. The submitted fixtures
 * are shaped like the real exports they stand in for — an AWS `describe-key`
 * with a spec, an AWS `list-keys` row with nothing but an ARN, an Azure key
 * whose JsonWebKey genuinely carries no key size.
 *
 * What would fail if B5 regressed, in order of how quietly the regression
 * would otherwise land:
 *
 *  1. a `NOT NULL DEFAULT` on `assets.key_size` — the Azure key's size comes
 *     back as a number instead of null;
 *  2. an uncatalogued primitive being mapped to the nearest catalogued one —
 *     the HMAC key acquires an algorithm;
 *  3. rotation state defaulting to `false` when the export was silent;
 *  4. the "examined nothing" branch widening to cover a fully-classified
 *     symmetric-only key store — coverage would report the surface as never
 *     examined;
 *  5. a partial resubmission retiring the keys it did not mention.
 */
import { test, expect } from "./support/fixtures";

interface KmsKeyOutcomeEntry {
  provider: string;
  keyId: string;
  keySpec: string | null;
  alias: string | null;
  keyState: string | null;
  outcome: "observed" | "no-algorithm" | "unrecognised-spec" | "no-spec";
  reason: string | null;
  algorithm: string | null;
  keySize: number | null;
  keySizeSource: "key-spec" | "curve" | "submitted" | "not-supplied" | null;
  rotationEnabled: boolean | null;
  location: string | null;
}

interface KmsIngestSummary {
  projectId: number;
  keysSubmitted: number;
  keysObserved: number;
  keysUnclassified: number;
  keys: KmsKeyOutcomeEntry[];
  collectionRunId: number | null;
  assetsCreated: number;
  assetsUpdated: number;
  observationsCreated: number;
  assetsMarkedGone: number;
  evidenceCaveat: string;
}

interface ProjectKmsKey {
  assetId: number;
  provider: string;
  keyId: string;
  keySpec: string | null;
  algorithm: string;
  keySize: number | null;
  status: string;
  rotationEnabled: boolean | null;
  rotationPeriodDays: number | null;
  keyStore: string | null;
  region: string | null;
  firstSeen: string;
  lastSeen: string;
}

async function createProject(api: import("@playwright/test").APIRequestContext, name: string): Promise<number> {
  const res = await api.post("/api/projects", { data: { name, language: "python", code: "" } });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { id: number };
  return body.id;
}

test.describe("the KMS / secret-store collector (B5), end to end", () => {
  test("classifies a four-provider key inventory, records what it could not classify, and never invents a key size", async ({
    api,
  }) => {
    const projectId = await createProject(api, "kms-e2e-project");

    const res = await api.post(`/api/projects/${projectId}/kms`, {
      data: {
        keys: [
          // AWS describe-key: the spec states the modulus length outright.
          {
            provider: "aws-kms",
            keyId: "arn:aws:kms:eu-west-2:111122223333:key/1111-rsa",
            keySpec: "RSA_4096",
            alias: "alias/payments-signing",
            keyState: "Enabled",
            rotationEnabled: true,
            rotationPeriodDays: 365,
            origin: "AWS_KMS",
            region: "eu-west-2",
          },
          // The spec name states neither algorithm nor size; only AWS's guide does.
          {
            provider: "aws-kms",
            keyId: "arn:aws:kms:eu-west-2:111122223333:key/2222-sym",
            keySpec: "SYMMETRIC_DEFAULT",
            keyState: "Enabled",
          },
          // An AWS list-keys row: an ARN and nothing else.
          { provider: "aws-kms", keyId: "arn:aws:kms:eu-west-2:111122223333:key/3333-listed-only" },
          // Azure: kty states the algorithm, and a JsonWebKey has no key_size member at all.
          {
            provider: "azure-key-vault",
            keyId: "https://qx-e2e.vault.azure.net/keys/signing/9fd8",
            keySpec: "RSA",
            keyState: "enabled",
            keyStore: "qx-e2e",
          },
          // Azure EC: the size lives in `crv`, resolved through the shared curve table.
          {
            provider: "azure-key-vault",
            keyId: "https://qx-e2e.vault.azure.net/keys/ec/aa01",
            keySpec: "EC-HSM",
            curve: "P-384",
          },
          // GCP: the enum's own description states ECDSA and the curve.
          {
            provider: "gcp-kms",
            keyId: "projects/qx/locations/europe-west2/keyRings/r/cryptoKeys/c/cryptoKeyVersions/1",
            keySpec: "EC_SIGN_P256_SHA256",
            keyStore: "r",
            region: "europe-west2",
          },
          // Vault transit: catalogued spec, uncatalogued primitive.
          { provider: "hashicorp-vault", keyId: "transit/keys/session", keySpec: "chacha20-poly1305" },
          // A spec the curated table does not carry — our data is behind the provider.
          { provider: "gcp-kms", keyId: "projects/qx/.../future", keySpec: "RSA_SIGN_PSS_8192_SHA512" },
        ],
      },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as KmsIngestSummary;

    expect(body.projectId).toBe(projectId);
    expect(body.keysSubmitted).toBe(8);
    expect(body.keysObserved).toBe(5);
    expect(body.keysUnclassified).toBe(3);
    expect(body.collectionRunId).not.toBeNull();
    expect(body.assetsCreated).toBe(5);
    expect(body.evidenceCaveat.length).toBeGreaterThan(0);
    // Every key comes back, not only the classified ones — a response listing
    // five would read as a complete inventory of five keys.
    expect(body.keys).toHaveLength(8);

    const byId = new Map(body.keys.map((k) => [k.keyId, k]));
    const get = (id: string): KmsKeyOutcomeEntry => {
      const entry = byId.get(id);
      expect(entry, `key ${id} missing from the response`).toBeTruthy();
      return entry!;
    };

    expect(get("arn:aws:kms:eu-west-2:111122223333:key/1111-rsa")).toMatchObject({
      outcome: "observed",
      algorithm: "RSA",
      keySize: 4096,
      keySizeSource: "key-spec",
      rotationEnabled: true,
    });
    expect(get("arn:aws:kms:eu-west-2:111122223333:key/2222-sym")).toMatchObject({
      outcome: "observed",
      algorithm: "AES",
      keySize: 256,
    });
    expect(get("https://qx-e2e.vault.azure.net/keys/ec/aa01")).toMatchObject({
      outcome: "observed",
      algorithm: "ECDSA",
      keySize: 384,
      keySizeSource: "curve",
    });
    expect(get("projects/qx/locations/europe-west2/keyRings/r/cryptoKeys/c/cryptoKeyVersions/1")).toMatchObject({
      outcome: "observed",
      algorithm: "ECDSA",
      keySize: 256,
    });

    // G-05, at ingest time: Azure states the algorithm and no size. The honest
    // answer is null, and `keySizeSource` says why rather than leaving a
    // reader to wonder whether the pipeline dropped it.
    expect(get("https://qx-e2e.vault.azure.net/keys/signing/9fd8")).toMatchObject({
      outcome: "observed",
      algorithm: "RSA",
      keySize: null,
      keySizeSource: "not-supplied",
    });

    // A catalogued spec whose primitive this product does not report on. The
    // key is counted and named; it does not acquire an algorithm.
    const chacha = get("transit/keys/session");
    expect(chacha.outcome).toBe("no-algorithm");
    expect(chacha.algorithm).toBeNull();
    expect(chacha.reason).toEqual(expect.any(String));
    expect(chacha.reason!.length).toBeGreaterThan(0);

    // The three non-observed outcomes stay distinct: only this one is fixed
    // by adding a row to kms-key-specs.json.
    expect(get("projects/qx/.../future").outcome).toBe("unrecognised-spec");
    expect(get("arn:aws:kms:eu-west-2:111122223333:key/3333-listed-only").outcome).toBe("no-spec");

    // "Not stated" is never rendered as `false` — the export said nothing
    // about rotation for any key but the first.
    expect(get("arn:aws:kms:eu-west-2:111122223333:key/2222-sym").rotationEnabled).toBeNull();

    // ── The inventory read: what a caller who was not watching the upload
    // sees later, and the only check that proves the nulls survived the
    // round trip through Postgres.
    const inventoryRes = await api.get(`/api/projects/${projectId}/kms`);
    expect(inventoryRes.status()).toBe(200);
    const inventory = (await inventoryRes.json()) as { projectId: number; keys: ProjectKmsKey[] };
    expect(inventory.projectId).toBe(projectId);
    expect(inventory.keys).toHaveLength(5);

    const azure = inventory.keys.find((k) => k.keyId.endsWith("/signing/9fd8"));
    expect(azure, "the Azure key is missing from the persisted inventory").toBeTruthy();
    expect(azure!.algorithm).toBe("RSA");
    // The regression this line exists for: a NOT NULL DEFAULT on
    // assets.key_size would make this a number and nothing else would notice.
    expect(azure!.keySize).toBeNull();
    expect(azure!.rotationEnabled).toBeNull();
    expect(azure!.status).toBe("active");

    const rotated = inventory.keys.find((k) => k.keyId.endsWith("/1111-rsa"));
    expect(rotated!.rotationEnabled).toBe(true);
    expect(rotated!.rotationPeriodDays).toBe(365);
    expect(rotated!.keySize).toBe(4096);
    expect(rotated!.region).toBe("eu-west-2");

    // ── D3: the surface now counts as examined, which is the bar
    // `surface-catalogue.ts` sets before an entry may say `live`.
    const coverageRes = await api.get(`/api/projects/${projectId}/coverage`);
    expect(coverageRes.status()).toBe(200);
    const coverage = (await coverageRes.json()) as {
      surfaces: Array<{ surface: string; state: string; activeAssets: number }>;
    };
    const kms = coverage.surfaces.find((s) => s.surface === "kms");
    expect(kms, "kms surface absent from coverage — the collector ran but coverage did not see it").toBeTruthy();
    expect(kms!.state).toBe("examined");
    expect(kms!.activeAssets).toBe(5);
  });

  test("a key store holding nothing this product reports on was still examined", async ({ api }) => {
    // The honesty distinction that separates B5's run gate from every other
    // collector's. All three keys are classified successfully; none of their
    // primitives is on this product's list. Refusing to record a run here
    // would tell a CISO their key store had never been looked at.
    const projectId = await createProject(api, "kms-e2e-symmetric-only");

    const res = await api.post(`/api/projects/${projectId}/kms`, {
      data: {
        keys: [
          { provider: "aws-kms", keyId: "arn:aws:kms:eu-west-2:1:key/mac", keySpec: "HMAC_512" },
          { provider: "gcp-kms", keyId: "projects/qx/.../mac", keySpec: "HMAC_SHA256" },
          { provider: "azure-key-vault", keyId: "https://qx.vault.azure.net/keys/wrap/1", keySpec: "oct-HSM" },
        ],
      },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as KmsIngestSummary;
    expect(body.keysObserved).toBe(0);
    expect(body.keysUnclassified).toBe(3);
    expect(body.observationsCreated).toBe(0);
    expect(body.collectionRunId).not.toBeNull();
    // The HMAC key spec states its length even though its algorithm is not
    // catalogued — free information about a key we cannot classify.
    expect(body.keys.find((k) => k.keySpec === "HMAC_512")!.keySize).toBe(512);

    const coverage = (await (await api.get(`/api/projects/${projectId}/coverage`)).json()) as {
      surfaces: Array<{ surface: string; state: string }>;
    };
    expect(coverage.surfaces.find((s) => s.surface === "kms")?.state).toBe("examined-nothing-found");
  });

  test("a submission with no keys examines nothing — no run is recorded, not a run that found zero", async ({ api }) => {
    const projectId = await createProject(api, "kms-e2e-empty");

    const res = await api.post(`/api/projects/${projectId}/kms`, { data: { keys: [] } });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as KmsIngestSummary;
    expect(body.collectionRunId).toBeNull();
    expect(body.keys).toEqual([]);

    // Absent from the coverage payload entirely — how "never examined" is
    // expressed on the wire, and the other half of the previous test.
    const coverage = (await (await api.get(`/api/projects/${projectId}/coverage`)).json()) as {
      surfaces: Array<{ surface: string }>;
    };
    expect(coverage.surfaces.find((s) => s.surface === "kms")).toBeUndefined();
  });

  test("a partial resubmission updates the keys it names and retires none of the ones it omits", async ({ api }) => {
    // Every realistic export is partial — one page of a paginated list-keys,
    // one region, one Vault mount. Inferring deletion from absence here is
    // the silent mass false remediation the reobservation-scope rule exists
    // to prevent.
    const projectId = await createProject(api, "kms-e2e-partial");

    const first = await api.post(`/api/projects/${projectId}/kms`, {
      data: {
        keys: [
          { provider: "aws-kms", keyId: "arn:aws:kms:eu-west-2:1:key/a", keySpec: "RSA_2048" },
          { provider: "aws-kms", keyId: "arn:aws:kms:eu-west-2:1:key/b", keySpec: "ECC_NIST_P384" },
        ],
      },
    });
    expect(((await first.json()) as KmsIngestSummary).assetsCreated).toBe(2);

    // Page two of the same export mentions only the first key, and re-keys it.
    const second = await api.post(`/api/projects/${projectId}/kms`, {
      data: { keys: [{ provider: "aws-kms", keyId: "arn:aws:kms:eu-west-2:1:key/a", keySpec: "RSA_4096" }] },
    });
    const secondBody = (await second.json()) as KmsIngestSummary;
    expect(secondBody.assetsCreated).toBe(0);
    expect(secondBody.assetsUpdated).toBe(1);
    expect(secondBody.assetsMarkedGone).toBe(0);

    const inventory = (await (await api.get(`/api/projects/${projectId}/kms`)).json()) as { keys: ProjectKmsKey[] };
    expect(inventory.keys).toHaveLength(2);
    const a = inventory.keys.find((k) => k.keyId.endsWith("key/a"));
    const b = inventory.keys.find((k) => k.keyId.endsWith("key/b"));
    // Re-keying updated the asset in place rather than minting a second one —
    // identity is provider + key id, never the algorithm or size.
    expect(a!.keySize).toBe(4096);
    expect(a!.status).toBe("active");
    // And the key page two never mentioned is untouched, not `gone`.
    expect(b!.status).toBe("active");
    expect(b!.keySize).toBe(384);
  });

  test("an unauthenticated caller is refused, not shown an empty key inventory", async ({ publicApi, api }) => {
    const projectId = await createProject(api, "kms-e2e-auth");

    const postRes = await publicApi.post(`/api/projects/${projectId}/kms`, { data: { keys: [] } });
    expect(postRes.status()).toBe(401);

    const getRes = await publicApi.get(`/api/projects/${projectId}/kms`);
    expect(getRes.status()).toBe(401);
  });

  test("naming a project id that does not exist is 404, not a silently empty result", async ({ api }) => {
    const res = await api.post("/api/projects/999999999/kms", {
      data: { keys: [{ provider: "aws-kms", keyId: "arn:aws:kms:eu-west-2:1:key/x", keySpec: "RSA_2048" }] },
    });
    expect(res.status()).toBe(404);

    const getRes = await api.get("/api/projects/999999999/kms");
    expect(getRes.status()).toBe(404);
  });
});
