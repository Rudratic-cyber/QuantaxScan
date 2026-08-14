import { test, expect } from "@playwright/test";

/**
 * A refused request must reach its honest copy promptly.
 *
 * The dashboard already distinguishes "the API refused this" from "you have no scans" — that
 * distinction is the point of the copy at Dashboard.tsx. What it did not survive was TanStack
 * Query's default `retry: 3` with exponential backoff: a 401 is deterministic, so re-asking it
 * three times bought nothing and left "Loading projects…" on screen for about ten seconds.
 *
 * Ten seconds of spinner is a third state that says neither "refused" nor "empty", and it is the
 * state a person actually sees. These tests pin the two properties that fix it: the honest copy
 * arrives quickly, and a client error is asked exactly once.
 *
 * Unlike the rest of tests/ui, these assert on the *timing and count* of a failure path, so the
 * routes are stubbed to fail deterministically rather than to return fixtures.
 */
test.describe("a refused request settles quickly and says so", () => {
  const refuse = async (page: import("@playwright/test").Page, counter: { n: number }) => {
    await page.route("**/api/projects", (route) => {
      counter.n += 1;
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Unauthorized" }),
      });
    });
    await page.route("**/api/stats", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Unauthorized" }) }),
    );
  };

  test("shows the refusal copy, not a spinner, within a few seconds", async ({ page }) => {
    const counter = { n: 0 };
    await refuse(page, counter);

    await page.goto("/dashboard");

    // 3s is deliberately far below the ~10s the retry default cost, and far above what a single
    // round trip needs. A regression to retrying 4xx fails this without being flaky.
    await expect(page.getByText("Projects could not be loaded").first()).toBeVisible({ timeout: 3000 });
    await expect(
      page.getByText("The API refused the request, so we cannot tell whether you have any scans").first(),
    ).toBeVisible();

    // The refusal must never be presented as an empty inventory.
    await expect(page.getByText("No scans yet")).toHaveCount(0);
    await expect(page.getByText("Loading projects…")).toHaveCount(0);
  });

  test("asks exactly once — a 401 is not a transient failure", async ({ page }) => {
    const counter = { n: 0 };
    await refuse(page, counter);

    await page.goto("/dashboard");
    await expect(page.getByText("Projects could not be loaded").first()).toBeVisible({ timeout: 3000 });
    await page.waitForTimeout(2000); // long enough for the old backoff to have fired twice

    expect(counter.n).toBe(1);
  });

  test("still retries a 503, which is the kind of failure that clears on its own", async ({ page }) => {
    // The guard above must not become "never retry anything". A server error is transient by
    // nature and the second attempt is the one that should succeed.
    let attempts = 0;
    await page.route("**/api/projects", (route) => {
      attempts += 1;
      return attempts === 1
        ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) })
        : route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/api/stats", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));

    await page.goto("/dashboard");

    await expect(page.getByText("No scans yet").first()).toBeVisible({ timeout: 10000 });
    expect(attempts).toBeGreaterThan(1);
  });
});
