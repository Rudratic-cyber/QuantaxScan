import { describe, expect, it, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "./test-support/test-db";
import { executeRows } from "./org-scope";
import { projectsTable } from "./schema/projects";
import { activityTable } from "./schema/activity";
import { sharedReportsTable } from "./schema/shared_reports";
import {
  ORG_SCOPED_TABLES,
  RUNTIME_DB_ROLE,
  assertTenantIsolationInstalled,
  inspectTenantIsolation,
} from "./tenant-isolation";

let harness: TestDb | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/**
 * Assert a query was rejected for a specific reason.
 *
 * Not `expect(...).rejects.toThrow(/…/)`: drizzle wraps driver errors in a
 * `Failed query: …` error and puts the real one on `cause`, so a naive match
 * tests the wrapper's text and would pass for *any* failure. That matters here
 * — these assertions are the difference between "the row-level security policy
 * rejected this" and "the query had a typo".
 */
async function expectRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }

  expect(thrown, "expected the query to be rejected, but it succeeded").toBeDefined();

  const messages: string[] = [];
  for (let err = thrown; err instanceof Error; err = err.cause) {
    messages.push(err.message);
  }
  expect(messages.join("\n")).toMatch(pattern);
}

/**
 * Two organisations, one project each, plus a legacy platform-level activity
 * row with no organisation. Seeded as the superuser because writing two
 * tenants' rows is by construction something no correctly-scoped connection
 * may do.
 */
