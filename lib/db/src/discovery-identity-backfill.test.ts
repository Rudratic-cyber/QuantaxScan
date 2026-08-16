import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  DISCOVERY_IDENTITY_ADD_COLUMNS,
  DISCOVERY_IDENTITY_BACKFILL,
  DISCOVERY_IDENTITY_CONSTRAIN,
  DISCOVERY_IDENTITY_UNFILLED,
} from "./discovery-identity-backfill";

/**
 * Discovery stage 0 — the `hostname` → `identity` widening, against a table
 * that **already has rows in it**.
 *
 * ## Why this file exists, when 0017 already contains the same logic
 *
 * Every other gate in this repository applies that migration to an *empty*
 * database. `createTestDb()` migrates up from nothing, so 0017's backfill
 * `UPDATE` matches zero rows and passes while asserting nothing at all. The e2e
 * stack does not even run the generated migration — it builds its schema with
 * `drizzle-kit push-force` (`tests/e2e/support/database.ts`), which is this
 * project's actual deploy mechanism per CLAUDE.md.
 *
 * So the one situation the widening has to survive — a populated
 * `discovered_targets` on a real deployment — was the one situation nothing
 * exercised. This file seeds the legacy shape by hand and runs the real
 * statements over it.
 *
 * The table is created here in D8's **pre-stage-0** shape rather than imported
 * from the schema files, deliberately: the schema now describes the *end*
 * state, so importing it would test the migration against its own destination
 * and prove nothing.
 */

const LEGACY_DISCOVERED_TARGETS = `
create table discovered_targets (
  id                  serial primary key,
  organization_id     integer not null,
  division_id         integer,
  project_id          integer not null,
  hostname            text not null,
  source_domain       text not null,
  discovery_method    text not null,
  evidence            jsonb not null,
  dns_resolution      text,
  resolved_addresses  jsonb,
  dns_checked_at      timestamptz,
  first_discovered_at timestamptz not null default now(),
  last_discovered_at  timestamptz not null default now()
);
`;

async function seededLegacyDb(): Promise<PGlite> {
  const db = new PGlite();
  // `exec`, not `query`: pglite rejects multi-statement SQL through `query`.
  await db.exec(LEGACY_DISCOVERED_TARGETS);
  await db.exec(`
    insert into discovered_targets
      (organization_id, project_id, hostname, source_domain, discovery_method, evidence, dns_resolution)
    values
      (1, 1, 'api.acme.test',     'acme.test', 'certificate_transparency', '{"issuer":"Test CA"}', 'resolved'),
      (1, 1, 'legacy.acme.test',  'acme.test', 'certificate_transparency', '{"issuer":"Test CA"}', null),
      (2, 7, 'portal.other.test', 'other.test','certificate_transparency', '{"issuer":"Other CA"}', 'not-resolved');
  `);
  return db;
}

async function runWidening(db: PGlite): Promise<void> {
  await db.exec(DISCOVERY_IDENTITY_ADD_COLUMNS);
  await db.exec(DISCOVERY_IDENTITY_BACKFILL);
  await db.exec(DISCOVERY_IDENTITY_CONSTRAIN);
}

describe("widening a populated discovered_targets (discovery stage 0)", () => {
  it("derives identity from the hostname it already held, for every row", async () => {
    const db = await seededLegacyDb();
    await runWidening(db);

    const { rows } = await db.query<{ hostname: string; identity: string }>(
      `select hostname, identity from discovered_targets order by id`,
    );

    expect(rows).toHaveLength(3);
    // The column is renamed in effect, not repurposed: no row acquires a name
    // it did not already have, and none loses one.
    for (const row of rows) expect(row.identity).toBe(row.hostname);
    expect(rows.map((r) => r.identity)).toEqual(["api.acme.test", "legacy.acme.test", "portal.other.test"]);

    await db.close();
  });

  it("reshapes source_domain into the discriminated scope, preserving the domain", async () => {
    const db = await seededLegacyDb();
    await runWidening(db);

    const { rows } = await db.query<{ source_scope: { kind: string; domain: string } }>(
      `select source_scope from discovered_targets order by id`,
    );

    expect(rows.map((r) => r.source_scope)).toEqual([
      { kind: "domain", domain: "acme.test" },
      { kind: "domain", domain: "acme.test" },
      { kind: "domain", domain: "other.test" },
    ]);

    await db.close();
  });

  it("marks every legacy row a hostname, because certificate transparency produced nothing else", async () => {
    const db = await seededLegacyDb();
    await runWidening(db);

    const { rows } = await db.query<{ target_kind: string }>(`select distinct target_kind from discovered_targets`);
    expect(rows).toEqual([{ target_kind: "hostname" }]);

    await db.close();
  });

  it("keeps hostname populated, so DNS corroboration stays attached to the name it describes", async () => {
    const db = await seededLegacyDb();
    await runWidening(db);

    // `hostname` becomes nullable here, and the temptation is to treat it as
    // superseded by `identity` and stop writing it. That would silently orphan
    // the three DNS columns, which are meaningful exactly where a target has a
    // DNS name — a NULL hostname beside `dns_resolution = 'resolved'` is a
    // contradiction no reader could resolve.
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from discovered_targets where hostname is null`,
    );
    expect(rows[0].n).toBe(0);

    await db.close();
  });

  it("leaves nothing for the constrain step to reject", async () => {
    const db = await seededLegacyDb();
    await db.exec(DISCOVERY_IDENTITY_ADD_COLUMNS);
    await db.exec(DISCOVERY_IDENTITY_BACKFILL);

    const { rows } = await db.query<{ n: number }>(DISCOVERY_IDENTITY_UNFILLED);
    expect(rows[0].n).toBe(0);

    await db.close();
  });

  it("is idempotent — a second run overwrites nothing", async () => {
    const db = await seededLegacyDb();
    await runWidening(db);

    // A deploy that is re-run, or a database somebody already widened by hand,
    // must not have its values rewritten. Simulates a later method's row by
    // setting a kind the backfill would otherwise have called `hostname`.
    await db.exec(`update discovered_targets set target_kind = 'cloud_resource' where id = 1`);
    await db.exec(DISCOVERY_IDENTITY_ADD_COLUMNS);
    await db.exec(DISCOVERY_IDENTITY_BACKFILL);

    const { rows } = await db.query<{ target_kind: string }>(
      `select target_kind from discovered_targets where id = 1`,
    );
    expect(rows[0].target_kind).toBe("cloud_resource");

    await db.close();
  });

  it("still runs after 0018 has dropped source_domain", async () => {
    const db = await seededLegacyDb();
    await runWidening(db);
    await db.exec(`alter table discovered_targets drop column source_domain`);

    // The guard in the backfill is what makes this survivable: a database that
    // has already been through the whole sequence must re-run the deploy step
    // harmlessly rather than error on a column that is legitimately gone.
    await expect(db.exec(DISCOVERY_IDENTITY_BACKFILL)).resolves.toBeDefined();

    await db.close();
  });
});
