/**
 * The dashboard with no credential — which is the *real* behaviour of the
 * deployed product today, not an edge case.
 *
 * The shipped browser bundle carries no API key (sign-in is P2 —
 * docs/Claude/13-auth-and-tenancy.md §7.3), so every authenticated query the
 * dashboard makes is answered 401 by the real server. `tests/ui/` has a
 * journey for this, but it manufactures the 401 with `page.route`: it never
 * sees the real status line, the real `WWW-Authenticate`-less response, the
 * real error body, or — the part that mattered — the real number of times the
 * query layer asks again before it gives up.
 */
import { test, expect, countRequests, trackPageErrors } from "./support/fixtures";

/** Matches the projects list itself, not `/api/projects/1/coverage`. */
function isProjectsList(url: string): boolean {
  return new URL(url).pathname === "/api/projects";
}

test.describe("the dashboard, unauthenticated", () => {
  test("settles on an honest refusal instead of claiming there is no data", async ({ anonymous }) => {
    const pageErrors = trackPageErrors(anonymous);

    await anonymous.goto("/dashboard");

    // "The API refused" and "you have nothing" are different answers, and the
    // second one is a lie the server never authorised us to tell.
    await expect(
      anonymous.getByRole("heading", { name: "Projects could not be loaded" }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      anonymous.getByText(/The API refused the request, so we cannot tell whether you have any scans/i),
    ).toBeVisible();
    await expect(anonymous.getByText("No scans yet", { exact: true })).toHaveCount(0);

    // A loading state on the way here is legitimate. Still being in one at the
    // end is not: the page must reach a settled answer and stay there.
    await expect(anonymous.getByText("Loading projects…")).toHaveCount(0);
    await expect(anonymous.getByRole("button", { name: /Try again/i })).toBeVisible();

    // Re-checked after a further wait, because "settled" means it stopped
    // moving, not that it happened to be right once.
    await anonymous.waitForTimeout(3_000);
    await expect(anonymous.getByText("Loading projects…")).toHaveCount(0);
    await expect(
      anonymous.getByRole("heading", { name: "Projects could not be loaded" }),
    ).toBeVisible();

    expect(pageErrors()).toEqual([]);
  });

  test("a 401 is answered once, not retried — regression lock for the QueryClient 4xx retry fix", async ({
    anonymous,
  }) => {
    // WHY THIS TEST EXISTS, and why it may be red before the fix it guards.
    //
    // TanStack Query's default `retry: 3` with exponential backoff re-asks a
    // failed query three more times. A 401 from this API is deterministic —
    // the browser holds no credential, so asking again cannot change the
    // answer — and the only effect is that the honest copy above takes about
    // ten seconds to appear instead of about fifty milliseconds. Measured
    // against this stack: 2 requests at t≈2s, 3 at t≈5s, 4 by t≈10s, error
    // copy at t≈10s.
    //
    // The fix is a QueryClient that does not retry 4xx (except 408 and 429),
    // in `App.tsx`, owned by another change. This asserts the property that
    // fix creates, so it cannot be lost again: one request, and an answer in
    // human time.
    const projectRequests = countRequests(anonymous, isProjectsList);

    let firstRequestAt = 0;
    anonymous.on("request", (request) => {
      if (firstRequestAt === 0 && isProjectsList(request.url())) firstRequestAt = Date.now();
    });

    await anonymous.goto("/dashboard");

    const heading = anonymous.getByRole("heading", { name: "Projects could not be loaded" });
    await expect(heading).toBeVisible({ timeout: 20_000 });
    const settledAt = Date.now();

    // Measured from the first request rather than from navigation: the dev
    // server's first transform of a route is not the product's latency, and
    // timing that would make this test about Vite.
    expect(firstRequestAt).toBeGreaterThan(0);
    expect(settledAt - firstRequestAt).toBeLessThan(3_000);

    // Paired with the assertion above deliberately: a count of zero would
    // otherwise pass while proving the page never asked at all.
    expect(projectRequests()).toBe(1);
  });

  test("the timeline says it could not read, not that there is no history", async ({ anonymous }) => {
    await anonymous.goto("/dashboard");
    await anonymous.getByRole("button", { name: "Timeline" }).click();

    await expect(anonymous.getByText("Timeline could not be read.")).toBeVisible({ timeout: 20_000 });
    // "We could not ask" and "there is nothing there" are different answers,
    // and only one of them is true here.
    await expect(anonymous.getByTestId("timeline-no-history")).toHaveCount(0);
    await expect(anonymous.getByTestId("observed-series")).toHaveCount(0);
  });
});