async function seedTwoOrgs(h: TestDb): Promise<void> {
  await h.seedAsSuperuser(async (client) => {
    await client.exec(`
      insert into projects (id, organization_id, name, language)
        values (1, 1, 'org one alpha', 'python'),
               (2, 1, 'org one beta',  'python'),
               (3, 2, 'org two gamma', 'python');
      select setval('projects_id_seq', 3);
      insert into activity (organization_id, description, severity)
        values (null, 'legacy platform event', 'info'),
               (1,    'org one event',        'info'),
               (2,    'org two event',        'info');
    `);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// §9.1 THE NEGATIVE CONTROL. Read this first.
// ───────────────────────────────────────────────────────────────────────────

describe("the test harness is actually subject to RLS", () => {
  it("the harness role is genuinely subject to RLS — without this, every isolation test below is vacuous", async () => {
    harness = await createTestDb({ asRole: RUNTIME_DB_ROLE });

    const [role] = await executeRows<{ rolsuper: boolean; rolbypassrls: boolean }>(
      harness.db,
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );

    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);

    await seedTwoOrgs(harness);

    // No GUC set at all. If this returns rows, RLS is not in force and every
    // other test in this file is meaningless.
    const rows = await harness.db.select().from(projectsTable);
    expect(rows).toHaveLength(0);
  });

  it("proves the control can fail: the DEFAULT harness role bypasses RLS entirely and sees every tenant", async () => {
    // The same fixtures, the same policies, the same FORCE ROW LEVEL
    // SECURITY — the only difference is that no `SET ROLE` was issued, so the
    // connection is still `postgres` (rolsuper, rolbypassrls). This is the
    // configuration a cross-tenant test gets by accident, and it is why the
    // control above has to exist.
    harness = await createTestDb();

    const [role] = await executeRows<{ rolsuper: boolean; rolbypassrls: boolean }>(
      harness.db,
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(role.rolbypassrls).toBe(true);

    await seedTwoOrgs(harness);

    const rows = await harness.db.select().from(projectsTable);
    expect(rows).toHaveLength(3); // all three, across both organisations, with no GUC
  });
});

// ───────────────────────────────────────────────────────────────────────────
// §9.2 Migration integrity — the test that catches `drizzle-kit push`
// ───────────────────────────────────────────────────────────────────────────

describe("tenant isolation is installed, not merely declared", () => {
  it.each(ORG_SCOPED_TABLES)(
    "%s has RLS enabled, FORCEd, and a policy with a real USING clause",
    async (table) => {
      harness = await createTestDb();
      const state = (await inspectTenantIsolation(harness.db)).find((s) => s.table === table);

      expect(state?.exists).toBe(true);
      expect(state?.rlsEnabled).toBe(true);
      expect(state?.rlsForced).toBe(true);
      expect(state?.effectivePolicies.length).toBeGreaterThan(0);
      // A NULL polqual is a policy that permits every row. This is exactly
      // what `drizzle-kit push` produces — see 13-auth-and-tenancy.md §5.4.
      expect(state?.permitAllPolicies).toEqual([]);
    },
  );

  it("assertTenantIsolationInstalled passes against a correctly migrated database", async () => {
    harness = await createTestDb();
    await expect(assertTenantIsolationInstalled(harness.db)).resolves.toBeUndefined();
  });

  it("assertTenantIsolationInstalled refuses a policy with a NULL USING clause — the drizzle-kit push failure mode", async () => {
    harness = await createTestDb();
    // Reproduce what `push` installs: same name, same role, no expression.
    await harness.client.exec(`
      DROP POLICY projects_org_isolation ON projects;
      CREATE POLICY projects_org_isolation ON projects AS PERMISSIVE FOR ALL TO ${RUNTIME_DB_ROLE};
    `);

    await expect(assertTenantIsolationInstalled(harness.db)).rejects.toThrow(/NULL USING expression/);
  });

  it("assertTenantIsolationInstalled refuses a table whose RLS is enabled but not FORCEd", async () => {
    harness = await createTestDb();
    await harness.client.exec(`ALTER TABLE scans NO FORCE ROW LEVEL SECURITY`);

    await expect(assertTenantIsolationInstalled(harness.db)).rejects.toThrow(/not FORCEd/);
  });

  it("the runtime role has no blanket grant — a table it was not named on is unreachable regardless of policy", async () => {
    harness = await createTestDb({ asRole: RUNTIME_DB_ROLE });

    // The GRANT list is a second, independent layer to RLS: a table nobody
    // named is denied outright. This is what keeps `conversations`/`messages`
    // — dead tables, since routes/chat.ts persists nothing — out of reach, and
    // it is why the grants are enumerated rather than written as
    // `GRANT ... ON ALL TABLES`.
    await harness.seedAsSuperuser(async (client) => {
      await client.exec(`CREATE TABLE not_granted (id serial primary key)`);
    });

    await expectRejection(harness.db.execute(sql`select 1 from not_granted`), /permission denied/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The mechanism itself
// ───────────────────────────────────────────────────────────────────────────

describe("withOrg is the choke point", () => {
  it("a query with NO where clause at all returns only the scoped organisation's rows", async () => {
    harness = await createTestDb({ asRole: RUNTIME_DB_ROLE });
    await seedTwoOrgs(harness);
    const { withOrg } = harness.scope;

    // This is the direct proof of 08-security.md's requirement that isolation
    // "cannot be bypassed by forgetting a `where` clause": there is no
    // `where` here, deliberately.
    const asOrgOne = await withOrg({ organizationId: 1, userId: "" }, (tx) =>
      tx.select().from(projectsTable),
    );
    expect(asOrgOne.map((p) => p.name).sort()).toEqual(["org one alpha", "org one beta"]);

    const asOrgTwo = await withOrg({ organizationId: 2, userId: "" }, (tx) =>
      tx.select().from(projectsTable),
    );
    expect(asOrgTwo.map((p) => p.name)).toEqual(["org two gamma"]);
  });

  it("addressing another organisation's row by primary key returns nothing, rather than that row", async () => {
    harness = await createTestDb({ asRole: RUNTIME_DB_ROLE });
    await seedTwoOrgs(harness);

    const found = await harness.scope.withOrg({ organizationId: 2, userId: "" }, (tx) =>
      executeRows<{ id: number }>(tx, sql`select id from projects where id = 1`),
    );
    expect(found).toHaveLength(0);
  });

  it("cross-tenant UPDATE and DELETE affect nothing and leave the other tenant's row intact", async () => {
    harness = await createTestDb({ asRole: RUNTIME_DB_ROLE });
    await seedTwoOrgs(harness);
    const { withOrg } = harness.scope;

    await withOrg({ organizationId: 2, userId: "" }, async (tx) => {
      await tx.execute(sql`update projects set name = 'hijacked' where id = 1`);
      await tx.execute(sql`delete from projects where id = 2`);
    });

    const survivors = await withOrg({ organizationId: 1, userId: "" }, (tx) =>
      tx.select().from(projectsTable),
    );
    expect(survivors.map((p) => p.name).sort()).toEqual(["org one alpha", "org one beta"]);
  });

  it("inserting into another organisation is rejected by the policy's WITH CHECK, not merely discouraged", async () => {
    harness = await createTestDb({ asRole: RUNTIME_DB_ROLE });
    await seedTwoOrgs(harness);

    await expectRejection(
      harness.scope.withOrg({ organizationId: 1, userId: "" }, (tx) =>
        tx.insert(projectsTable).values({ organizationId: 2, name: "smuggled", language: "python" }),
      ),
      /row-level security policy/,
    );
  });

  it("an unscoped connection sees nothing rather than erroring, both before any scope and after one has committed", async () => {
    harness = await createTestDb({ asRole: RUNTIME_DB_ROLE });
    await seedTwoOrgs(harness);

    // Before: the GUC has never been set — current_setting returns NULL.
    expect(await harness.db.select().from(projectsTable)).toHaveLength(0);

    await harness.scope.withOrg({ organizationId: 1, userId: "" }, (tx) =>
      tx.select().from(projectsTable),
    );

    // After: the GUC now reads as the EMPTY STRING, not NULL. Without the
    // `nullif(..., '')` in every policy this would raise
    // `invalid input syntax for type integer: ""` — a 500 instead of an empty
    // result. Fail closed, not fail loud.
    expect(await harness.db.select().from(projectsTable)).toHaveLength(0);
  });
});

describe("withOrg refuses to nest", () => {
  it("throws rather than silently re-scoping its parent", async () => {
    harness = await createTestDb({ asRole: RUNTIME_DB_ROLE });
    await seedTwoOrgs(harness);
    const { withOrg } = harness.scope;

    await expect(
      withOrg({ organizationId: 1, userId: "" }, async () => {
        // A shared helper that opens its own scope makes this trivially
        // reachable, which is why it is a thrown error and not a convention.
        return withOrg({ organizationId: 2, userId: "" }, async (inner) =>
          inner.select().from(projectsTable),
        );
      }),
    ).rejects.toThrow(/cannot nest/);
  });

  it("the outer scope's visible rows are unchanged after a refused nested scope", async () => {
    harness = await createTestDb({ asRole: RUNTIME_DB_ROLE });
    await seedTwoOrgs(harness);
    const { withOrg } = harness.scope;

    const seen = await withOrg({ organizationId: 1, userId: "" }, async (tx) => {
      await expect(
        withOrg({ organizationId: 2, userId: "" }, async (inner) => inner.select().from(projectsTable)),
      ).rejects.toThrow(/cannot nest/);
      return tx.select().from(projectsTable);
    });

    // Had the nested scope been allowed to succeed and release its savepoint,
    // this would be org 2's row. Verified: that is exactly what happens
    // without the guard.
    expect(seen.map((p) => p.name).sort()).toEqual(["org one alpha", "org one beta"]);
  });

  it("withoutOrgScope and withPublicShare refuse to nest for the same reason", async () => {
    harness = await createTestDb({ asRole: RUNTIME_DB_ROLE });
    const { withOrg, withoutOrgScope, withPublicShare } = harness.scope;

    await expect(
      withOrg({ organizationId: 1, userId: "" }, () => withoutOrgScope("test", async () => 1)),
    ).rejects.toThrow(/cannot nest/);

    await expect(
      withOrg({ organizationId: 1, userId: "" }, () => withPublicShare(async () => 1)),
    ).rejects.toThrow(/cannot nest/);
  });

  it("sequential scopes on the same connection are fine — only nesting is refused", async () => {
    harness = await createTestDb({ asRole: RUNTIME_DB_ROLE });
    await seedTwoOrgs(harness);
    const { withOrg } = harness.scope;

    for (const organizationId of [1, 2, 1, 2]) {
      const rows = await withOrg({ organizationId, userId: "" }, (tx) => tx.select().from(projectsTable));
      expect(rows.every((r) => r.organizationId === organizationId)).toBe(true);
    }
  });
});

describe("the shapes that are deliberately not the standard one", () => {
  it("activity: NULL-org rows are readable by every organisation, deletable, but never updatable", async () => {
    harness = await createTestDb({ asRole: RUNTIME_DB_ROLE });
    await seedTwoOrgs(harness);
    const { withOrg } = harness.scope;

    const asOne = await withOrg({ organizationId: 1, userId: "" }, (tx) => tx.select().from(activityTable));
    expect(asOne.map((a) => a.description).sort()).toEqual(["legacy platform event", "org one event"]);

    const asTwo = await withOrg({ organizationId: 2, userId: "" }, (tx) => tx.select().from(activityTable));
    expect(asTwo.map((a) => a.description).sort()).toEqual(["legacy platform event", "org two event"]);

    // Not updatable: UPDATE evaluates WITH CHECK against the new row, whose
    // organization_id is still NULL. This asymmetry is deliberate — see the
    // comment on activity_org_isolation before "fixing" it.
    await expectRejection(
      withOrg({ organizationId: 1, userId: "" }, (tx) =>
        tx.execute(sql`update activity set description = 'rewritten' where organization_id is null`),
      ),
      /row-level security policy/,
    );

    // Deletable, so the legacy feed can be pruned.
    const deleted = await withOrg({ organizationId: 1, userId: "" }, (tx) =>
      executeRows<{ id: number }>(tx, sql`delete from activity where organization_id is null returning id`),
    );
    expect(deleted).toHaveLength(1);
  });

  it("shared_reports: a public, unexpired, unrevoked report is readable with no organisation scope at all", async () => {
    harness = await createTestDb({ asRole: RUNTIME_DB_ROLE });
    await harness.seedAsSuperuser(async (client) => {
      await client.exec(`
        insert into shared_reports (id, organization_id, owner, repo, repo_url, data, visibility, expires_at)
          values ('public-live',    1, 'acme', 'r', 'https://x', '{}'::jsonb, 'public',  now() + interval '7 days'),
                 ('public-expired', 1, 'acme', 'r', 'https://x', '{}'::jsonb, 'public',  now() - interval '1 day'),
                 ('public-revoked', 1, 'acme', 'r', 'https://x', '{}'::jsonb, 'public',  now() + interval '7 days'),
                 ('private-one',    1, 'acme', 'r', 'https://x', '{}'::jsonb, 'private', now() + interval '7 days');
        update shared_reports set revoked_at = now() where id = 'public-revoked';
      `);
    });

    const anonymous = await harness.scope.withPublicShare((tx) => tx.select().from(sharedReportsTable));
    expect(anonymous.map((r) => r.id)).toEqual(["public-live"]);

    // The owning organisation still sees all four, public or not.
    const owner = await harness.scope.withOrg({ organizationId: 1, userId: "" }, (tx) =>
      tx.select().from(sharedReportsTable),
    );
    expect(owner).toHaveLength(4);

    // A different organisation sees only what the public branch admits.
    const other = await harness.scope.withOrg({ organizationId: 2, userId: "" }, (tx) =>
      tx.select().from(sharedReportsTable),
    );
    expect(other.map((r) => r.id)).toEqual(["public-live"]);
  });

  it("organization_members: a user sees their own memberships before any organisation is selected", async () => {
    harness = await createTestDb({ asRole: RUNTIME_DB_ROLE });
    await harness.seedAsSuperuser(async (client) => {
      await client.exec(`
        insert into users (id, email) values ('user-a', 'a@example.com'), ('user-b', 'b@example.com');
        insert into organization_members (organization_id, user_id, role)
          values (1, 'user-a', 'owner'), (2, 'user-b', 'owner');
      `);
    });

    // The login bootstrap: an organisation id is not yet known, so the scope
    // is opened at a placeholder the user is not a member of. The `user_id`
    // branch is what makes their own membership visible anyway.
    const mine = await harness.scope.withOrg({ organizationId: -1, userId: "user-a" }, (tx) =>
      executeRows(tx, sql`select organization_id from organization_members`),
    );
    expect(mine).toEqual([{ organization_id: 1 }]);

    // And the organisations that membership grants — via a subquery evaluated
    // under organization_members' own policy, with no recursion.
    const orgs = await harness.scope.withOrg({ organizationId: -1, userId: "user-a" }, (tx) =>
      executeRows(tx, sql`select id from organizations order by id`),
    );
    expect(orgs).toEqual([{ id: 1 }]);
  });

  it("organization_members: one user's membership row is invisible to another user in another organisation", async () => {
    harness = await createTestDb({ asRole: RUNTIME_DB_ROLE });
    await harness.seedAsSuperuser(async (client) => {
      await client.exec(`
        insert into users (id, email) values ('user-a', 'a@example.com'), ('user-b', 'b@example.com');
        insert into organization_members (organization_id, user_id, role)
          values (1, 'user-a', 'owner'), (2, 'user-b', 'owner');
      `);
    });

    // This is the containment on user enumeration: `users` is not RLS-scoped,
    // but the only path to another person is through this table.
    const seen = await harness.scope.withOrg({ organizationId: 2, userId: "user-b" }, (tx) =>
      executeRows(tx, sql`select user_id from organization_members`),
    );
    expect(seen).toEqual([{ user_id: "user-b" }]);
  });
});
