/**
 * Applies lib/db/sql/tenant-isolation.sql — the roles, grants and row-level
 * security policies — against DATABASE_URL_MIGRATOR.
 *
 * This exists as a separate step, rather than living in the drizzle schema,
 * because `drizzle-kit push` creates RLS policies with NO `USING` expression:
 * `polqual IS NULL`, which permits every row while reading as installed. See
 * docs/Claude/13-auth-and-tenancy.md §5.4.
 *
 * Run it AFTER `drizzle-kit push` (push does not touch policies, but it does
 * create the tables the grants name), and re-run it after any future push.
 * `assertTenantIsolationInstalled()` gates API-server startup on the result.
 *
 * Idempotent.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.resolve(here, "../sql/tenant-isolation.sql");

const connectionString = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL_MIGRATOR is required. It must authenticate as a role that can " +
      "create roles and alter tables — NOT the runtime `quantaxscan_app` role.",
  );
}

if (process.env.DATABASE_URL_MIGRATOR === undefined) {
  console.warn(
    "DATABASE_URL_MIGRATOR is unset; falling back to DATABASE_URL. " +
      "If that is the runtime role this will fail, which is the correct outcome.",
  );
}

const client = new pg.Client({ connectionString });
await client.connect();

try {
  console.log(`Applying ${path.relative(process.cwd(), sqlPath)} …`);
  await client.query(readFileSync(sqlPath, "utf8"));

  // Passwords are deliberately not in the committed SQL. Set them here, from
  // the environment, when supplied; otherwise the roles exist without one and
  // cannot log in, which fails closed.
  for (const [role, envVar] of [
    ["quantaxscan_app", "QUANTAXSCAN_APP_DB_PASSWORD"],
    ["quantaxscan_migrator", "QUANTAXSCAN_MIGRATOR_DB_PASSWORD"],
  ] as const) {
    const password = process.env[envVar];
    if (!password) {
      console.warn(`${envVar} is unset — leaving ${role}'s password unchanged.`);
      continue;
    }
    // `ALTER ROLE ... PASSWORD` is DDL, and DDL takes no bind parameters —
    // `$1` there is a syntax error, not a placeholder. This is the same sharp
    // edge AGENTS.md records for CHECK constraints, in a different costume.
    // `escapeLiteral` is pg's own quoting, so the password is still never
    // naively interpolated.
    await client.query(`ALTER ROLE ${role} WITH PASSWORD ${client.escapeLiteral(password)}`);
    console.log(`Set password for ${role}.`);
  }

  const { rows } = await client.query<{ relname: string; policies: string }>(`
    select c.relname, string_agg(p.polname, ', ') as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_policy p on p.polrelid = c.oid
     where n.nspname = 'public' and p.polqual is not null
     group by c.relname
     order by c.relname`);

  console.log(`\nTables with an effective (non-NULL USING) policy: ${rows.length}`);
  for (const row of rows) console.log(`  ${row.relname}: ${row.policies}`);
  console.log(
    `\nVerify the whole picture with the API server's startup gate, or ` +
      `\`pnpm --filter @workspace/db run test\`.`,
  );
} finally {
  await client.end();
}
