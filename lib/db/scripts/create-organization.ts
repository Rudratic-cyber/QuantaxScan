/**
 * Creates a second (or third, or Nth) organisation.
 *
 * docs/Claude/13-auth-and-tenancy.md §5 and `apply-tenancy.ts` build one
 * organisation — id 1, the captain's, seeded once as part of the tenancy
 * migration. Everything downstream of that (RLS, `withOrg`, the cross-tenant
 * suite) already treats "more than one organisation" as the normal case; the
 * only thing that did not exist was a way to make a second one. This is that
 * way.
 *
 * Deliberately a script run against `DATABASE_URL_MIGRATOR`, not an HTTP
 * route: creating a tenant is a platform-operator action, and there is no
 * platform-admin principal to gate a route with yet — the only credential the
 * API server understands today is a key already bound to *an* organisation
 * (`artifacts/api-server/src/lib/principal.ts`), which is the wrong side of
 * this operation. `apply-tenancy` set the precedent: organisation creation is
 * an operator script until there is a principal authorised to do it over
 * HTTP.
 *
 * Usage:
 *   pnpm --filter @workspace/db run create-organization -- --name "Acme Inc" --slug acme
 *   ORG_NAME="Acme Inc" ORG_SLUG=acme pnpm --filter @workspace/db run create-organization
 *
 * Idempotent on slug: re-running with the same `--slug` prints the existing
 * organisation's id rather than erring or creating a duplicate, so a deploy
 * script can call this unconditionally.
 *
 * Prints the new organisation's id. The next step is binding an API key to
 * it — see `QUANTAXSCAN_API_KEY_ORG_IDS` in
 * artifacts/api-server/src/lib/principal.ts and .env.example.
 *
 * **Refuses to create the organisation while legacy platform-level `activity`
 * rows exist, and names the reason.** docs/Claude/13-auth-and-tenancy.md §10
 * ("One thing to do before a second organisation exists") names the exact
 * landmine: `activity` rows with `organization_id IS NULL` are readable by
 * *every* organisation under `activity_org_isolation`'s policy (deliberately
 * — it is the legacy global feed), and `apply-tenancy` leaves organisation
 * 1's entire pre-migration history in that state — real project names, e.g.
 * `Multi-file scan: 3 critical vulnerabilities found ... in "<projectName>"`.
 * That is inert while only one organisation exists and stops being inert the
 * moment a second one can query it. §10 is explicit that the fix is a
 * deliberate operator action ("to be run before the second tenant is
 * created, not a code change") — deleting an organisation's entire visible
 * history is not something this script does silently on the operator's
 * behalf, even in service of closing a real leak. It refuses instead, prints
 * the row count and the exact statement, and creates nothing. Pass
 * `--purge-legacy-activity` (or `PURGE_LEGACY_ACTIVITY=1`) once that
 * deletion has been consciously decided on — a captain's call per §12 of the
 * design doc, not this script's to make unasked.
 */
import pg from "pg";

const connectionString = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL_MIGRATOR is required (a role that can write to `organizations`).");
}

function argValue(flag: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const name = (argValue("--name") ?? process.env.ORG_NAME ?? "").trim();
const slug = (argValue("--slug") ?? process.env.ORG_SLUG ?? "").trim();
const purgeLegacyActivity =
  process.argv.slice(2).includes("--purge-legacy-activity") || process.env.PURGE_LEGACY_ACTIVITY === "1";

if (!name) {
  throw new Error("An organisation name is required: --name \"Acme Inc\" or ORG_NAME.");
}
if (!slug) {
  throw new Error("An organisation slug is required: --slug acme or ORG_SLUG.");
}
if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
  throw new Error(
    `--slug "${slug}" must be lower-case letters, digits and hyphens, and must not start or end with a ` +
      `hyphen — it matches organizations.slug's unique index and is meant to be a stable, readable handle.`,
  );
}

const client = new pg.Client({ connectionString });
await client.connect();

try {
  await client.query("BEGIN");

  // Checked before the insert, and only when this call would actually create
  // something new: an idempotent re-run against an existing slug (below)
  // opens no new leak window and must not be blocked by this. See the module
  // doc above for why this refuses rather than deleting on its own say-so.
  const wouldCreate = await client.query<{ exists: boolean }>(
    `select not exists(select 1 from organizations where slug = $1) as exists`,
    [slug],
  );
  if (wouldCreate.rows[0]?.exists) {
    const legacy = await client.query<{ n: string }>(
      `select count(*) as n from activity where organization_id is null`,
    );
    const legacyCount = Number(legacy.rows[0]?.n ?? "0");
    if (legacyCount > 0 && !purgeLegacyActivity) {
      throw new Error(
        `Refusing to create organisation "${name}" (slug "${slug}"): ${legacyCount} legacy platform-level ` +
          `activity row(s) still carry organization_id IS NULL. Once a second organisation exists, every ` +
          `organisation's GET /api/stats can read them — see docs/Claude/13-auth-and-tenancy.md §10. ` +
          `This is real, potentially sensitive history (past project names), so this script will not delete ` +
          `it unasked. Either run \`DELETE FROM activity WHERE organization_id IS NULL\` yourself first, or ` +
          `re-run this script with --purge-legacy-activity (or PURGE_LEGACY_ACTIVITY=1) once that deletion ` +
          `has been consciously decided on.`,
      );
    }
  }

  const inserted = await client.query<{ id: number; name: string; slug: string }>(
    `insert into organizations (name, slug, personal)
       values ($1, $2, false)
       on conflict (slug) do nothing
       returning id, name, slug`,
    [name, slug],
  );

  if (inserted.rows.length > 0) {
    const org = inserted.rows[0];
    console.log(`Created organisation ${org.id}: "${org.name}" (slug "${org.slug}").`);

    if (purgeLegacyActivity) {
      const purged = await client.query(`delete from activity where organization_id is null`);
      if ((purged.rowCount ?? 0) > 0) {
        console.log(
          `Purged ${purged.rowCount} legacy platform-level activity row(s) (organization_id IS NULL), as ` +
            `requested with --purge-legacy-activity — see docs/Claude/13-auth-and-tenancy.md §10.`,
        );
      }
    }

    console.log(
      `\nNext: bind an API key to it. In QUANTAXSCAN_API_KEYS / QUANTAXSCAN_API_KEY_ORG_IDS, add this ` +
        `key's organisation id at the same position as its key — see .env.example.`,
    );
  } else {
    const existing = await client.query<{ id: number; name: string; slug: string }>(
      `select id, name, slug from organizations where slug = $1`,
      [slug],
    );
    const org = existing.rows[0];
    console.log(
      `Organisation with slug "${slug}" already exists (id ${org.id}, name "${org.name}") — nothing created.`,
    );
    if (org.name !== name) {
      console.warn(
        `Note: the existing organisation's name ("${org.name}") differs from the one given here ` +
          `("${name}"). This script does not rename an existing organisation; that is a deliberate ` +
          `choice against something re-run unattended overwriting a name someone changed by hand.`,
      );
    }
  }

  await client.query("COMMIT");
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  await client.end();
}
