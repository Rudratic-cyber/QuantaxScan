/**
 * Fixtures for the end-to-end suite.
 *
 * **The one rule.** No fixture here fabricates a response. `page.route` does
 * not appear in this directory; if you reach for it you are writing a
 * `tests/ui/` test, not an e2e one. What these fixtures do is configure the
 * browser the way a deployment configures it, and then get out of the way.
 */
import { readFileSync } from "node:fs";
import { test as base, type APIRequestContext, type Page, request } from "@playwright/test";
import { API_URL, STATE_FILE, UI_URL, type StackState } from "./config";

/**
 * The API key global setup generated. Read from the state file rather than
 * regenerated: each Playwright worker is its own process, so a key derived at
 * module load would differ from the one the server was started with.
 */
export function apiKey(): string {
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as StackState;
  return state.apiKey;
}

/**
 * The deployment-time API base URL, delivered exactly as production delivers
 * it: `window.__APP_CONFIG__.apiBaseUrl`, which `src/lib/api.ts` reads ahead of
 * the build-time `VITE_API_BASE_URL`. This is configuration, not interception —
 * every request still leaves the browser and hits the real server, cross-origin.
 */
async function configureApiBaseUrl(page: Page): Promise<void> {
  await page.addInitScript((baseUrl) => {
    (window as unknown as { __APP_CONFIG__: { apiBaseUrl: string } }).__APP_CONFIG__ = {
      apiBaseUrl: baseUrl,
    };
  }, API_URL);
}

/**
 * Makes the browser present the API key on every call to the API origin.
 *
 * The product has no sign-in yet (docs/Claude/13-auth-and-tenancy.md §7.3 —
 * that is P2), so the shipped bundle carries no credential and the *real*
 * browser behaviour today is a 401. That is a state worth testing on its own,
 * and `anonymous` covers it. But "authenticated and empty" and "authenticated
 * with real data" are also real states, and this is the smallest honest way to
 * reach them from a browser: attach the header the API already accepts.
 *
 * Two things this is not. It is not a mock — the request goes to the real
 * server and the real response comes back. And it is not a way around CORS:
 * `X-API-Key` is not a CORS-safelisted header, so adding it forces a genuine
 * preflight on every request, which is more of the real path than the
 * unauthenticated case exercises, not less.
 */
async function presentApiKey(page: Page, key: string, apiOrigin: string): Promise<void> {
  await page.addInitScript(
    ({ key: headerValue, origin }) => {
      const original = window.fetch;
      window.fetch = function patched(input: RequestInfo | URL, init?: RequestInit) {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (!url.startsWith(origin)) return original.call(this, input, init);

        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        headers.set("X-API-Key", headerValue);
        return original.call(this, input, { ...init, headers });
      };
    },
    { key, origin: apiOrigin },
  );
}

type Fixtures = {
  /** A browser with no credential — what a visitor to the deployment gets. */
  anonymous: Page;
  /** A browser that presents the API key, standing in for a signed-in session. */
  credentialed: Page;
  /** Direct HTTP to the API, authenticated. Used to seed real data, not to assert UI. */
  api: APIRequestContext;
  /** Direct HTTP to the API with no credential and no Origin header. */
  publicApi: APIRequestContext;
};

export const test = base.extend<Fixtures>({
  anonymous: async ({ page }, use) => {
    await configureApiBaseUrl(page);
    await use(page);
  },

  credentialed: async ({ page }, use) => {
    await configureApiBaseUrl(page);
    await presentApiKey(page, apiKey(), API_URL);
    await use(page);
  },

  api: async ({}, use) => {
    const context = await request.newContext({
      baseURL: API_URL,
      extraHTTPHeaders: { "X-API-Key": apiKey() },
    });
    await use(context);
    await context.dispose();
  },

  publicApi: async ({}, use) => {
    const context = await request.newContext({ baseURL: API_URL });
    await use(context);
    await context.dispose();
  },
});

export { expect } from "@playwright/test";
export { API_URL, UI_URL };

/**
 * Counts requests the browser actually made to a path, by observing them.
 * Observation, not interception: the requests are not touched.
 */
export function countRequests(page: Page, matcher: (url: string) => boolean): () => number {
  let count = 0;
  page.on("request", (req) => {
    if (req.method() !== "OPTIONS" && matcher(req.url())) count += 1;
  });
  return () => count;
}

/** Fails the test if the page raised an unhandled exception at any point. */
export function trackPageErrors(page: Page): () => string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return () => errors;
}
