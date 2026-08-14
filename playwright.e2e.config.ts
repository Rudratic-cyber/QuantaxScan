/**
 * The end-to-end suite: real browser → real frontend → real API server →
 * real PostgreSQL.
 *
 * Separate from `playwright.config.ts` on purpose. That config owns
 * `tests/ui/`, where every journey mocks the API with `page.route` — fast,
 * hermetic, and structurally unable to see an authentication failure, a real
 * 401, a CORS refusal, a serialisation mismatch between the generated client
 * and the actual response, or a query that never settles. This one owns
 * `tests/e2e/`, where nothing is mocked and the whole stack is started and
 * torn down by the suite itself.
 *
 * There is no `webServer` block: the stack is more than a web server (a
 * database that must be migrated in a specific order, and a runtime role whose
 * privileges have to be checked before any assertion is worth anything), so
 * `globalSetup` owns it and reports what failed.
 */
import { defineConfig, devices } from "@playwright/test";
import { API_URL, UI_URL } from "./tests/e2e/support/config";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",

  // One database, shared by every spec, and some specs write to it. Serial
  // execution is the honest way to keep an assertion about "an empty estate"
  // meaningful while another spec is running a scan.
  fullyParallel: false,
  workers: 1,

  forbidOnly: !!process.env.CI,
  // No retries. A retry here would mask exactly the class of defect this suite
  // exists to catch: something that settles late, or only sometimes.
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",

  // Real servers, real scans. The demo scan runs the actual scanner over a
  // multi-file repository, which is not instant.
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: UI_URL,
    trace: "retain-on-failure",
    // Recorded so a failure report shows what the browser actually asked for
    // and what the server actually said.
    video: "off",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  metadata: { apiUrl: API_URL, uiUrl: UI_URL },
});
