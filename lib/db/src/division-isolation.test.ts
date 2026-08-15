import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb } from "./test-support/test-db";
import { executeRows } from "./org-scope";

/**
 * RBAC stage 4 — division scoping, enforced by the database.
 *
 * **Read the negative control first.** The whole suite is worthless if the
 * harness is not genuinely subject to the policies, so the first test proves
 * that an *unrestricted* caller sees both divisions. If that ever fails to
 * fail — if scoping "works" because the harness sees nothing either way — every
 * assertion below would pass while proving nothing. This is the same discipline
 * `tenant-isolation.test.ts` opens with, and for the same reason.
 *
 * The property under test is the one the design chose the database for: a query
 * with **no `where` clause of any kind** returns only the divisions the caller
 * may see. Nothing here filters in TypeScript, exactly as no route does.
 */

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let scope: Awaited<ReturnType<typeof createTestDb>>["scope"];
let close: () => Promise<void>;
let seedAsSuperuser: Awaited<ReturnType<typeof createTestDb>>["seedAsSuperuser"];

const ORG = 1;
const ids = { payments: 0, retail: 0, paymentsProject: 0, retailProject: 0, sharedProject: 0 };

beforeAll(async () => {
  ({ db, scope, close, seedAsSuperuser } = await createTestDb({ asRole: "quantaxscan_app", organizations: [ORG] }));

  await seedAsSuperuser(async (client) => {
    const division = async (slug: string, name: string) =>
      (
        await client.query<{ id: number }>(
          `insert into divisions (organization_id, name, slug) values ($1, $2, $3) returning id`,
          [ORG, name, slug],
        )
      ).rows[0].id;

    ids.payments = await division("payments", "Payments");
    ids.retail = await division("retail", "Retail");

    const project = async (name: string, divisionId: number | null) =>
      (
        await client.query<{ id: number }>(
          `insert into projects (organization_id, division_id, name, language) values ($1, $2, $3, 'python') returning id`,
          [ORG, divisionId, name],
        )
      ).rows[0].id;

    ids.paymentsProject = await project("payments service", ids.payments);
    ids.retailProject = await project("retail service", ids.retail);
    // The row every tenant already has: created before divisions existed, so
    // it belongs to none. It must stay visible to everyone.
    ids.sharedProject = await project("shared platform", null);
  });
});

afterAll(async () => {
  await close();
});

/** Every project the caller can see, with no filter of any kind in the query. */
async function visibleProjects(divisionIds: number[]): Promise<string[]> {
  const rows = await scope.withOrg({ organizationId: ORG, userId: "u_test", divisionIds }, (tx) =>
    executeRows<{ name: string }>(tx, sql`select name from projects order by name`),
  );
  return rows.map((r) => r.name);
}

