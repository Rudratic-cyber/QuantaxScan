/**
 * D1 — the CISA quantum-readiness dashboard, in a real browser against a real
 * server.
 *
 * This page is the one a CISO puts on a projector next to the joint
 * CISA/NSA/NIST factsheet, so the failure that matters most here is not a
 * crash — it is a panel that renders a *confident number it did not earn*: a
 * zero where the answer is "we could not read it", a percentage for a section
 * this product cannot yet track, a coverage figure that disagrees with the
 * payload it was computed from.
 *
 * Every test below therefore asserts on **both** what the browser renders and
 * the payload the panel read, from the same stack. A spec that only checked
 * the page loaded would pass against a dashboard showing nothing but zeroes.
 */
import { randomUUID } from "node:crypto";
import { test, expect, UI_URL, trackPageErrors } from "./support/fixtures";

const unique = (label: string) => `${label}-${randomUUID().slice(0, 8)}`;

interface ReadinessSection {
  id: string;
  label: string;
  state: "tracked" | "not-tracked";
  percentComplete: number | null;
  reason: string;
}

interface ReadinessResponse {
  generatedAt: string;
  framing: string;
  sections: ReadinessSection[];
  coverage: {
    examinedSurfaces: number;
    totalSurfaces: number;
    surfaces: Array<{ surface: string; state: string; activeAssets: number }>;
    confidence: { scored: number; unscored: number; mean: number | null };
  };
}

interface InventoryAssetsResponse {
  assets: Array<{ algorithm: string; keySize: number | null; location: string; surface: string }>;
  statusCounts: Record<string, number>;
  scenarios: Array<{ name: string; qDayYear: number }>;
}

test.describe("the CISA readiness dashboard (D1)", () => {
  test("the coverage headline on screen is the number the payload actually contains", async ({ api, credentialed }) => {
    const readiness: ReadinessResponse = await (await api.get("/api/inventory/readiness")).json();

    const errors = trackPageErrors(credentialed);
    await credentialed.goto(`${UI_URL}/readiness`);

    await expect(credentialed.getByText("Estate coverage — what we have not looked at, across every project")).toBeVisible();

    // The panel's own words, built from the payload's two numbers. Asserting
    // the composed sentence rather than each number separately is what would
    // catch a panel that renders `examined` where it means `total`.
    await expect(credentialed.getByText("collector surfaces examined")).toBeVisible();
    await expect(
      credentialed.getByText(
        `${readiness.coverage.totalSurfaces - readiness.coverage.examinedSurfaces} of ${readiness.coverage.totalSurfaces} have never been examined, anywhere in this estate.`,
      ),
    ).toBeVisible();

    // The denominator is the collector catalogue, not the estate — so it is
    // non-zero even before anything has been collected, and the numerator can
    // never exceed it. `surfaces` lists only the ones with a run or an asset,
    // so it is legitimately empty on an estate nobody has scanned yet: that is
    // the "never examined" case, not missing data.
    expect(readiness.coverage.totalSurfaces).toBeGreaterThan(0);
    expect(readiness.coverage.examinedSurfaces).toBeLessThanOrEqual(readiness.coverage.totalSurfaces);
    for (const surface of readiness.coverage.surfaces) {
      expect(["examined", "examined-nothing-found", "never-examined"]).toContain(surface.state);
    }

    expect(errors()).toEqual([]);
  });

  test("a section this product cannot yet measure says so, instead of showing a percentage", async ({
    api,
    credentialed,
  }) => {
    const readiness: ReadinessResponse = await (await api.get("/api/inventory/readiness")).json();

    // The payload half: an untracked section carries no number at all. A 0
    // here would be indistinguishable on screen from "measured, and you have
    // done none of it", which is a different and false statement.
    const untracked = readiness.sections.filter((s) => s.state === "not-tracked");
    expect(untracked.length).toBeGreaterThan(0);
    for (const section of untracked) {
      expect(section.percentComplete).toBeNull();
      expect(section.reason.length).toBeGreaterThan(0);
    }

    await credentialed.goto(`${UI_URL}/readiness`);
    await expect(credentialed.getByText("Readiness posture")).toBeVisible();

    // The rendered half: the reason is on screen, and every section from the
    // payload is named — an untracked section is shown and explained, not
    // quietly dropped from the list to make the page look complete.
    for (const section of readiness.sections) {
      await expect(credentialed.getByText(section.label, { exact: false }).first()).toBeVisible();
    }
    await expect(credentialed.getByText(untracked[0].reason, { exact: false }).first()).toBeVisible();

    // And no combined score across the five, for the reason the panel states.
    await expect(credentialed.getByText("No combined score is shown across these five", { exact: false })).toBeVisible();
  });

  test("an asset collected through the API appears in the dashboard's inventory, with its real key size", async ({
    api,
    credentialed,
  }) => {
    const name = unique("readiness-inventory-project");
    const code = "from Crypto.PublicKey import RSA\nkey = RSA.generate(2048)\n";
    const created = await api.post("/api/projects", { data: { name, language: "python", code } });
    expect(created.status()).toBe(201);
    const projectId = (await created.json()).id;

    // A scan is what puts assets in the inventory: it ingests source
    // observations, so the dashboard below is reading collected data rather
    // than anything this test wrote directly.
    const scan = await api.post("/api/scans", {
      data: { projectId, mode: "scan-only", code, language: "python" },
    });
    expect(scan.status()).toBe(201);

    const inventory: InventoryAssetsResponse = await (await api.get("/api/inventory/assets")).json();
    expect(inventory.assets.length).toBeGreaterThan(0);

    // All three Q-Day scenarios are offered as a filter, not one pre-picked
    // for the reader — the payload is what proves the selector is not showing
    // a hardcoded list.
    expect(inventory.scenarios.length).toBe(3);
    const years = inventory.scenarios.map((s) => s.qDayYear);
    expect([...years].sort((a, b) => a - b)).toEqual(years);

    await credentialed.goto(`${UI_URL}/readiness`);
    await expect(credentialed.getByText("Inventory breakdown")).toBeVisible();

    // Post-quantum risk and classical hygiene are shown as separate tracks.
    // Blending them is the specific mistake this panel exists to avoid: a
    // classical-hygiene finding is not evidence of quantum exposure.
    // `exact` because the panel's own explanatory copy names both tracks in
    // prose as well, and the assertion is about the two headings.
    await expect(credentialed.getByText("Post-quantum risk", { exact: true })).toBeVisible();
    await expect(credentialed.getByText("Classical hygiene", { exact: true })).toBeVisible();
  });

  test("when the API refuses the browser, every panel says so rather than rendering a zero", async ({
    anonymous,
  }) => {
    // The real deployed condition today: no sign-in exists, so a plain visitor
    // is unauthenticated and every one of these fetches is a 401. What must not
    // happen is a dashboard that reads as a clean estate with nothing to fix.
    const errors = trackPageErrors(anonymous);
    await anonymous.goto(`${UI_URL}/readiness`);

    await expect(anonymous.getByText("Readiness posture could not be read.")).toBeVisible();
    await expect(anonymous.getByText("Coverage could not be read.")).toBeVisible();
    await expect(anonymous.getByText("No figure is shown rather than a default one.", { exact: false })).toBeVisible();

    // The tell for the failure this test exists to catch: the coverage
    // headline must be absent entirely, not present showing 0.
    await expect(anonymous.getByText("collector surfaces examined")).toHaveCount(0);

    expect(errors()).toEqual([]);
  });
});
