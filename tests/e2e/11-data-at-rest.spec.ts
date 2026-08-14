/**
 * B7 — the data-at-rest collector, end to end against the real stack: real
 * Postgres, real API server, real row-level security.
 *
 * This surface is the product's whole thesis in one place. Harvest-now-
 * decrypt-later needs an adversary who can *keep* the ciphertext, and a backup
 * archive is the case where they genuinely can — so the question is not only
 * "what algorithm" but "how long does this data have to stay secret", and the
 * spec below is written around proving that the second half actually reaches
 * the risk engine rather than stopping at the inventory.
 *
 * No `page.route` appears in this file, per `support/fixtures.ts`'s one rule.
 * Every store below is submitted to the real API and every assertion is against
 * the real response — including the two negative ones, which are the honesty
 * cases and the easiest thing for a hollow spec to skip.
 */
import { test, expect } from "./support/fixtures";

type APIRequestContext = import("@playwright/test").APIRequestContext;

interface DataAtRestGap {
  role: "data-encryption" | "key-protection";
  reason: string;
  reported: string | null;
}

interface DataAtRestStoreResult {
  storeId: string;
  engine: string;
  recorded: Array<{ role: string; algorithm: string; keySize: number | null; reportedAlgorithm: string; location: string }>;
  gaps: DataAtRestGap[];
}

interface DataAtRestIngestSummary {
  projectId: number;
  storesSubmitted: number;
  storesWithRecordedCrypto: number;
  collectionRunId: number | null;
  assetsCreated: number;
  assetsUpdated: number;
  observationsCreated: number;
  assetsMarkedGone: number;
  stores: DataAtRestStoreResult[];
  evidenceCaveat: string;
}

interface DataAtRestComponent {
  assetId: number;
  role: "data-encryption" | "key-protection";
  algorithm: string;
  keySize: number | null;
  reportedAlgorithm: string;
  keySource: string | null;
  status: string;
  quantumVulnerable: boolean | null;
  mosca: { x: number; y: number; applicable: boolean; breachedScenarios: string[] };
}

interface ProjectDataAtRestStore {
  storeId: string;
  engine: string;
  encryptionState: string;
  dataClassification: string | null;
  secrecyLifetimeYears: number | null;
  classificationSource: "asset" | "project" | "default";
  xAssumed: boolean;
  secrecyLifetimeBasis: string;
  components: DataAtRestComponent[];
}

interface ProjectDataAtRest {
  projectId: number;
  stores: ProjectDataAtRestStore[];
  framing: string;
}