describe("the negative control", () => {
  it("an unrestricted caller sees every division, so a scoped one seeing less means something", async () => {
    // If this ever returns fewer than three, the assertions below stop being
    // evidence of scoping and become evidence of a broken fixture.
    expect(await visibleProjects([])).toEqual(["payments service", "retail service", "shared platform"]);
  });

  it("the harness is subject to row-level security at all", async () => {
    const rows = await executeRows<{ rolsuper: boolean; rolbypassrls: boolean }>(
      db,
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    // A superuser or a BYPASSRLS role would make every policy inert while the
    // code behaved identically — the trap 13-auth-and-tenancy.md §5.4 exists for.
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });
});

describe("a caller restricted to one division", () => {
  it("sees that division and the organisation-wide rows, and nothing else", async () => {
    const visible = await visibleProjects([ids.payments]);

    expect(visible).toContain("payments service");
    // Null division means organisation-wide, which is what every project that
    // predates divisions carries. Hiding those would break every existing
    // tenant on upgrade.
    expect(visible).toContain("shared platform");
    // The whole point.
    expect(visible).not.toContain("retail service");
  });

  it("cannot reach the other division by naming its id directly", async () => {
    // Addressing a row by id is indistinguishable from it not existing — the
    // same property the cross-tenant suite proves for organisations.
    const rows = await scope.withOrg({ organizationId: ORG, userId: "u_test", divisionIds: [ids.payments] }, (tx) =>
      executeRows<{ id: number }>(tx, sql`select id from projects where id = ${ids.retailProject}`),
    );
    expect(rows).toEqual([]);
  });

  it("sees both when granted both", async () => {
    const visible = await visibleProjects([ids.payments, ids.retail]);
    expect(visible).toEqual(["payments service", "retail service", "shared platform"]);
  });
});

describe("the encoding of unrestricted", () => {
  it("treats an empty division set as no restriction, not as no access", async () => {
    // This is the decision that keeps every pre-RBAC caller working: an
    // `OrgContext` with no `divisionIds` at all means exactly what it meant
    // before divisions existed.
    const rows = await scope.withOrg({ organizationId: ORG, userId: "u_test" }, (tx) =>
      executeRows<{ name: string }>(tx, sql`select name from projects order by name`),
    );
    expect(rows).toHaveLength(3);
  });

  it("still scopes by organisation — a division set does not widen the tenant", async () => {
    const rows = await scope.withOrg({ organizationId: 999, userId: "u_test", divisionIds: [] }, (tx) =>
      executeRows<{ name: string }>(tx, sql`select name from projects`),
    );
    // Unrestricted *within* a tenant is not unrestricted across tenants.
    expect(rows).toEqual([]);
  });
});

describe("writing", () => {
  it("lets an unrestricted caller create a project inside a division", async () => {
    const inserted = await scope.withOrg({ organizationId: ORG, userId: "u_test", divisionIds: [] }, (tx) =>
      executeRows<{ id: number }>(
        tx,
        sql`insert into projects (organization_id, division_id, name, language)
            values (${ORG}, ${ids.retail}, 'created by an admin', 'python') returning id`,
      ),
    );
    expect(inserted).toHaveLength(1);
  });

  it("lets a division-scoped caller write into their own division", async () => {
    const inserted = await scope.withOrg(
      { organizationId: ORG, userId: "u_test", divisionIds: [ids.payments] },
      (tx) =>
        executeRows<{ id: number }>(
          tx,
          sql`insert into projects (organization_id, division_id, name, language)
              values (${ORG}, ${ids.payments}, 'created in payments', 'python') returning id`,
        ),
    );
    // The WITH CHECK carries the tenant clause only, deliberately: a write
    // lands in the division its parent names and the caller does not choose
    // it, so constraining the write side on the caller's grants would refuse
    // legitimate writes while adding nothing — the read side is what confines.
    expect(inserted).toHaveLength(1);
  });

  it("still refuses a write into another organisation", async () => {
    await expect(
      scope.withOrg({ organizationId: ORG, userId: "u_test", divisionIds: [ids.payments] }, (tx) =>
        tx.execute(
          sql`insert into projects (organization_id, division_id, name, language)
              values (999, null, 'another tenant', 'python')`,
        ),
      ),
    ).rejects.toThrow();
  });
});

describe("the denormalised columns, which are what make the child tables scope at all", () => {
  it("hides an asset belonging to another division, with no filter in the query", async () => {
    // `assets` has no `project_id`: it reaches a project through the
    // `project:<id>:` prefix in `location`, which a policy cannot follow
    // cheaply. So the division is stamped at ingest and filtered on here. If
    // that denormalisation were ever dropped, this test is what notices —
    // and the failure it prevents is a viewer scoped to one division reading
    // the whole estate's inventory while the page says otherwise.
    await seedAsSuperuser(async (client) => {
      const asset = async (divisionId: number | null, fingerprint: string, location: string) =>
        client.query(
          `insert into assets (organization_id, division_id, fingerprint, surface, algorithm, location, status, first_seen, last_seen)
           values ($1, $2, $3, 'source', 'RSA', $4, 'active', now(), now())`,
          [ORG, divisionId, fingerprint, location],
        );
      await asset(ids.payments, "fp-payments", `project:${ids.paymentsProject}:a.py`);
      await asset(ids.retail, "fp-retail", `project:${ids.retailProject}:b.py`);
      await asset(null, "fp-shared", `project:${ids.sharedProject}:c.py`);
    });

    const seen = await scope.withOrg({ organizationId: ORG, userId: "u_test", divisionIds: [ids.payments] }, (tx) =>
      executeRows<{ fingerprint: string }>(tx, sql`select fingerprint from assets order by fingerprint`),
    );

    expect(seen.map((r) => r.fingerprint)).toEqual(["fp-payments", "fp-shared"]);
  });

  it("hides another division's collection runs, so the coverage meter cannot count them", async () => {
    await seedAsSuperuser(async (client) => {
      const run = async (divisionId: number | null, target: string) =>
        client.query(
          `insert into collection_runs (organization_id, division_id, collector, collector_version, surface, status, target, observation_count, completed_at)
           values ($1, $2, 'source-regex', '1.0.0', 'source', 'completed', $3, 1, now())`,
          [ORG, divisionId, target],
        );
      await run(ids.payments, `project:${ids.paymentsProject}`);
      await run(ids.retail, `project:${ids.retailProject}`);
    });

    const seen = await scope.withOrg({ organizationId: ORG, userId: "u_test", divisionIds: [ids.payments] }, (tx) =>
      executeRows<{ target: string }>(tx, sql`select target from collection_runs order by target`),
    );

    // Coverage is a denominator a customer is shown. Counting another
    // division's runs would overstate how much of *their* estate was examined.
    expect(seen.every((r) => !r.target.includes(String(ids.retailProject)))).toBe(true);
    expect(seen.some((r) => r.target.includes(String(ids.paymentsProject)))).toBe(true);
  });
});
