/**
 * The one-time data migration that turns an existing, single-tenant
 * QuantaXscan database into an organisation-scoped one.
 *
 * `drizzle-kit push` and the generated migration in `lib/db/drizzle/` handle
 * an EMPTY database correctly, but neither can add a `NOT NULL` column to a
 * POPULATED table — there is nothing to put in it. This script does the
 * ordering that makes it work: add nullable, backfill, then constrain.
 *
 * Run order for an existing deployment:
 *
 *   1. pnpm --filter @workspace/db run apply-tenancy   (this script)
 *   2. pnpm --filter @workspace/db run push            (reconciles anything left)
 *   3. pnpm --filter @workspace/db run apply-rls       (roles, grants, policies)
 *   4. point DATABASE_URL at `quantaxscan_app`, then deploy
 *
 * Step 4 is not optional decoration: until the runtime authenticates as a role
 * without BYPASSRLS and without table ownership, the policies installed in
 * step 3 are inert. See docs/Claude/13-auth-and-tenancy.md §5.2.
 *
 * Idempotent, and wrapped in a single transaction.
 */
import pg from "pg";

const connectionString = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL_MIGRATOR is required (a role that can perform DDL).");
}

const captainEmail = process.env.CAPTAIN_EMAIL;
if (!captainEmail) {
  throw new Error(
    "CAPTAIN_EMAIL is required: it becomes the owner of organisation 1, which every " +
      "pre-existing row is assigned to. Refusing to guess.",
  );
}

/**
 * How long share links created before this migration remain reachable.
 *
 * Legacy rows carry 10-character `Math.random()` identifiers and are
 * anonymously enumerable today (08-security.md S2). Converting an indefinite
 * exposure into a bounded one from inside this migration is the point; 30 days
 * is the captain's stated default over immediate revocation, which would break
 * any link already circulating.
 */
const LEGACY_SHARE_LINK_TTL = process.env.LEGACY_SHARE_LINK_TTL ?? "30 days";

const client = new pg.Client({ connectionString });
await client.connect();

async function step(label: string, sql: string, params: unknown[] = []): Promise<void> {
  const result = await client.query(sql, params);
  const count = Array.isArray(result) ? result.length : (result.rowCount ?? 0);
  console.log(`  ${label}${count ? ` (${count} row${count === 1 ? "" : "s"})` : ""}`);
}

try {
  await client.query("BEGIN");

  console.log("1. Tenancy tables");
  // The tables themselves come from the drizzle migration / push. This script
  // only handles what those cannot: existing data.
  const { rows: tableCheck } = await client.query<{ present: boolean }>(
    `select to_regclass('public.organizations') is not null as present`,
  );
  if (!tableCheck[0]?.present) {
    throw new Error(
      "`organizations` does not exist. Run `pnpm --filter @workspace/db run push` first — " +
        "this script migrates data, it does not create the schema.",
    );
  }

  console.log("2. Seed the captain, as organisation 1");
  // id 1 is required, not cosmetic: every existing assets/collection_runs row
  // already carries organization_id = 1 (asset-ingest.ts's former
  // DEFAULT_ORGANIZATION_ID), so the backfill for those two tables is a no-op
  // only if this organisation is that id.
  await step(
    "organizations",
    `insert into organizations (id, name, slug, personal)
       values (1, 'QuantaXscan', 'quantaxscan', false)
       on conflict (id) do nothing`,
  );
  await step("organizations_id_seq", `select setval('organizations_id_seq', (select max(id) from organizations))`);
  await step(
    "captain user",
    `insert into users (id, email, first_name)
       values (gen_random_uuid()::text, $1, 'Pradeep')
       on conflict (email) do nothing`,
    [captainEmail],
  );
  await step(
    "membership",
    `insert into organization_members (organization_id, user_id, role)
       select 1, id, 'owner' from users where email = $1
       on conflict (organization_id, user_id) do nothing`,
    [captainEmail],
  );

  console.log("3. Add columns nullable, backfill, then constrain");
  await step(
    "add columns",
    `alter table projects       add column if not exists organization_id integer;
     alter table scans          add column if not exists organization_id integer;
     alter table findings       add column if not exists organization_id integer;
     alter table observations   add column if not exists organization_id integer;
     alter table activity       add column if not exists organization_id integer;
     alter table community_posts add column if not exists author_user_id varchar;
     alter table shared_reports add column if not exists organization_id  integer,
                                add column if not exists created_by_user_id varchar,
                                add column if not exists visibility text not null default 'private',
                                add column if not exists expires_at timestamptz,
                                add column if not exists revoked_at timestamptz,
                                add column if not exists last_accessed_at timestamptz,
                                add column if not exists access_count integer not null default 0;`,
  );

  // `activity` stays NULL: existing rows are a global feed with no owner, and
  // the policy admits NULL for reads. See tenant-isolation.sql.
  await step("projects", `update projects     set organization_id = 1 where organization_id is null`);
  await step("scans", `update scans        set organization_id = 1 where organization_id is null`);
  await step("findings", `update findings     set organization_id = 1 where organization_id is null`);
  await step("observations", `update observations set organization_id = 1 where organization_id is null`);
  await step(
    "shared_reports",
    `update shared_reports
        set organization_id = coalesce(organization_id, 1),
            visibility      = 'public',
            expires_at      = coalesce(expires_at, now() + $1::interval)
      where organization_id is null or expires_at is null`,
    [LEGACY_SHARE_LINK_TTL],
  );

  await step(
    "constrain",
    `alter table projects       alter column organization_id set not null;
     alter table scans          alter column organization_id set not null;
     alter table findings       alter column organization_id set not null;
     alter table observations   alter column organization_id set not null;
     alter table shared_reports alter column organization_id set not null,
                                alter column expires_at      set not null;`,
  );

  console.log("4. Session store fix");
  // Truncate rather than convert. `expire AT TIME ZONE 'UTC'` would only be
  // correct if every existing row had been written under a server TimeZone of
  // UTC — and the bug being fixed is precisely that a stored `timestamp`'s
  // meaning depends on the writing session's TimeZone, so that cannot be
  // assumed. `sessions` is disposable state; converting it wrong silently
  // mis-dates every live session on a non-UTC deployment. This logs everyone
  // out once, at the moment the feature that introduces logging in ships.
  await step("truncate sessions", `delete from sessions`);
  await step(
    "expire -> timestamptz",
    `alter table sessions alter column expire type timestamptz`,
  );

  await client.query("COMMIT");
  console.log("\nDone. Next: `run push`, then `run apply-rls`, then point DATABASE_URL at quantaxscan_app.");
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  await client.end();
}
