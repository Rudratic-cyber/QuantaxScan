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
  HOST,
  STATE_FILE,
  UI_PORT,
  UI_URL,
  runtimeUrl,
  type StackState,
} from "./support/config";
import {
  assertRuntimeRoleIsSubjectToRls,
  ensurePostgres,
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

    if (process.env["E2E_SKIP_BUILD"] !== "1") {
      log("build api-server");
      await run("build", "pnpm", ["--filter", "@workspace/api-server", "run", "build"]);
    }

    log(`api server on ${API_URL}`);
    const api = start("api-server", "pnpm", ["--filter", "@workspace/api-server", "run", "start"], {
      PORT: String(API_PORT),
      DATABASE_URL: runtimeUrl(),
      QUANTAXSCAN_API_KEYS: API_KEY,
      QUANTAXSCAN_API_KEY_ORG_ID: API_KEY_ORG_ID,
      // The frontend is served from a different origin, so this is what makes
      // the browser's requests legal. Character-for-character: `localhost` and
      // `127.0.0.1` are different origins.
      CORS_ALLOWED_ORIGINS: UI_URL,
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
