/**
 * Brings up the real stack: PostgreSQL 16, the built API server, and the
 * frontend's dev server on a different origin.
 *
 * Nothing here is mocked and nothing here is optional. If any of the three is
 * not genuinely serving by the time this returns, the run fails before a
 * single spec executes — a suite that goes green while the server is down is
 * worse than no suite.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  API_KEY,
  API_KEY_ORG_ID,
  API_PORT,
  API_URL,
  CREDENTIAL_KEYS,
  CT_STUB_URL,
  DEAD_DNS_SERVER,
  HOST,
  SECOND_API_KEY,
  SECOND_ORG_ENABLED,
  STATE_FILE,
  UI_PORT,
  UI_URL,
  runtimeUrl,
  type StackState,
} from "./support/config";
import {
  assertRuntimeRoleIsSubjectToRls,
  ensurePostgres,
  ensureSecondOrganization,
  migrate,
  resetDatabase,
} from "./support/database";
import { run, start, stop, waitUntilReady } from "./support/process";

async function probe(url: string, accept: (response: Response) => Promise<boolean>): Promise<boolean> {
  const response = await fetch(url).catch(() => null);
  if (!response) return false;
  return accept(response);
}

export default async function globalSetup(): Promise<void> {
  const started: StackState = {
    apiPid: null,
    uiPid: null,
    startedContainer: false,
    container: "",
    apiKey: API_KEY,
  };
  const persist = () => {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(started, null, 2));
  };

  try {
    log("database");
    started.startedContainer = await ensurePostgres();
    persist();
    await resetDatabase();
    await migrate();
    await assertRuntimeRoleIsSubjectToRls();

    // Opt-in only (07-multi-org.spec.ts's own run sets E2E_SECOND_ORG=1). Every
    // other spec, and every other lane's invocation of this same global setup,
    // takes the branch below unchanged: one key, one org, exactly as before.
    let secondOrganizationId: number | null = null;
    if (SECOND_ORG_ENABLED) {
      log("second organisation");
      secondOrganizationId = await ensureSecondOrganization();
      started.secondApiKey = SECOND_API_KEY;
      started.secondOrganizationId = secondOrganizationId;
      persist();
    }

    if (process.env["E2E_SKIP_BUILD"] !== "1") {
      log("build api-server");
      await run("build", "pnpm", ["--filter", "@workspace/api-server", "run", "build"]);
    }

    log(`api server on ${API_URL}`);
    const api = start("api-server", "pnpm", ["--filter", "@workspace/api-server", "run", "start"], {
      PORT: String(API_PORT),
      DATABASE_URL: runtimeUrl(),
      // N keys -> N orgs, positionally paired — see
      // artifacts/api-server/src/lib/principal.ts. Without a second
      // organisation, QUANTAXSCAN_API_KEY_ORG_ID keeps the single-key,
      // single-org shape every other spec relies on.
      ...(secondOrganizationId !== null
        ? {
            QUANTAXSCAN_API_KEYS: `${API_KEY},${SECOND_API_KEY}`,
            QUANTAXSCAN_API_KEY_ORG_IDS: `${API_KEY_ORG_ID},${secondOrganizationId}`,
          }
        : {
            QUANTAXSCAN_API_KEYS: API_KEY,
            QUANTAXSCAN_API_KEY_ORG_ID: API_KEY_ORG_ID,
          }),
      // F4's credential store. Configured here because an unconfigured store
      // answers 503 by design, so without this the credential spec would be
      // asserting a deployment that has not enabled the feature rather than
      // the feature — see support/config.ts.
      QUANTAXSCAN_CREDENTIAL_KEYS: CREDENTIAL_KEYS,
      // D8's discovery source and resolver. Both point somewhere deliberate:
      // the CT stub the discovery spec runs, and a resolver port with nothing
      // on it. Neither reaches the internet, which is what keeps the suite
      // runnable offline and off crt.sh's free service. See support/config.ts.
      QUANTAXSCAN_CT_LOG_BASE_URL: CT_STUB_URL,
      QUANTAXSCAN_DISCOVERY_ALLOW_PRIVATE_SOURCES: "1",
      QUANTAXSCAN_DISCOVERY_DNS_SERVERS: DEAD_DNS_SERVER,
      // The frontend is served from a different origin, so this is what makes
      // the browser's requests legal. Character-for-character: `localhost` and
      // `127.0.0.1` are different origins.
      CORS_ALLOWED_ORIGINS: UI_URL,
      // S6/S7's budgets are per five minutes and per client address. The whole
      // suite runs against one stack from one address, and with thirteen specs
      // it now makes several hundred requests inside a single window — so the
      // limiter starts answering 429 partway through and specs fail for a
      // reason that has nothing to do with what they test. Each spec stayed
      // under the budget when it was the only one running, which is why this
      // only appeared once the collector lanes landed together.
      //
      // Raised rather than disabled, and no coverage is lost: no e2e spec
      // asserts 429, and the limiter's real behaviour — the budgets, the
      // window, the `Retry-After` header, the per-route buckets — is proven in
      // `rate-limit.test.ts` and `rate-limit-edge.test.ts` against the real
      // middleware. Leaving it on at a raised budget still exercises the code
      // path on every request rather than stubbing it out.
      RATE_LIMIT_EDGE_MAX: "100000",
      RATE_LIMIT_DEFAULT_MAX: "100000",
      RATE_LIMIT_SCAN_MAX: "100000",
      RATE_LIMIT_TLS_MAX: "100000",
      NODE_ENV: "production",
      LOG_LEVEL: "warn",
    });
    started.apiPid = api.child.pid ?? null;
    persist();

    await waitUntilReady(api, "API server", () =>
      probe(`${API_URL}/api/healthz`, async (response) => {
        if (!response.ok) return false;
        const body = (await response.json().catch(() => null)) as { status?: string } | null;
        return body?.status === "ok";
      }),
    );

    log(`frontend on ${UI_URL}`);
    const ui = start("frontend", "pnpm", ["--filter", "@workspace/quantaxscan", "run", "dev"], {
      PORT: String(UI_PORT),
      HOST,
      VITE_API_BASE_URL: API_URL,
    });
    started.uiPid = ui.child.pid ?? null;
    persist();

    await waitUntilReady(ui, "frontend dev server", () =>
      probe(UI_URL, async (response) => response.ok && (await response.text()).includes("<div id=\"root\"")),
    );

    log("stack up");
  } catch (error) {
    // Leave nothing listening behind a failed setup; the next run needs the
    // ports and would otherwise fail for the wrong reason.
    stop(started.apiPid);
    stop(started.uiPid);
    persist();
    throw error;
  }
}

function log(message: string): void {
  process.stdout.write(`  e2e stack · ${message}\n`);
}
