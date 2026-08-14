/**
 * The real database half of the e2e stack.
 *
 * **Why this is PostgreSQL and not pglite.** Every other database-backed suite
 * in this repository uses `@electric-sql/pglite` in process, and that is the
 * right default — but it cannot back a real HTTP server, for two independent
 * reasons, both measured against `@electric-sql/pglite-socket` 0.2.8 before
 * this file was written:
 *
 *  1. **Every connection is `postgres`.** The socket server ignores the user
 *     in the startup packet, so `current_user` is the superuser on every
 *     connection and `rolbypassrls` is true. RLS would be inert,
 *     `assertTenantIsolationInstalled()` would still pass, and the suite would
 *     be exactly the "passes while proving nothing" trap AGENTS.md warns about
 *     for `createTestDb()` without `asRole`.
 *  2. **A second connection blocks forever behind an open transaction.** PGlite
 *     is a single backend; the socket server multiplexes onto it. With one
 *     client inside `BEGIN`, a `SELECT 1` on a second connection never returns.
 *     Every `withOrg()` call opens a transaction on a `pg.Pool`, and the
 *     dashboard issues several requests at once, so this is a deadlock in
 *     normal operation rather than an edge case.
 *
 * So: PostgreSQL 16, in a container this suite owns, or a cluster supplied by
 * the operator through `E2E_DATABASE_ADMIN_URL` (which is how CI passes its
 * `services:` container). If neither is available the run fails. It never
 * skips — a green e2e stage with no database is worse than no stage.
 */
import pg from "pg";
import {
  ADMIN_URL_OVERRIDE,
  APP_DB_PASSWORD,
  CAPTAIN_EMAIL,
  DB_NAME,
  HOST,
  MIGRATOR_DB_PASSWORD,
  PG_CONTAINER,
  PG_IMAGE,
  PG_PORT,
  PG_SUPERUSER,
  PG_SUPERUSER_PASSWORD,
  SECOND_ORG_NAME,
  SECOND_ORG_SLUG,
  adminUrl,
  migratorUrl,
  runtimeUrl,
} from "./config";
import { run, waitUntilReady } from "./process";

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function canConnect(url: string): Promise<boolean> {
  return withClient(url, async (client) => {
    await client.query("select 1");
    return true;
  }).catch(() => false);
}

/**
 * Brings up a PostgreSQL the suite can do DDL against.
 * Returns true when it started a container that teardown must remove.
 */
export async function ensurePostgres(): Promise<boolean> {
  if (ADMIN_URL_OVERRIDE) {
    await waitUntilReady(null, `PostgreSQL at ${redact(ADMIN_URL_OVERRIDE)}`, () =>
      canConnect(adminUrl("postgres")),
    );
    return false;
  }

  const dockerAvailable = await run("docker", "docker", ["version", "--format", "{{.Server.Version}}"])
    .then(() => true)
    .catch(() => false);

  if (!dockerAvailable) {
    throw new Error(
      "No database for the e2e suite.\n" +
        "  Either set E2E_DATABASE_ADMIN_URL to a PostgreSQL superuser connection string,\n" +
        "  or make a working Docker daemon available so the suite can start its own.\n" +
        "  This suite will not run against a mock, and will not silently skip.",
    );
  }

  // A container left behind by an interrupted run holds the port. Remove it
  // rather than reusing it: reuse is how a suite ends up asserting against
  // last week's schema.
  await run("docker rm", "docker", ["rm", "-f", PG_CONTAINER]).catch(() => "");

  await run("docker run", "docker", [
    "run",
    "--detach",
    "--name",
    PG_CONTAINER,
    "--publish",
    `${HOST}:${PG_PORT}:5432`,
    "--env",
    `POSTGRES_PASSWORD=${PG_SUPERUSER_PASSWORD}`,
    "--env",
    `POSTGRES_USER=${PG_SUPERUSER}`,
    // Nothing here outlives the run, so durability costs time for no benefit.
    "--tmpfs",
    "/var/lib/postgresql/data",
    PG_IMAGE,
    "-c",
    "fsync=off",
    "-c",
    "full_page_writes=off",
  ]);

  await waitUntilReady(null, `PostgreSQL container ${PG_CONTAINER}`, () =>
    canConnect(adminUrl("postgres")),
  );

  return true;
}

