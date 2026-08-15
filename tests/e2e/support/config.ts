/**
 * One place that decides what the e2e stack is called and where it listens.
 *
 * Imported by the Playwright config, by global setup/teardown and by the
 * specs, so all four agree by construction rather than by coincidence.
 *
 * Every port is overridable. The defaults deliberately avoid the ports this
 * repository already documents (Postgres 55432, API 5055, frontend 5199, UI
 * suite 5833) and the ones commonly held by a concurrent worktree — see
 * AGENTS.md § "Local dev ports collide with other concurrent worktrees".
 * `vite.config.ts` sets `strictPort`, so a clash fails loudly instead of
 * quietly serving from somewhere else.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";

/**
 * `__dirname`, not `import.meta.url`: the root package has no `"type":
 * "module"`, so Playwright loads these files as CommonJS and `import.meta` is
 * a syntax error there.
 */
export const REPO_ROOT = path.resolve(__dirname, "../../..");

/**
 * Everything binds and is addressed as 127.0.0.1, never `localhost`.
 * `http://localhost:P` and `http://127.0.0.1:P` are *different* origins as far
 * as CORS is concerned, and a mismatch between Playwright's `baseURL` and the
 * API's `CORS_ALLOWED_ORIGINS` would fail the cross-origin spec for a reason
 * that has nothing to do with the code under test.
 */
export const HOST = "127.0.0.1";

function port(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`${name} must be a valid TCP port, got "${raw}"`);
  }
  return value;
}

export const PG_PORT = port("E2E_PG_PORT", 55441);
export const API_PORT = port("E2E_API_PORT", 5711);
export const UI_PORT = port("E2E_UI_PORT", 5712);

export const API_URL = `http://${HOST}:${API_PORT}`;
export const UI_URL = `http://${HOST}:${UI_PORT}`;

/** Container name and image used when this suite provisions its own Postgres. */
export const PG_CONTAINER = process.env["E2E_PG_CONTAINER"] ?? "quantaxscan-e2e-pg";
export const PG_IMAGE = process.env["E2E_PG_IMAGE"] ?? "postgres:16-alpine";
export const PG_SUPERUSER = "postgres";
export const PG_SUPERUSER_PASSWORD = "e2e-postgres";
export const DB_NAME = process.env["E2E_DB_NAME"] ?? "quantaxscan_e2e";

/**
 * Passwords for the two database roles `apply-rls` creates. Without these the
 * roles are created *without* a password and therefore cannot log in, which
 * fails closed — correct in production, fatal for a test stack.
 *
 * These are throwaway credentials for a database that exists for the duration
 * of one test run on loopback. They are not secrets and nothing else uses them.
 */
export const APP_DB_PASSWORD = "e2e-app-role";
export const MIGRATOR_DB_PASSWORD = "e2e-migrator-role";

/**
 * The API key the *tests* present. Generated per run rather than committed:
 * a key in the repository is a key in the repository, even a test one. The
 * server rejects anything under 24 characters at startup.
 */
export const API_KEY = process.env["E2E_API_KEY"] ?? randomBytes(32).toString("base64url");

/** Organisation the API-key principal acts as — seeded by `apply-tenancy`. */
export const API_KEY_ORG_ID = "1";

/**
 * F4's credential-store key, and the id the server stamps on every row it
 * encrypts. Generated per run for the same reason `API_KEY` is.
 *
 * This is deployment configuration, not a test fixture: without it the server
 * answers 503 to `POST /credentials`, which is a real and reachable state
 * (`routes/credentials.ts` — there is deliberately no startup gate). Setting it
 * here does not hide that branch: it is asserted against the real handler in
 * `artifacts/api-server/src/secret-redaction.test.ts`, which is the right level
 * for it — proving it end to end would need a second API server started with
 * the variable unset, for one status code.
 */
export const CREDENTIAL_KEY_ID = "e2e";
export const CREDENTIAL_KEYS =
  process.env["E2E_CREDENTIAL_KEYS"] ?? `${CREDENTIAL_KEY_ID}:${randomBytes(32).toString("base64")}`;

/**
 * D8's certificate-transparency source, pointed at a stub the discovery spec
 * starts on this port.
 *
 * Using the operator override rather than the real crt.sh is the point, not a
 * shortcut: a suite that queried a public log would be asserting on whatever
 * certificates the internet happened to hold that morning, would fail in an
 * offline CI, and would put load on somebody else's free service on every run.
 * `ct-log.ts` supports exactly this and warns loudly when it is set, which is
 * the behaviour a production deployment wants.
 *
 * Pointing at loopback additionally needs `..._ALLOW_PRIVATE_SOURCES=1` — the
 * SSRF guard that otherwise refuses a source resolving into a private range.
 * That it must be set explicitly here is the guard working.
 */
export const CT_STUB_PORT = port("E2E_CT_STUB_PORT", 5713);
export const CT_STUB_URL = `http://${HOST}:${CT_STUB_PORT}`;

/**
 * A resolver address with nothing listening on it.
 *
 * D8's sharpest false-positive control is that an unreachable resolver yields
 * `undetermined` and never `not-resolved` — "we could not check" must not read
 * as "this host does not exist", because the second sentence retires a target.
 * Pointing DNS at a dead port is the cheapest way to exercise that against the
 * real resolver rather than a stub of one, so the mapping under test is Node's
 * actual error code and not a fixture's idea of it.
 */
