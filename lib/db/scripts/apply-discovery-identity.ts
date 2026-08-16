/**
 * The one-time data migration for discovery stage 0 — the `hostname` →
 * `identity` widening of `discovered_targets`.
 * docs/Claude/17-discovery-design.md §2.2, §6.1.
 *
 * ## Why this script has to exist at all
 *
 * `lib/db/drizzle/0017_fine_gravity.sql` already does the right thing:
 * add nullable, backfill, constrain. **But this project does not run generated
 * migrations on deploy.** CLAUDE.md is explicit that `drizzle-kit push` is the
 * actual deploy mechanism, that `generate` produces *reviewable* SQL, and that
 * there is no migrate-on-deploy step in `Dockerfile.api` — and the e2e stack
 * agrees, building its schema with `push-force`
 * (`tests/e2e/support/database.ts`). So on any real database, what runs is
 * `push`, which computes DDL from the schema files and would emit
 *
 *     alter table discovered_targets add column identity text not null;
 *
 * That statement cannot apply to a table that already has rows: there is no
 * value for the existing ones. `push` would also have to guess whether
 * `identity` is a new column or a rename of `source_domain`, and the answer it
 * offers interactively is the wrong one — taking it would discard every
 * hostname the table holds.
 *
 * This is precisely the case `apply-tenancy` exists for, and it is described in
 * CLAUDE.md in those words: the add-nullable → backfill → constrain ordering is
 * something "neither `push` nor a generated migration can do on a populated
 * table". So it ships the same way — as a script with a documented place in the
 * deploy order.
 *
 * ## Run order for an existing deployment
 *
 *   1. pnpm --filter @workspace/db run apply-discovery-identity   (this script)
 *   2. pnpm --filter @workspace/db run push                       (indexes, checks, discovery_runs)
 *   3. pnpm --filter @workspace/db run apply-rls                  (policy + grant for discovery_runs)
 *
 * Step 3 is not optional: `discovery_runs` is in `ORG_SCOPED_TABLES`, and a
 * table with no grant is unreachable by the runtime — the fail-closed default,
 * and what `assertTenantIsolationInstalled()` refuses to boot without.
 *
 * **A fresh database needs none of this.** With no rows, `push` adds the
 * columns without complaint and this script's backfill matches nothing. It is
 * still safe to run — every statement is guarded — and running it is the
 * cheaper habit than deciding each time whether the table is populated.
 *
 * Idempotent, and wrapped in a single transaction.
 */
import pg from "pg";
import {
  DISCOVERY_IDENTITY_ADD_COLUMNS,
  DISCOVERY_IDENTITY_BACKFILL,
  DISCOVERY_IDENTITY_CONSTRAIN,
  DISCOVERY_IDENTITY_UNFILLED,
} from "../src/discovery-identity-backfill.ts";

const connectionString = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL_MIGRATOR is required (a role that can perform DDL).");
}

const client = new pg.Client({ connectionString });
await client.connect();

async function step(label: string, sql: string): Promise<void> {
  const result = await client.query(sql);
  const count = Array.isArray(result) ? result.length : (result.rowCount ?? 0);
  console.log(`  ${label}${count ? ` (${count} row${count === 1 ? "" : "s"})` : ""}`);
}

try {
  await client.query("BEGIN");

  // Nothing to do if D8 never shipped here. Not an error: this script is part
  // of a documented deploy order and must be safe to run against a database at
  // any point in that order.
  const { rows } = await client.query(`select to_regclass('public.discovered_targets') as t`);
  if (rows[0]?.t === null) {
    console.log("discovered_targets does not exist yet — `push` will create it correctly. Nothing to do.");
    await client.query("COMMIT");
  } else {
    console.log("1. Add the three columns, nullable");
    // `if not exists` on every one: re-running must be a no-op, and a database
    // that already took 0017 through the pglite path must not error here.
    await step("add", DISCOVERY_IDENTITY_ADD_COLUMNS);

    // The derivation, and why each value is derived rather than assumed, is
    // documented on the statements themselves in
    // `src/discovery-identity-backfill.ts`. They live there so a test can run
    // them against a *seeded* table — the one thing neither the generated
    // migration nor the pglite harness proves, because both apply to an empty
    // database where the UPDATE matches nothing.
    console.log("2. Backfill from what the row already holds");
    await step("backfill", DISCOVERY_IDENTITY_BACKFILL);

    // Fail loudly rather than constrain a table the backfill could not cover.
    // The only way to reach this is a row whose `hostname` was NULL before
    // stage 0 — impossible, since the column was NOT NULL — or a row written
    // by something this script does not know about. Either way, guessing a
    // value here is exactly what the product refuses to do everywhere else.
    const { rows: unfilled } = await client.query(DISCOVERY_IDENTITY_UNFILLED);
    if (unfilled[0].n > 0) {
      throw new Error(
        `${unfilled[0].n} discovered_targets row(s) could not be backfilled — refusing to constrain. ` +
          `Inspect them by hand: this script only knows how to derive a certificate-transparency row.`,
      );
    }

    console.log("3. Constrain");
    await step("set not null", DISCOVERY_IDENTITY_CONSTRAIN);

    await client.query("COMMIT");
    console.log("\nDone. Next: `run push`, then `run apply-rls`.");
  }
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  await client.end();
}