async function createProject(api: APIRequestContext, name: string): Promise<number> {
  const res = await api.post("/api/projects", { data: { name, language: "python", code: "" } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

async function submit(api: APIRequestContext, projectId: number, stores: unknown[]): Promise<DataAtRestIngestSummary> {
  const res = await api.post(`/api/projects/${projectId}/data-at-rest`, { data: { stores } });
  expect(res.status()).toBe(200);
  return (await res.json()) as DataAtRestIngestSummary;
}

async function inventory(api: APIRequestContext, projectId: number): Promise<ProjectDataAtRest> {
  const res = await api.get(`/api/projects/${projectId}/data-at-rest`);
  expect(res.status()).toBe(200);
  return (await res.json()) as ProjectDataAtRest;
}

/** The regulated backup archive: AES-256 bulk cipher, RSA-2048 wrapping key, 25-year secrecy. */
const REGULATED_ARCHIVE = {
  storeId: "claims-archive",
  engine: "oracle",
  storeKind: "archive",
  encryptionState: "encrypted",
  evidenceSource: "configuration-report",
  description: "Monthly claims exports, 25-year statutory retention",
  dataEncryption: { algorithm: "AES-256-CBC" },
  keyProtection: { algorithm: "RSA-2048", source: "pkcs11-hsm" },
  dataClassification: "regulated",
};

test.describe("the data-at-rest collector (B7)", () => {
  test("a regulated archive's key-wrapping algorithm reaches the risk engine with the X its owner stated", async ({ api }) => {
    const projectId = await createProject(api, "B7 regulated archive");

    const ingested = await submit(api, projectId, [REGULATED_ARCHIVE]);
    expect(ingested.collectionRunId).not.toBeNull();
    expect(ingested.assetsCreated).toBe(2);
    expect(ingested.storesWithRecordedCrypto).toBe(1);
    expect(ingested.stores[0].recorded.map((r) => `${r.role}:${r.algorithm}`).sort()).toEqual([
      "data-encryption:AES",
      "key-protection:RSA",
    ]);
    // The caller's own string survives canonicalisation, so the mapping is auditable.
    expect(ingested.stores[0].recorded.find((r) => r.role === "data-encryption")!.reportedAlgorithm).toBe("AES-256-CBC");

    const read = await inventory(api, projectId);
    const store = read.stores.find((s) => s.storeId === "claims-archive");
    expect(store, "the store the ingest claims to have saved must actually be in the inventory").toBeDefined();

    // The half of the lane that matters: X came from what the customer said
    // about this store, not from a fallback, and the read says so.
    expect(store!.dataClassification).toBe("regulated");
    expect(store!.classificationSource).toBe("asset");
    expect(store!.xAssumed).toBe(false);
    expect(store!.secrecyLifetimeBasis).toMatch(/Supplied for this asset/);

    const keyProtection = store!.components.find((c) => c.role === "key-protection")!;
    const dataEncryption = store!.components.find((c) => c.role === "data-encryption")!;

    // Regulated is 25 years of secrecy. Both components share it — they protect
    // the same data — but only one of them is something Q-Day breaks.
    expect(keyProtection.mosca.x).toBe(25);
    expect(dataEncryption.mosca.x).toBe(25);
    expect(keyProtection.quantumVulnerable).toBe(true);
    expect(keyProtection.mosca.applicable).toBe(true);
    expect(keyProtection.mosca.breachedScenarios.length).toBeGreaterThan(0);
    expect(keyProtection.mosca.breachedScenarios).toContain("conservative");

    // The failure this split exists to prevent: recording only the bulk cipher
    // and reporting an RSA-wrapped store as carrying nothing quantum-vulnerable.
    expect(dataEncryption.algorithm).toBe("AES");
    expect(dataEncryption.quantumVulnerable).toBe(false);
    expect(dataEncryption.mosca.applicable).toBe(false);
    expect(dataEncryption.mosca.breachedScenarios).toEqual([]);

    expect(read.framing).not.toBe("");
  });

  test("the classification a store was submitted with is what the estate-wide risk engine actually uses", async ({ api }) => {
    // The inventory read above computes Mosca itself. This proves the value was
    // *persisted*, by finding it again through a completely separate route that
    // knows nothing about data-at-rest — the one D1's dashboard reads.
    const projectId = await createProject(api, "B7 risk engine reach");
    await submit(api, projectId, [{ ...REGULATED_ARCHIVE, storeId: "risk-engine-archive" }]);

    const res = await api.get("/api/inventory/assets");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      assets: Array<{
        surface: string;
        algorithm: string;
        location: string;
        dataClassification: string | null;
        classificationSource: string;
        mosca: { x: number; xAssumed: boolean; applicable: boolean; breachedScenarios: string[] };
      }>;
    };

    const asset = body.assets.find(
      (a) => a.surface === "data-at-rest" && a.location.includes("risk-engine-archive") && a.algorithm === "RSA",
    );
    expect(asset, "the data-at-rest asset must be visible to the estate-wide inventory").toBeDefined();
    expect(asset!.dataClassification).toBe("regulated");
    expect(asset!.classificationSource).toBe("asset");
    expect(asset!.mosca.x).toBe(25);
    expect(asset!.mosca.xAssumed).toBe(false);
    expect(asset!.mosca.breachedScenarios.length).toBeGreaterThan(0);
  });

  test("every estate-wide reader survives a data-at-rest asset it has never seen before", async ({ api }) => {
    // Four routes select every asset in the organisation with no surface
    // filter. Adding a `Surface` value they have never encountered is exactly
    // the change that breaks one of them in a way no unit test sees — the CBOM
    // export in particular maps surface to a CycloneDX `assetType`.
    const projectId = await createProject(api, "B7 estate-wide readers");
    await submit(api, projectId, [{ ...REGULATED_ARCHIVE, storeId: "estate-wide-archive" }]);

    for (const path of ["/api/inventory/cbom", "/api/inventory/readiness", "/api/inventory/timeline", "/api/inventory/assets"]) {
      const res = await api.get(path);
      expect(res.status(), path).toBe(200);
    }

    const cbom = await api.get("/api/inventory/cbom");
    const body = (await cbom.json()) as {
      components: Array<{ properties?: Array<{ name: string; value: string }>; cryptoProperties?: { assetType: string } }>;
    };
    const exported = body.components.filter((c) =>
      c.properties?.some((p) => p.name.endsWith("asset:surface") && p.value === "data-at-rest"),
    );
    expect(exported.length, "a data-at-rest asset must reach the CBOM, not be dropped from it").toBeGreaterThan(0);
    expect(exported.every((c) => c.cryptoProperties?.assetType === "algorithm")).toBe(true);
  });

  test("a store that states X without a label keeps the two provenances straight", async ({ api }) => {
    // "Confidential, but this particular contract has to stay secret for 10
    // years" — the case `classification.ts` names explicitly, and the only one
    // where the label's provenance and X's provenance disagree. It is also the
    // case that would expose `classificationSource` meaning two different
    // things on this route and on `/inventory/assets`.
    const projectId = await createProject(api, "B7 years without a label");
    await submit(api, projectId, [
      {
        storeId: "contract-vault",
        engine: "s3",
        storeKind: "object-store",
        encryptionState: "encrypted",
        keyProtection: { algorithm: "RSA-3072", source: "aws-kms" },
        secrecyLifetimeYears: 10,
      },
    ]);

    const store = (await inventory(api, projectId)).stores.find((s) => s.storeId === "contract-vault")!;
    expect(store.secrecyLifetimeYears).toBe(10);
    expect(store.components[0].mosca.x).toBe(10);
    // X was supplied for this store, so it is NOT assumed...
    expect(store.xAssumed).toBe(false);
    // ...while the label was never given and falls through to the default.
    expect(store.dataClassification).toBeNull();
    expect(store.classificationSource).toBe("default");
    expect(store.secrecyLifetimeBasis).toMatch(/Supplied for this asset: 10 years/);

    // And the estate-wide route reports the same field with the same meaning.
    const res = await api.get("/api/inventory/assets");
    const body = (await res.json()) as {
      assets: Array<{ location: string; classificationSource: string; mosca: { x: number; xAssumed: boolean } }>;
    };
    const asset = body.assets.find((a) => a.location.includes("contract-vault"))!;
    expect(asset.classificationSource).toBe(store.classificationSource);
    expect(asset.mosca.x).toBe(10);
    expect(asset.mosca.xAssumed).toBe(false);
  });

  test("a store nobody classified is reported with an assumed X, not a quietly presented one", async ({ api }) => {
    const projectId = await createProject(api, "B7 unclassified store");
    await submit(api, projectId, [
      {
        storeId: "scratch-db",
        engine: "postgresql",
        encryptionState: "encrypted",
        dataEncryption: { algorithm: "AES-256" },
        keyProtection: { algorithm: "RSA-2048" },
      },
    ]);

    const read = await inventory(api, projectId);
    const store = read.stores.find((s) => s.storeId === "scratch-db")!;

    expect(store.dataClassification).toBeNull();
    expect(store.classificationSource).toBe("default");
    expect(store.xAssumed).toBe(true);
    expect(store.secrecyLifetimeBasis).toMatch(/Assumed, not supplied/);
    // Whatever the default is, the point is that it is visibly not 25 and
    // visibly flagged — the two states must not be confusable.
    expect(store.components[0].mosca.x).toBeLessThan(25);
  });

  test("'encrypted, cipher unknown' records nothing — it never becomes AES-256", async ({ api }) => {
    // The honesty case the whole surface turns on, and the one a passing-but-
    // hollow spec would skip. "Encryption: on" with no algorithm is what a DBA
    // reads off a config far more often than not.
    const projectId = await createProject(api, "B7 undeclared cipher");

    const ingested = await submit(api, projectId, [
      { storeId: "opaque-vault", engine: "veeam", storeKind: "backup", encryptionState: "encrypted" },
    ]);

    expect(ingested.storesWithRecordedCrypto).toBe(0);
    expect(ingested.assetsCreated).toBe(0);
    // Nothing was examined, so no run was recorded — "we looked and found
    // nothing" is a different and false statement.
    expect(ingested.collectionRunId).toBeNull();
    expect(ingested.stores[0].gaps.map((g) => g.reason)).toContain("cipher-not-reported");

    const read = await inventory(api, projectId);
    expect(read.stores).toEqual([]);

    const res = await api.get("/api/inventory/assets");
    const body = (await res.json()) as { assets: Array<{ surface: string; algorithm: string; location: string }> };
    const invented = body.assets.filter((a) => a.location.includes("opaque-vault"));
    expect(invented, "an unreported cipher must not produce an asset at all, least of all an AES one").toEqual([]);
  });

  test("leaving the cipher blank on a resubmission does not retire the cipher already recorded", async ({ api }) => {
    // Silent false remediation, the failure the reobservation scope is split
    // three ways to avoid: nothing was remediated here, a field was left empty.
    const projectId = await createProject(api, "B7 blank resubmission");

    await submit(api, projectId, [
      {
        storeId: "ledger",
        engine: "mssql",
        encryptionState: "encrypted",
        dataEncryption: { algorithm: "AES-256" },
        keyProtection: { algorithm: "RSA-2048" },
      },
      { storeId: "audit-log", engine: "mssql", encryptionState: "encrypted", dataEncryption: { algorithm: "AES-256" } },
    ]);

    const second = await submit(api, projectId, [
      // Still encrypted; this export just did not carry the algorithm.
      { storeId: "ledger", engine: "mssql", encryptionState: "encrypted" },
      { storeId: "audit-log", engine: "mssql", encryptionState: "encrypted", dataEncryption: { algorithm: "AES-256" } },
    ]);

    expect(second.assetsMarkedGone).toBe(0);
    const read = await inventory(api, projectId);
    const ledger = read.stores.find((s) => s.storeId === "ledger")!;
    expect(ledger.components).toHaveLength(2);
    expect(ledger.components.every((c) => c.status === "active")).toBe(true);
  });

  test("a store restated as not encrypted DOES retire what was recorded for it", async ({ api }) => {
    // The other side of the same rule: a positive statement of absence is a
    // real observation, unlike a blank field, so it must reconcile.
    const projectId = await createProject(api, "B7 encryption turned off");

    await submit(api, projectId, [
      { storeId: "reporting", engine: "postgresql", encryptionState: "encrypted", dataEncryption: { algorithm: "AES-256" } },
    ]);

    const second = await submit(api, projectId, [
      { storeId: "reporting", engine: "postgresql", encryptionState: "not-encrypted" },
    ]);

    expect(second.assetsMarkedGone).toBe(1);
    // A run IS recorded: "we checked and there is no encryption" is an
    // examination with a result, unlike the blank-field case above.
    expect(second.collectionRunId).not.toBeNull();

    const read = await inventory(api, projectId);
    const reporting = read.stores.find((s) => s.storeId === "reporting")!;
    expect(reporting.components.every((c) => c.status === "gone")).toBe(true);
  });

  test("a submitted store makes the data-at-rest surface count as examined in the coverage meter", async ({ api }) => {
    const projectId = await createProject(api, "B7 coverage");

    type Coverage = { surfaces: Array<{ surface: string | null; state: string }> };

    // Before: absent from the list entirely, which is how the meter says
    // "never examined" — not a zero.
    const before = await api.get(`/api/projects/${projectId}/coverage`);
    expect(before.status()).toBe(200);
    const beforeBody = (await before.json()) as Coverage;
    expect(beforeBody.surfaces.find((s) => s.surface === "data-at-rest")).toBeUndefined();

    await submit(api, projectId, [REGULATED_ARCHIVE]);

    const after = await api.get(`/api/projects/${projectId}/coverage`);
    const afterBody = (await after.json()) as Coverage;
    expect(afterBody.surfaces.find((s) => s.surface === "data-at-rest")?.state).toBe("examined");
  });

  test("an unauthenticated caller is refused, not shown an empty inventory", async ({ publicApi, api }) => {
    const projectId = await createProject(api, "B7 auth");
    await submit(api, projectId, [REGULATED_ARCHIVE]);

    const read = await publicApi.get(`/api/projects/${projectId}/data-at-rest`);
    expect(read.status()).toBe(401);

    const write = await publicApi.post(`/api/projects/${projectId}/data-at-rest`, { data: { stores: [REGULATED_ARCHIVE] } });
    expect(write.status()).toBe(401);
  });

  test("naming a project id that does not exist is 404, not a silently empty result", async ({ api }) => {
    const missing = 99_999_999;
    const write = await api.post(`/api/projects/${missing}/data-at-rest`, { data: { stores: [REGULATED_ARCHIVE] } });
    expect(write.status()).toBe(404);

    const read = await api.get(`/api/projects/${missing}/data-at-rest`);
    expect(read.status()).toBe(404);
  });

  test("the coverage page tells a visitor this surface is live, because it now is", async ({ anonymous }) => {
    // The catalogue is the denominator of an honesty claim and the page reads
    // it directly, so a surface flipped to `live` in code without a route that
    // persists would be a claim on a public marketing page. The other tests in
    // this file are what make that claim true; this one checks it is made.
    await anonymous.goto("/coverage");
    const heading = anonymous.getByRole("heading", { name: "Data-at-rest", exact: true });
    await expect(heading).toBeVisible({ timeout: 20_000 });
    // The pill sits alongside the heading in the same flex row.
    await expect(heading.locator("xpath=..")).toContainText("Available now");
    await expect(heading.locator("xpath=..")).not.toContainText("Planned");
  });
});