/** A run always starts from an empty database, never from what was left over. */
export async function resetDatabase(): Promise<void> {
  await withClient(adminUrl("postgres"), async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(DB_NAME)} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${quoteIdent(DB_NAME)}`);
  });
}

/**
 * The documented deploy sequence, run for real.
 *
 * docs/Claude/13-auth-and-tenancy.md §10 gives the order for an existing,
 * populated deployment: `apply-tenancy` → `push` → `apply-rls`. A *fresh*
 * database needs `push` first, because `apply-tenancy` inserts into `users`
 * and alters `projects` — tables that do not exist until `push` creates them.
 * The second `push` is §10's reconciliation step, which adds the foreign keys,
 * indexes and CHECK constraints `apply-tenancy` deliberately leaves alone.
 *
 * Running the real scripts rather than re-implementing them is deliberate: it
 * means this suite also proves the documented sequence still produces a
 * database the server will boot against.
 */
export async function migrate(): Promise<void> {
  const migrator = migratorUrl();
  const ddlEnv = {
    // drizzle.config.ts reads DATABASE_URL, not DATABASE_URL_MIGRATOR, so the
    // DDL connection has to be handed to `push` under that name.
    DATABASE_URL: migrator,
    DATABASE_URL_MIGRATOR: migrator,
    CAPTAIN_EMAIL,
    QUANTAXSCAN_APP_DB_PASSWORD: APP_DB_PASSWORD,
    QUANTAXSCAN_MIGRATOR_DB_PASSWORD: MIGRATOR_DB_PASSWORD,
  };

  await run("push", "pnpm", ["--filter", "@workspace/db", "run", "push-force"], ddlEnv);
  await run("apply-tenancy", "pnpm", ["--filter", "@workspace/db", "run", "apply-tenancy"], ddlEnv);
  await run("push (reconcile)", "pnpm", ["--filter", "@workspace/db", "run", "push-force"], ddlEnv);
  await run("apply-rls", "pnpm", ["--filter", "@workspace/db", "run", "apply-rls"], ddlEnv);
}

/**
 * The negative control, and the reason this file exists at all.
 *
 * `lib/db/src/tenant-isolation.test.ts` opens with the same check for the same
 * reason: policies installed against a role that bypasses them are decoration.
 * If the runtime connection turns out to be a superuser — which is precisely
 * what happens under pglite-socket — every downstream assertion in this suite
 * would still pass and mean nothing. Fail here instead.
 */
export async function assertRuntimeRoleIsSubjectToRls(): Promise<void> {
  const url = runtimeUrl();
  const user = new URL(url).username;
  if (user !== "quantaxscan_app") {
    throw new Error(
      `The API server's DATABASE_URL authenticates as "${user}", not quantaxscan_app. ` +
        `Row-level security is inert for an owner or a superuser, so the isolation this ` +
        `stack appears to have would be theatre.`,
    );
  }

  await withClient(url, async (client) => {
    const { rows } = await client.query<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `select current_user, r.rolsuper, r.rolbypassrls
         from pg_roles r where r.rolname = current_user`,
    );

    const row = rows[0];
    if (!row) throw new Error("Could not read the runtime role from pg_roles.");
    if (row.current_user !== "quantaxscan_app" || row.rolsuper || row.rolbypassrls) {
      throw new Error(
        `The runtime role is not subject to row-level security: ` +
          `current_user=${row.current_user} rolsuper=${row.rolsuper} rolbypassrls=${row.rolbypassrls}. ` +
          `Every tenant-scoped assertion below would pass while proving nothing.`,
      );
    }
  });
}

/**
 * Creates the second organisation for 07-multi-org.spec.ts, through the real
 * operator script (`lib/db/scripts/create-organization.ts`) rather than a raw
 * INSERT — this is also how the script itself gets exercised end to end.
 * Returns its id, read back afterwards since the script only prints it.
 *
 * Called only when `SECOND_ORG_ENABLED` (config.ts); every other run of this
 * global setup never touches this function.
 */
export async function ensureSecondOrganization(): Promise<number> {
  const migrator = migratorUrl();
  await run("create-organization", "pnpm", ["--filter", "@workspace/db", "run", "create-organization"], {
    DATABASE_URL_MIGRATOR: migrator,
    ORG_NAME: SECOND_ORG_NAME,
    ORG_SLUG: SECOND_ORG_SLUG,
  });

  return withClient(migrator, async (client) => {
    const { rows } = await client.query<{ id: number }>(
      `select id from organizations where slug = $1`,
      [SECOND_ORG_SLUG],
    );
    const org = rows[0];
    if (!org) {
      throw new Error(
        `create-organization ran but no organisation with slug "${SECOND_ORG_SLUG}" exists afterwards.`,
      );
    }
    return org.id;
  });
}

export async function dropContainer(): Promise<void> {
  await run("docker rm", "docker", ["rm", "-f", PG_CONTAINER]).catch(() => "");
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function redact(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "the configured URL";
  }
}