export const DEAD_DNS_SERVER = process.env["E2E_DEAD_DNS_SERVER"] ?? `${HOST}:59`;

/**
 * F1's session secret and a GitHub provider registration.
 *
 * Configured here because **an unconfigured deployment answers 501 to every
 * `/auth/*` route**, and a spec run against that state asserts only that the
 * feature is switched off. With these set, `/auth/providers` really lists what
 * the registry resolved, `/auth/session` really runs the session middleware,
 * and a forged callback is really rejected by the transaction check rather than
 * by a feature flag.
 *
 * The client id and secret are deliberately fake and never leave the process:
 * nothing in the suite completes an authorization-code exchange, because doing
 * so honestly would need a token-minting stub — that flow is proven at the unit
 * level (see `routes/auth.ts`'s header on why GitHub rather than Google).
 * `assertSessionConfigured` refuses to start with a provider and no secret, so
 * these two must be set together.
 */
export const SESSION_SECRET = process.env["E2E_SESSION_SECRET"] ?? randomBytes(32).toString("base64url");
export const GITHUB_OAUTH_CLIENT_ID = "e2e-client-id-not-a-real-registration";
export const GITHUB_OAUTH_CLIENT_SECRET = "e2e-client-secret-not-a-real-registration";

/** `apply-tenancy` refuses to run without this; it owns organisation 1. */
export const CAPTAIN_EMAIL = "e2e-captain@quantaxscan.invalid";

/**
 * A second organisation and a second API key bound to it — 07-multi-org.spec.ts's
 * fixture, and *opt-in only*. Every other spec, and every other lane's run of
 * this same global setup, must see byte-identical behaviour to before this
 * existed, so nothing below runs unless `E2E_SECOND_ORG=1` is set on the
 * process that starts the stack.
 *
 * `global-setup.ts` creates the organisation (via
 * `pnpm --filter @workspace/db run create-organization`, the real script, not
 * a shortcut) and binds this key to it with `QUANTAXSCAN_API_KEY_ORG_IDS`; the
 * organisation's actual id is only known once that runs, so it is written into
 * `StackState` rather than hard-coded here.
 */
export const SECOND_ORG_ENABLED = process.env["E2E_SECOND_ORG"] === "1";
export const SECOND_ORG_SLUG = process.env["E2E_SECOND_ORG_SLUG"] ?? "second-org-e2e";
export const SECOND_ORG_NAME = process.env["E2E_SECOND_ORG_NAME"] ?? "Second Org (e2e)";
export const SECOND_API_KEY = process.env["E2E_SECOND_API_KEY"] ?? randomBytes(32).toString("base64url");

/**
 * Set when the operator has already provided a PostgreSQL cluster (CI passes
 * a `services:` container this way). When absent the suite starts its own
 * container. When neither is possible the run fails — it never skips.
 */
export const ADMIN_URL_OVERRIDE = process.env["E2E_DATABASE_ADMIN_URL"];

export function adminUrl(database: string): string {
  if (ADMIN_URL_OVERRIDE) {
    const url = new URL(ADMIN_URL_OVERRIDE);
    url.pathname = `/${database}`;
    return url.toString();
  }
  return `postgres://${PG_SUPERUSER}:${PG_SUPERUSER_PASSWORD}@${HOST}:${PG_PORT}/${database}`;
}

/** DDL connection: `drizzle-kit push`, `apply-tenancy`, `apply-rls`. */
export function migratorUrl(): string {
  return adminUrl(DB_NAME);
}

/**
 * Runtime connection. Authenticates as `quantaxscan_app` — a role with no
 * table ownership and no BYPASSRLS. Connect as the owner or a superuser here
 * and every row-level-security policy is inert while the code behaves
 * identically; global setup asserts that has not happened.
 */
export function runtimeUrl(): string {
  const host = ADMIN_URL_OVERRIDE ? new URL(ADMIN_URL_OVERRIDE).hostname : HOST;
  const pgPort = ADMIN_URL_OVERRIDE ? (new URL(ADMIN_URL_OVERRIDE).port || "5432") : String(PG_PORT);
  return `postgres://quantaxscan_app:${APP_DB_PASSWORD}@${host}:${pgPort}/${DB_NAME}`;
}

/**
 * Where global setup records what it started, so teardown can stop it.
 * Deliberately not under `test-results/`: Playwright empties that directory
 * when the run begins, which is after global setup has written to it.
 */
export const STATE_FILE = path.join(REPO_ROOT, ".e2e-stack.json");

/** Server logs, kept for the same reason and out of the same directory. */
export const LOG_DIR = path.join(REPO_ROOT, ".e2e-logs");

export type StackState = {
  apiPid: number | null;
  uiPid: number | null;
  startedContainer: boolean;
  container: string;
  apiKey: string;
  /** Set only when `SECOND_ORG_ENABLED`. Persisted for the same reason `apiKey` is:
   *  each Playwright worker is its own process, so a key regenerated at module
   *  load in that process would differ from the one the server was started with. */
  secondApiKey?: string;
  /** Set only when `SECOND_ORG_ENABLED` — the id `create-organization` assigned. */
  secondOrganizationId?: number;
};
