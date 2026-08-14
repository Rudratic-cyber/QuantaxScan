/**
 * B8 — the manual OT/embedded register, driven through the real browser form.
 *
 * docs/Claude/02-roadmap.md "Phase 5 — Long-lead surfaces": OT lead time is a
 * hardware replacement cycle, 7-15 years, so the payoff this spec exists to
 * prove is narrow but load-bearing — a fleet whose next procurement date
 * falls after a Q-Day scenario's year is exposed *by definition*, and a
 * fleet with no recorded date must read as unknown, never as safe.
 *
 * No `page.route` here, per `support/fixtures.ts`'s one rule: every fleet is
 * created by filling in the real `/ot-register` form and submitting it to
 * the real API server, and every assertion checks either what the page shows
 * or the JSON payload `GET /api/ot-fleets` actually returns — never a mock.
 */
import { test, expect } from "./support/fixtures";

function farFutureDate(): string {
  // Safely after every Q-Day scenario this product currently ships
  // (conservative/central/aggressive are 2030/2035/2040) without this spec
  // hardcoding any of those years itself — it only needs "further out than
  // any plausible scenario", not the scenario's actual value.
  return "2099-06-15";
}

function nearTermDate(): string {
  // One month out from whenever the suite runs — always before every Q-Day
  // scenario, and never itself a hardcoded calendar date.
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

type ApiFleet = {
  id: number;
  name: string;
  nextProcurementDate: string | null;
  exposure: {
    scenarioCount: number;
    exposedScenarioCount: number;
    unknownScenarioCount: number;
    verdicts: { scenario: string; qDayYear: number; state: string }[];
  };
};

async function fleetsFromApi(api: import("@playwright/test").APIRequestContext): Promise<ApiFleet[]> {
  const res = await api.get("/api/ot-fleets");
  expect(res.status()).toBe(200);
  return (await res.json()) as ApiFleet[];
}

test.describe("the OT/embedded register (B8)", () => {
  test("an empty register reads as empty, not as loading forever or an error", async ({ credentialed }) => {
    await credentialed.goto("/ot-register");
    await expect(credentialed.getByTestId("ot-fleet-empty")).toBeVisible({ timeout: 20_000 });
    await expect(credentialed.getByText("Fleets could not be loaded")).toHaveCount(0);
  });

  test("saving a fleet through the real form persists it, and the panel's payload matches what's on screen", async ({
    credentialed,
    api,
  }) => {
    await credentialed.goto("/ot-register");

    await credentialed.getByTestId("ot-fleet-name-input").fill("Substation PLCs — West region");
    await credentialed.getByTestId("ot-fleet-vendor-input").fill("Siemens");
    await credentialed.getByTestId("ot-fleet-model-input").fill("S7-1500");
    await credentialed.getByTestId("ot-fleet-device-count-input").fill("42");
    await credentialed.getByTestId("ot-fleet-site-input").fill("Plant 4");
    await credentialed.getByTestId("ot-fleet-owner-input").fill("OT Engineering");
    await credentialed.getByTestId("ot-fleet-crypto-input").fill("RSA-2048 firmware signing, no TLS");
    await credentialed.getByTestId("ot-fleet-refresh-cycle-input").fill("10");
    await credentialed.getByTestId("ot-fleet-procurement-date-input").fill(farFutureDate());
    await credentialed.getByTestId("ot-fleet-submit").click();

    const row = credentialed.getByTestId("ot-fleet-row").filter({ hasText: "Substation PLCs — West region" });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText("Siemens S7-1500");
    await expect(row).toContainText("42 devices");
    await expect(row).toContainText("Plant 4");
    await expect(row).toContainText("owner: OT Engineering");
    await expect(row).toContainText("RSA-2048 firmware signing");

    // The form cleared and the list, not the form, is now the source of truth
    // for what was saved.
    await expect(credentialed.getByTestId("ot-fleet-name-input")).toHaveValue("");

    const fleets = await fleetsFromApi(api);
    const saved = fleets.find((f) => f.name === "Substation PLCs — West region");
    expect(saved, "the fleet the form claims to have saved must actually be in the register").toBeDefined();
    expect(saved!.nextProcurementDate).not.toBeNull();
    expect(new Date(saved!.nextProcurementDate!).getUTCFullYear()).toBe(2099);
  });

  test("a fleet whose next procurement date falls after a Q-Day scenario is surfaced as exposed under that scenario", async ({
    credentialed,
    api,
  }) => {
    await credentialed.goto("/ot-register");

    await credentialed.getByTestId("ot-fleet-name-input").fill("Legacy RTUs — pipeline network");
    await credentialed.getByTestId("ot-fleet-procurement-date-input").fill(farFutureDate());
    await credentialed.getByTestId("ot-fleet-submit").click();

    const row = credentialed.getByTestId("ot-fleet-row").filter({ hasText: "Legacy RTUs — pipeline network" });
    await expect(row).toBeVisible({ timeout: 20_000 });

    const badge = row.getByTestId("ot-fleet-exposure");
    await expect(badge).toHaveAttribute("data-state", "exposed");
    await expect(badge).toContainText("Exposed");
    // The conservative scenario specifically — the one whose deadline is
    // soonest, and the one the roadmap's rationale names explicitly.
    await expect(badge).toContainText(/conservative.*Exposed/);

    const fleets = await fleetsFromApi(api);
    const saved = fleets.find((f) => f.name === "Legacy RTUs — pipeline network")!;
    expect(saved.exposure.exposedScenarioCount).toBeGreaterThan(0);
    const conservative = saved.exposure.verdicts.find((v) => v.scenario === "conservative")!;
    expect(conservative.state).toBe("exposed");
  });

  test("a fleet whose next procurement precedes every scenario reads clear, proving exposure isn't unconditional", async ({
    credentialed,
    api,
  }) => {
    await credentialed.goto("/ot-register");

    await credentialed.getByTestId("ot-fleet-name-input").fill("HVAC controllers — HQ campus");
    await credentialed.getByTestId("ot-fleet-procurement-date-input").fill(nearTermDate());
    await credentialed.getByTestId("ot-fleet-submit").click();

    const row = credentialed.getByTestId("ot-fleet-row").filter({ hasText: "HVAC controllers — HQ campus" });
    await expect(row).toBeVisible({ timeout: 20_000 });

    const badge = row.getByTestId("ot-fleet-exposure");
    await expect(badge).toHaveAttribute("data-state", "clear");
    await expect(badge).toContainText("Clear");

    const fleets = await fleetsFromApi(api);
    const saved = fleets.find((f) => f.name === "HVAC controllers — HQ campus")!;
    expect(saved.exposure.exposedScenarioCount).toBe(0);
    expect(saved.exposure.unknownScenarioCount).toBe(0);
  });

  test("a fleet with no recorded procurement date reads as unknown — never as safe", async ({ credentialed, api }) => {
    await credentialed.goto("/ot-register");

    // The date field is left blank on purpose — this is the case the register
    // exists to make honest: nobody has told us when this fleet gets replaced.
    await credentialed.getByTestId("ot-fleet-name-input").fill("Field sensors — no procurement plan");
    await credentialed.getByTestId("ot-fleet-submit").click();

    const row = credentialed.getByTestId("ot-fleet-row").filter({ hasText: "Field sensors — no procurement plan" });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText("Next procurement: not recorded");

    const badge = row.getByTestId("ot-fleet-exposure");
    await expect(badge).toHaveAttribute("data-state", "unknown");
    await expect(badge).toContainText("Unknown");
    // The failure this test exists to catch: an unknown date silently
    // rendering as safe/clear anywhere in the badge.
    await expect(badge).not.toContainText("Clear");
    await expect(badge).not.toContainText(/safe/i);

    const fleets = await fleetsFromApi(api);
    const saved = fleets.find((f) => f.name === "Field sensors — no procurement plan")!;
    expect(saved.nextProcurementDate).toBeNull();
    expect(saved.exposure.unknownScenarioCount).toBe(saved.exposure.scenarioCount);
    expect(saved.exposure.exposedScenarioCount).toBe(0);
    expect(saved.exposure.verdicts.every((v) => v.state === "unknown")).toBe(true);
  });

  test("removing a fleet through the form takes it out of the register for real", async ({ credentialed, api }) => {
    await credentialed.goto("/ot-register");

    await credentialed.getByTestId("ot-fleet-name-input").fill("Fleet slated for removal");
    await credentialed.getByTestId("ot-fleet-submit").click();

    const row = credentialed.getByTestId("ot-fleet-row").filter({ hasText: "Fleet slated for removal" });
    await expect(row).toBeVisible({ timeout: 20_000 });

    await row.getByRole("button", { name: /Remove Fleet slated for removal/ }).click();
    await expect(row).toHaveCount(0);

    const fleets = await fleetsFromApi(api);
    expect(fleets.find((f) => f.name === "Fleet slated for removal")).toBeUndefined();
  });
  test("a fleet with a named algorithm reaches the inventory; one described only in prose does not", async ({ api }) => {
    // The whole point of the `ot` surface: a register entry is the only
    // evidence that will ever exist for a device with no interface to probe,
    // so it has to reach the inventory — but only the part of it this system
    // can actually reason about.
    const prose = await api.post("/api/ot-fleets", {
      data: { name: "Prose-only substation fleet", cryptoInUse: "RSA-2048 firmware signing, no TLS" },
    });
    expect(prose.status()).toBe(201);

    const stated = await api.post("/api/ot-fleets", {
      data: { name: "Stated-algorithm RTU fleet", cryptoInUse: "best known", cryptoAlgorithm: "RSA", cryptoKeySize: 2048 },
    });
    expect(stated.status()).toBe(201);
    const statedFleet = await stated.json();

    const assets = await (await api.get("/api/inventory/assets")).json();
    const otAssets = assets.assets.filter((a: { surface: string }) => a.surface === "ot");

    // Exactly one, from the fleet that named an algorithm. The prose fleet is
    // absent by design — parsing "RSA-2048 firmware signing" into an algorithm
    // would be a guess, and putting the sentence in `algorithm` would hand
    // prose to the mapping engine.
    expect(otAssets).toHaveLength(1);
    expect(otAssets[0].algorithm).toBe("RSA");
    expect(otAssets[0].keySize).toBe(2048);
    expect(otAssets[0].location).toBe(`ot-fleet:${statedFleet.id}`);

    // An attestation must never carry the authority of an observation. 0.3 is
    // below every automated collector, and far below a completed handshake.
    expect(otAssets[0].latestConfidence).toBeLessThan(0.7);
  });

  test("clearing the stated algorithm retires the asset it produced, without deleting the fleet", async ({ api }) => {
    const created = await api.post("/api/ot-fleets", {
      data: { name: "Fleet that gets corrected", cryptoAlgorithm: "RSA", cryptoKeySize: 1024 },
    });
    const fleet = await created.json();

    const withAsset = await (await api.get("/api/inventory/assets")).json();
    expect(withAsset.assets.some((a: { location: string }) => a.location === `ot-fleet:${fleet.id}`)).toBe(true);
    const goneBefore = withAsset.statusCounts.gone ?? 0;

    // The customer decides they were wrong and clears the claim. The register
    // entry survives — it is still a fleet with a procurement date — but the
    // inventory must stop asserting cryptography nobody stands behind.
    const patched = await api.patch(`/api/ot-fleets/${fleet.id}`, { data: { cryptoAlgorithm: null } });
    expect(patched.status()).toBe(200);

    const after = await (await api.get("/api/inventory/assets")).json();
    // `/inventory/assets` lists *present* assets, so the retired one leaves
    // that list — a current inventory must not keep asserting cryptography
    // nobody stands behind.
    expect(after.assets.some((a: { location: string }) => a.location === `ot-fleet:${fleet.id}`)).toBe(false);
    // But it is retired, not deleted: `statusCounts` counts every status
    // including `gone`, which is how the drift panel reports a removal without
    // listing it as present. The row survives, so the history does (A1).
    expect(after.statusCounts.gone ?? 0).toBe(goneBefore + 1);

    const stillThere = await api.get(`/api/ot-fleets/${fleet.id}`);
    expect(stillThere.status()).toBe(200);
  });
});
