/**
 * A credentialed browser against a database that really is empty.
 *
 * This is the half of the pair that makes the previous file mean something.
 * "The API refused us" and "there is nothing here" are different sentences,
 * and a suite that only ever mocks one of them cannot prove the product tells
 * them apart. Here both come from the same real server, minutes apart, with
 * the only difference being whether the browser presented a key.
 *
 * **Ordering.** The specs in this directory share one database and run
 * serially, and this one asserts emptiness, so its filename sorts before the
 * files that seed data. That is load-bearing, not cosmetic.
 */
import { test, expect, countRequests, trackPageErrors } from "./support/fixtures";

function isProjectsList(url: string): boolean {
  return new URL(url).pathname === "/api/projects";
}

test.describe("the dashboard, authenticated against an empty estate", () => {
  test("says there are no scans, which is a claim the server actually authorised", async ({
    credentialed,
  }) => {
    const pageErrors = trackPageErrors(credentialed);
    const projectRequests = countRequests(credentialed, isProjectsList);

    let firstRequestAt = 0;
    credentialed.on("request", (request) => {
      if (firstRequestAt === 0 && isProjectsList(request.url())) firstRequestAt = Date.now();
    });

    await credentialed.goto("/dashboard");

    await expect(credentialed.getByRole("heading", { name: "No scans yet" })).toBeVisible({
      timeout: 20_000,
    });
    const settledAt = Date.now();

    await expect(credentialed.getByRole("heading", { name: "Projects could not be loaded" })).toHaveCount(0);
    await expect(credentialed.getByText("Loading projects…")).toHaveCount(0);
    await expect(credentialed.getByRole("link", { name: /Run a scan/i })).toBeVisible();

    // The same measurement the 401 regression lock makes, against a query that
    // is *already* answered once and settles immediately. It is here as the
    // positive control for that assertion: if this one ever fails, the problem
    // is the measurement, not the retry policy.
    expect(projectRequests()).toBe(1);
    expect(settledAt - firstRequestAt).toBeLessThan(3_000);

    expect(pageErrors()).toEqual([]);
  });

  test("the timeline refuses to draw a flat line through nothing", async ({ credentialed }) => {
    await credentialed.goto("/dashboard");
    await credentialed.getByRole("button", { name: "Timeline" }).click();

    const empty = credentialed.getByTestId("timeline-no-history");
    await expect(empty).toBeVisible({ timeout: 20_000 });
    await expect(empty).toContainText("No history to draw.");
    // The sentence is the server's, printed verbatim — the panel does not
    // compose its own reading of an empty inventory.
    await expect(empty).toContainText("This is an empty inventory, not a clean one.");

    // A zeroed chart here would claim a clean estate nobody has examined.
    await expect(credentialed.getByTestId("observed-series")).toHaveCount(0);
    await expect(credentialed.getByTestId("timeline-frame")).toHaveCount(0);
    await expect(credentialed.getByText("Timeline could not be read.")).toHaveCount(0);
  });

  test("the API says the same thing in the payload the panel reads", async ({ api }) => {
    const response = await api.get("/api/inventory/timeline");
    expect(response.status()).toBe(200);

    const body = (await response.json()) as {
      observed: { sufficientForTrend: boolean; distinctCollectionInstants: number; points: unknown[] };
    };

    expect(body.observed.sufficientForTrend).toBe(false);
    expect(body.observed.distinctCollectionInstants).toBe(0);
    expect(body.observed.points).toEqual([]);
  });

  test("the coverage meter waits for a project rather than reporting a zero", async ({
    credentialed,
  }) => {
    await credentialed.goto("/dashboard");

    // With no project there is nothing to measure, and "0 of 10 examined"
    // would be a statement about an estate that does not exist yet.
    await expect(credentialed.getByText("Select a project to see its coverage.")).toHaveCount(0);
    await expect(credentialed.getByText(/collector surfaces examined/)).toHaveCount(0);
  });
});
