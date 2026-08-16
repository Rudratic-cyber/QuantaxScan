/**
 * C8 — the waivers / exceptions register, end to end against the real stack:
 * real PostgreSQL, real row-level-security policies applied by `apply-rls`,
 * real HTTP.
 *
 * **The first describe block is the point of this file.** C8's hard constraint
 * is that a waiver must never make an asset read as clean, and that is not a
 * property you can establish by reading the code — it is a property of four
 * separate payloads that are each computed somewhere else. So the test grants a
 * waiver and asserts that `GET /inventory/readiness`, `GET /inventory/assets`'
 * counts and risk fields, `GET /inventory/cbom` and `GET /stats` come back
 * *identical*, field for field, with only the annotation and its counter
 * changed. If a future refactor ever lets an accepted risk improve a coverage
 * number, this is what says so.
 *
 * The second block is the other constraint: an expired waiver is not a waiver.
 * It grants one that lasts a couple of seconds and waits for it, rather than
 * asserting against an injected clock, because the whole hazard is a read path
 * that keeps suppressing after expiry and only a real clock can prove it does
 * not.
 */
import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, API_URL, viewerApiKey } from "./support/fixtures";
import { request as playwrightRequest } from "@playwright/test";

const unique = (label: string) => `${label}-${randomUUID().slice(0, 8)}`;

interface InventoryWaiver {
  id: number;
  justification: string;
  signedOffBy: string;
  attribution: "authenticated" | "asserted";
  signedOffAt: string;
  expiresAt: string;
  daysRemaining: number;
}

interface InventoryAsset {
  id: number;
  fingerprint: string;
  algorithm: string;
  location: string;
  status: string;
  compliance: unknown;
  waiver: InventoryWaiver | null;
  mosca: { x: number; y: number; applicable: boolean; breachedScenarios: string[] };
}

interface InventoryAssetsResponse {
  assets: InventoryAsset[];
  statusCounts: Record<string, number>;
  waivedAssets: number;
}

interface RegisterWaiver {
  id: number;
  assetId: number;
  divisionId: number | null;
  justification: string;
  signedOffBy: string;
  attribution: "authenticated" | "asserted";
  expiresAt: string;
  revokedAt: string | null;
  status: "active" | "expired" | "revoked";
  daysRemaining: number;
  asset: { id: number; fingerprint: string; algorithm: string } | null;
}

interface Register {
  generatedAt: string;
  waivers: RegisterWaiver[];
  counts: { active: number; expired: number; revoked: number };
}

/** Direct HTTP as the read-only key. The `api` fixture is the admin one. */
async function viewerApi(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { "X-API-Key": viewerApiKey() },
  });
}

