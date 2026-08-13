import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { createOrgScope, type OrgScope } from "../org-scope";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../drizzle");
const tenantIsolationSqlPath = path.resolve(here, "../../sql/tenant-isolation.sql");

export interface CreateTestDbOptions {
  /**
   * Switch the connection to the runtime role after setup.
   *
   * **Read this before writing any isolation test.** PGlite connects as
   * `postgres`, which is `rolsuper = t, rolbypassrls = t`. With RLS enabled
   * *and* `FORCE ROW LEVEL SECURITY` set *and* no GUC at all, a plain SELECT
   * still returns every row across every organisation — verified. So a
   * cross-tenant test written naively against `createTestDb()` **passes while
   * proving nothing.**
   *
   * `asRole: "quantaxscan_app"` issues `SET ROLE`, which fixes it in-process
   * with no real PostgreSQL required: the same probe under that role returns
   * 0 rows with no GUC, 2 rows scoped to org 1, and 1 row scoped to org 2.
   *
   * The negative control in `tenant-isolation.test.ts` exists to keep this
   * honest — it asserts the harness role is genuinely subject to RLS, so a
   * future change that quietly drops the `SET ROLE` fails loudly instead of
   * making every isolation test vacuous.
   */
  asRole?: "quantaxscan_app";
  /**
   * Organisations seeded before the role switch, mirroring what
   * `apply-tenancy` creates in a real database. Defaults to `[1, 2]`:
   * organisation 1 because every pre-existing row belongs to it, and
   * organisation 2 so cross-tenant fixtures have a second tenant.
   *
   * Seeding happens as the superuser, because after `SET ROLE` the
   * `organizations` policy (deliberately) rejects inserts.
   */
  organizations?: number[];
}

export interface TestDb {
  db: PgliteDatabase<typeof schema>;
  /** Scope helpers bound to this test database. */
  scope: OrgScope;
  /** The raw client, for `exec()`-ing multi-statement SQL or re-issuing `SET ROLE`. */
  client: PGlite;
  /**
   * Seed fixtures as the pglite superuser, restoring the runtime role
   * afterwards. **Fixtures only** — using this to make an assertion pass would
   * be asserting against a connection that bypasses RLS, which is the exact
   * mistake the negative control exists to catch.
   *
   * It is needed because seeding two tenants' rows is, by construction,
   * something no single scoped connection may do.
   */
  seedAsSuperuser: (fn: (client: PGlite) => Promise<void>) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * A real (embedded, in-memory) Postgres instance with the actual generated
 * migrations in `lib/db/drizzle/` applied — not a hand-rolled approximation of
 * the schema. This is what lets `assets`/`observations` tests exercise the
 * genuine `CHECK`/foreign-key/unique-index constraints rather than asserting
 * against the TypeScript layer alone, and it has already caught a real bug
 * (see AGENTS.md on `sql.raw()` in CHECK constraints).
 *
 * It now also applies `lib/db/sql/tenant-isolation.sql` verbatim, so the
 * cross-tenant suite exercises the exact roles, grants and policies that get
 * applied to production — not a test-only approximation of them.
 */
export async function createTestDb(opts: CreateTestDbOptions = {}): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });

  // `exec()`, not `query()`: PGlite's query() uses the extended protocol and
  // rejects multi-statement SQL with "cannot insert multiple commands into a
  // prepared statement".
  await client.exec(readFileSync(tenantIsolationSqlPath, "utf8"));

  const organizations = opts.organizations ?? [1, 2];
  for (const id of organizations) {
    await client.query(
      `insert into organizations (id, name, slug, personal) values ($1, $2, $3, false)
         on conflict (id) do nothing`,
      [id, `Test Organization ${id}`, `test-org-${id}`],
    );
  }
  if (organizations.length > 0) {
    await client.exec(`select setval('organizations_id_seq', (select max(id) from organizations))`);
  }

  if (opts.asRole) {
    await client.exec(`SET ROLE ${opts.asRole}`);
  }

  const seedAsSuperuser = async (fn: (c: PGlite) => Promise<void>): Promise<void> => {
    if (opts.asRole) await client.exec("RESET ROLE");
    try {
      await fn(client);
    } finally {
      if (opts.asRole) await client.exec(`SET ROLE ${opts.asRole}`);
    }
  };

  return {
    db,
    // Test scopes log nothing: withoutOrgScope's warning is a deliberate
    // signal in production and pure noise in a test run.
    scope: createOrgScope(db, { warn: () => {} }),
    client,
    seedAsSuperuser,
    close: () => client.close(),
  };
}
