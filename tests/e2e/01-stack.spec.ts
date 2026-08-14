/**
 * The stack is up, and it is the stack we think it is.
 *
 * This runs first (alphabetically, and the suite is serial) so that a broken
 * harness reports itself as a broken harness rather than as a page that failed
 * to render. Every other spec in this directory is only meaningful if these
 * pass.
 */
import { test, expect, API_URL, UI_URL } from "./support/fixtures";

test.describe("the real stack", () => {
  test("the API server answers its health check on its own port", async ({ publicApi }) => {
    const response = await publicApi.get("/api/healthz");

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  test("the frontend is served from a different origin than the API", async ({ anonymous }) => {
    expect(new URL(UI_URL).port).not.toBe(new URL(API_URL).port);

    const response = await anonymous.goto("/");

    expect(response?.status()).toBe(200);
    await expect(anonymous.locator("#root")).toBeAttached();
  });

  test("the API refuses an unauthenticated read of real data", async ({ publicApi }) => {
    // If this ever returns 200, every "authenticated" assertion in this suite
    // is proving nothing, because the key would not be what admitted us.
    const response = await publicApi.get("/api/projects");

    expect(response.status()).toBe(401);
  });

  test("the API accepts the key the stack was started with", async ({ api }) => {
    const response = await api.get("/api/projects");

    expect(response.status()).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
  });
});