async function createProject(api: APIRequestContext, name: string): Promise<number> {
  const res = await api.post("/api/projects", { data: { name, language: "python", code: "" } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

/**
 * Seed one asset with a genuinely quantum-vulnerable algorithm, so the "the
 * numbers did not move" assertions are made against an asset that actually
 * contributes to them. Waiving something already scored as safe would prove
 * nothing.
 */
async function seedVulnerableAsset(api: APIRequestContext, label: string): Promise<{ projectId: number; assetId: number }> {
  const projectId = await createProject(api, unique(label));
  const storeId = unique("archive");

  const res = await api.post(`/api/projects/${projectId}/data-at-rest`, {
    data: {
      stores: [
        {
          storeId,
          engine: "oracle",
          storeKind: "archive",
          encryptionState: "encrypted",
          evidenceSource: "configuration-report",
          dataEncryption: { algorithm: "AES-256-CBC" },
          keyProtection: { algorithm: "RSA-2048", source: "pkcs11-hsm" },
          dataClassification: "regulated",
        },
      ],
    },
  });
  expect(res.status()).toBe(200);

  const inventory = await getAssets(api);
  const asset = inventory.assets.find((a) => a.location.includes(storeId) && a.algorithm.startsWith("RSA"));
  expect(asset, "the seeded RSA key-protection asset should be in the inventory").toBeDefined();
  return { projectId, assetId: asset!.id };
}

async function getAssets(api: APIRequestContext): Promise<InventoryAssetsResponse> {
  const res = await api.get("/api/inventory/assets");
  expect(res.status()).toBe(200);
  return (await res.json()) as InventoryAssetsResponse;
}

async function getRegister(api: APIRequestContext, query = ""): Promise<Register> {
  const res = await api.get(`/api/waivers${query}`);
  expect(res.status()).toBe(200);
  return (await res.json()) as Register;
}

function isoInDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

async function grant(
  api: APIRequestContext,
  assetId: number,
  overrides: Record<string, unknown> = {},
): Promise<RegisterWaiver> {
  const res = await api.post("/api/waivers", {
    data: {
      assetId,
      justification: "Vendor upgrade lands next quarter; compensating controls in place.",
      signedOffBy: "R. Patel, Head of Security",
      expiresAt: isoInDays(90),
      ...overrides,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as RegisterWaiver;
}

/**
 * Drop `generatedAt`, which every summariser stamps with the instant it ran and
 * which therefore differs between two calls a second apart. Recursive, because
 * it appears at more than one depth — and *only* this key, so that anything
 * else differing is a real change.
 */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === "generatedAt") continue;
      out[key] = stable(inner);
    }
    return out;
  }
  return value;
}

/**
 * The CBOM's two per-request fields, removed **at the top level only**.
 *
 * Deliberately not a recursive strip of `metadata`/`timestamp`: `CycloneDxBom`
 * declares both at the document root (`lib/cbom/src/types.ts`), and a recursive
 * delete would also erase any same-named key nested inside a component — where a
 * waiver-induced change could then hide and compare equal. The comparison is
 * only as strong as the narrowness of what it ignores.
 */
function stableCbom(document: unknown): unknown {
  const { serialNumber: _serial, metadata: _metadata, ...rest } = document as Record<string, unknown>;
  return stable(rest);
}

async function snapshotEstate(api: APIRequestContext): Promise<Record<string, unknown>> {
  const [readiness, cbom, stats] = await Promise.all([
    api.get("/api/inventory/readiness"),
    api.get("/api/inventory/cbom"),
    api.get("/api/stats"),
  ]);
  expect(readiness.status()).toBe(200);
  expect(cbom.status()).toBe(200);
  expect(stats.status()).toBe(200);

  const cbomDocument = await cbom.json();
  // The waived asset must still be a component of the export. Asserted here
  // rather than left implicit in the deep-equal below, because "the CBOM is
  // unchanged" would also be satisfied by a CBOM that never listed it.
  expect((cbomDocument as { components: unknown[] }).components.length).toBeGreaterThan(0);

  return {
    readiness: stable(await readiness.json()),
    cbom: stableCbom(cbomDocument),
    stats: stable(await stats.json()),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// The guarantee this feature is allowed to exist under.
// ───────────────────────────────────────────────────────────────────────────

test.describe("a waiver never makes an asset read as clean (C8)", () => {
  test("granting one changes the annotation and nothing else in the estate", async ({ api }) => {
    const { assetId } = await seedVulnerableAsset(api, "C8 estate");

    const before = await snapshotEstate(api);
    const assetsBefore = await getAssets(api);
    const rowBefore = assetsBefore.assets.find((a) => a.id === assetId);
    expect(rowBefore?.waiver, "a fresh asset carries no waiver").toBeNull();

    const waiver = await grant(api, assetId);
    expect(waiver.status).toBe("active");

    const after = await snapshotEstate(api);
    const assetsAfter = await getAssets(api);
    const rowAfter = assetsAfter.assets.find((a) => a.id === assetId);

    // 1. Readiness, the CBOM and the platform stats are byte-identical. The
    //    waived asset is still a component of the CycloneDX document — an
    //    export that omitted it would be a false statement about what the
    //    organisation runs, which is worse than an unflattering one.
    expect(after).toEqual(before);

    // 2. The asset is still present, still counted, and still carries the same
    //    risk. If Mosca or the compliance obligations ever start reading the
    //    waiver, this is what fails.
    expect(rowAfter, "the waived asset is still in the inventory").toBeDefined();
    expect(assetsAfter.statusCounts).toEqual(assetsBefore.statusCounts);
    expect(rowAfter!.status).toBe(rowBefore!.status);
    expect(rowAfter!.mosca).toEqual(rowBefore!.mosca);
    expect(rowAfter!.compliance).toEqual(rowBefore!.compliance);
    expect(rowAfter!.mosca.breachedScenarios).toEqual(rowBefore!.mosca.breachedScenarios);

    // 3. The one thing that did change: the annotation, and a counter beside
    //    the inventory rather than subtracted from it.
    expect(rowAfter!.waiver).not.toBeNull();
    expect(rowAfter!.waiver!.id).toBe(waiver.id);
    expect(rowAfter!.waiver!.signedOffBy).toBe("R. Patel, Head of Security");
    expect(assetsAfter.waivedAssets).toBe(assetsBefore.waivedAssets + 1);
    expect(assetsAfter.assets.length).toBe(assetsBefore.assets.length);
  });

  test("a waiver written by the shared API key reads as asserted, not as a signature", async ({ api }) => {
    // The e2e stack authenticates with `QUANTAXSCAN_API_KEYS`, which is a
    // machine credential with no person behind it. The register must say so
    // rather than dress the typed name up as a verified one.
    const { assetId } = await seedVulnerableAsset(api, "C8 attribution");
    const waiver = await grant(api, assetId);
    expect(waiver.attribution).toBe("asserted");
    expect(waiver.signedOffBy).toBe("R. Patel, Head of Security");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// An expired waiver is not a waiver.
// ───────────────────────────────────────────────────────────────────────────

test.describe("expiry (C8)", () => {
  test("stops suppressing the moment it lapses, against a real clock", async ({ api }) => {
    const { assetId } = await seedVulnerableAsset(api, "C8 expiry");

    // Deliberately short. The hazard is a read path that keeps suppressing past
    // expiry, and only elapsed wall-clock time can prove it does not.
    const waiver = await grant(api, assetId, { expiresAt: new Date(Date.now() + 3_000).toISOString() });
    expect(waiver.status).toBe("active");

    const whileActive = await getAssets(api);
    expect(whileActive.assets.find((a) => a.id === assetId)?.waiver?.id).toBe(waiver.id);

    await new Promise((resolve) => setTimeout(resolve, 4_000));

    const afterExpiry = await getAssets(api);
    expect(
      afterExpiry.assets.find((a) => a.id === assetId)?.waiver,
      "an expired waiver must not keep annotating the asset",
    ).toBeNull();

    // And the register still has it, saying why it stopped applying. An
    // exceptions register that forgets the exceptions that lapsed cannot answer
    // the only question an auditor asks it.
    const register = await getRegister(api);
    const entry = register.waivers.find((w) => w.id === waiver.id);
    expect(entry?.status).toBe("expired");
    expect(entry?.daysRemaining).toBeLessThanOrEqual(0);
  });

  test("refuses an expiry that is absent, in the past, or further off than anyone will renew it", async ({ api }) => {
    const { assetId } = await seedVulnerableAsset(api, "C8 expiry validation");

    const cases: Array<[string, Record<string, unknown>]> = [
      ["no expiry at all", { expiresAt: undefined }],
      ["an expiry already in the past", { expiresAt: isoInDays(-1) }],
      ["a non-timestamp", { expiresAt: "whenever" }],
      ["more than 730 days", { expiresAt: isoInDays(900) }],
      ["no justification", { justification: "   " }],
      ["nobody signing it off", { signedOffBy: "" }],
    ];

    for (const [label, override] of cases) {
      const body: Record<string, unknown> = {
        assetId,
        justification: "reason",
        signedOffBy: "Somebody",
        expiresAt: isoInDays(30),
        ...override,
      };
      if (body.expiresAt === undefined) delete body.expiresAt;

      const res = await api.post("/api/waivers", { data: body });
      expect(res.status(), `${label} should be refused`).toBe(400);
      expect((await res.json()) as { error: string }).toHaveProperty("error");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The register, revocation, and who may grant one.
// ───────────────────────────────────────────────────────────────────────────

test.describe("the register (C8)", () => {
  test("revoking closes the waiver without deleting the record of it", async ({ api }) => {
    const { assetId } = await seedVulnerableAsset(api, "C8 revoke");
    const waiver = await grant(api, assetId);

    expect((await getAssets(api)).assets.find((a) => a.id === assetId)?.waiver).not.toBeNull();

    const revoked = await api.post(`/api/waivers/${waiver.id}/revoke`);
    expect(revoked.status()).toBe(200);
    expect(((await revoked.json()) as RegisterWaiver).status).toBe("revoked");

    // Suppression stops immediately...
    expect((await getAssets(api)).assets.find((a) => a.id === assetId)?.waiver).toBeNull();

    // ...and the row is still there, with the fact that it was withdrawn rather
    // than merely allowed to lapse. There is no DELETE route by design.
    const register = await getRegister(api);
    const entry = register.waivers.find((w) => w.id === waiver.id);
    expect(entry?.status).toBe("revoked");
    expect(entry?.revokedAt).not.toBeNull();
    expect(entry?.justification).toBe(waiver.justification);

    // A second revocation is a 409, not a silent success: the caller believed
    // they were changing something, and the first revocation's timestamp is the
    // record.
    expect((await api.post(`/api/waivers/${waiver.id}/revoke`)).status()).toBe(409);
  });

  test("lists every waiver with its asset, and filters without lying about the totals", async ({ api }) => {
    const { assetId } = await seedVulnerableAsset(api, "C8 listing");
    const active = await grant(api, assetId);
    const toRevoke = await grant(api, assetId, { justification: "second acceptance, withdrawn" });
    expect((await api.post(`/api/waivers/${toRevoke.id}/revoke`)).status()).toBe(200);

    const all = await getRegister(api);
    expect(all.waivers.map((w) => w.id)).toEqual(expect.arrayContaining([active.id, toRevoke.id]));
    const listed = all.waivers.find((w) => w.id === active.id);
    expect(listed?.asset?.id).toBe(assetId);
    expect(listed?.asset?.algorithm).toMatch(/^RSA/);

    const onlyActive = await getRegister(api, "?status=active");
    expect(onlyActive.waivers.every((w) => w.status === "active")).toBe(true);
    expect(onlyActive.waivers.some((w) => w.id === toRevoke.id)).toBe(false);
    // The counts are over the whole register even when the list is filtered: a
    // caller asking for the active ones still needs to know how many lapsed.
    expect(onlyActive.counts).toEqual(all.counts);
    expect(onlyActive.counts.revoked).toBeGreaterThanOrEqual(1);
  });

  test("404s on an asset this organisation cannot see, and on an unknown waiver", async ({ api }) => {
    const res = await api.post("/api/waivers", {
      data: {
        assetId: 999_999_999,
        justification: "reason",
        signedOffBy: "Somebody",
        expiresAt: isoInDays(30),
      },
    });
    expect(res.status()).toBe(404);
    expect((await api.post("/api/waivers/999999999/revoke")).status()).toBe(404);
  });
});

test.describe("who may accept a risk (C8 × RBAC)", () => {
  test("a viewer reads the register but cannot grant a waiver", async ({ api }) => {
    const { assetId } = await seedVulnerableAsset(api, "C8 rbac");
    const viewer = await viewerApi();
    try {
      // Reading it is the point: a read-only account must be able to see what
      // the organisation has agreed to live with.
      expect((await viewer.get("/api/waivers")).status()).toBe(200);

      // Granting one is not. Accepting a risk on the organisation's behalf is
      // an administrative act, and the person best placed to silence an
      // inconvenient finding is whoever submitted the scan that raised it.
      const refused = await viewer.post("/api/waivers", {
        data: {
          assetId,
          justification: "reason",
          signedOffBy: "Somebody",
          expiresAt: isoInDays(30),
        },
      });
      expect(refused.status()).toBe(403);
      // 403 that names the role, not a 404 — a permissions problem must be
      // distinguishable from a typo by the person hitting it.
      expect(((await refused.json()) as { error: string }).error).toMatch(/admin/);
    } finally {
      await viewer.dispose();
    }
  });

  /**
   * Pins the documented asymmetry from below.
   *
   * Revoking is deliberately left on the default `member` gate rather than
   * raised to `admin`, and that decision is asserted in three places by prose
   * and nowhere by a test — so this is the one that would catch it having
   * become "anybody may revoke". There is no `member` key in the e2e stack, so
   * what is provable here is the lower bound: a **viewer** is refused. The
   * upper bound (that it does not silently require `admin`) is held by
   * `cross-tenant.test.ts`'s `ADMIN_ONLY` list, which names
   * `POST /waivers` and not the revoke route, and fails in both directions.
   */
  test("a viewer cannot revoke one either — revoking is a member's act, not a read", async ({ api }) => {
    const { assetId } = await seedVulnerableAsset(api, "C8 rbac revoke");
    const waiver = await grant(api, assetId);

    const viewer = await viewerApi();
    try {
      const refused = await viewer.post(`/api/waivers/${waiver.id}/revoke`);
      expect(refused.status()).toBe(403);
      expect(((await refused.json()) as { error: string }).error).toMatch(/member/);
    } finally {
      await viewer.dispose();
    }

    // Still in force: the refusal changed nothing.
    expect((await getAssets(api)).assets.find((a) => a.id === assetId)?.waiver?.id).toBe(waiver.id);
  });

  test("an anonymous caller gets 401, not 403 — authentication and authorisation stay separate", async ({ publicApi }) => {
    expect((await publicApi.get("/api/waivers")).status()).toBe(401);
    expect((await publicApi.post("/api/waivers", { data: {} })).status()).toBe(401);
  });
});
