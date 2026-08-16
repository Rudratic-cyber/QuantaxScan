import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb } from "./test-support/test-db";
import { executeRows } from "./org-scope";
import { activeWaiver, resolveWaiverStatus, waiverAttribution } from "./waivers";

/**
 * C8 — the waivers register.
 *
 * Two halves, and they are separate on purpose. The first is pure arithmetic
 * about time and needs no database. The second is the part a reviewer cannot
 * check by reading: that the row is genuinely isolated by tenant *and* by
 * division, and that the `CHECK` constraint really runs — which, per CLAUDE.md,
 * only actually applying the generated SQL can prove.
 */

const NOW = new Date("2026-08-15T12:00:00.000Z");

describe("resolveWaiverStatus", () => {
  it("is active while its expiry is in the future", () => {
    expect(resolveWaiverStatus({ expiresAt: new Date("2026-09-01T00:00:00Z"), revokedAt: null }, NOW)).toBe("active");
  });

  it("is expired once its expiry has passed — this is the constraint C8 exists to hold", () => {
    expect(resolveWaiverStatus({ expiresAt: new Date("2026-08-01T00:00:00Z"), revokedAt: null }, NOW)).toBe("expired");
  });

  it("expires exactly at its expiry, not one moment after", () => {
    // The boundary has to fall one way. It falls towards not suppressing.
    expect(resolveWaiverStatus({ expiresAt: NOW, revokedAt: null }, NOW)).toBe("expired");
  });

  it("reads a string timestamp the same as a Date — drivers return either", () => {
    expect(resolveWaiverStatus({ expiresAt: "2026-09-01T00:00:00.000Z", revokedAt: null }, NOW)).toBe("active");
  });

  it("reports revoked ahead of expired, so the register says why it stopped applying", () => {
    const status = resolveWaiverStatus(
      { expiresAt: new Date("2026-08-01T00:00:00Z"), revokedAt: new Date("2026-07-01T00:00:00Z") },
      NOW,
    );
    expect(status).toBe("revoked");
  });
});

describe("activeWaiver", () => {
  const expired = { id: 1, expiresAt: new Date("2026-08-01T00:00:00Z"), revokedAt: null };
  const revoked = { id: 2, expiresAt: new Date("2027-01-01T00:00:00Z"), revokedAt: new Date("2026-07-01T00:00:00Z") };
  const shortActive = { id: 3, expiresAt: new Date("2026-08-20T00:00:00Z"), revokedAt: null };
  const longActive = { id: 4, expiresAt: new Date("2026-12-01T00:00:00Z"), revokedAt: null };

  it("is null when an asset has only expired and revoked waivers — the same answer as having none", () => {
    expect(activeWaiver([expired, revoked], NOW)).toBeNull();
  });

  it("is null for an asset with no waivers at all", () => {
    expect(activeWaiver([], NOW)).toBeNull();
  });

  it("picks the active waiver that runs longest, so an about-to-lapse one cannot hide a fresh one", () => {
    expect(activeWaiver([shortActive, longActive, expired, revoked], NOW)?.id).toBe(4);
  });

  it("ignores a revoked waiver even when its expiry is furthest away", () => {
    expect(activeWaiver([shortActive, revoked], NOW)?.id).toBe(3);
  });
});

describe("waiverAttribution", () => {
  it("is authenticated when a person wrote the row", () => {
    expect(waiverAttribution("u_alice")).toBe("authenticated");
  });

  it("is asserted for the API-key principal, which names nobody", () => {
    // Both encodings of "no person": NULL in the column, "" in an OrgContext.
    expect(waiverAttribution(null)).toBe("asserted");
    expect(waiverAttribution("")).toBe("asserted");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The database half. `asRole: "quantaxscan_app"` is not optional — without it
// PGlite connects as `postgres`, which is rolbypassrls, and every isolation
// assertion below would pass while proving nothing. See CLAUDE.md.
// ───────────────────────────────────────────────────────────────────────────

describe("waivers are isolated by tenant and by division", () => {
  let scope: Awaited<ReturnType<typeof createTestDb>>["scope"];
  let close: () => Promise<void>;

  const ORG_ONE = 1;
  const ORG_TWO = 2;
  const ids = { payments: 0, retail: 0, paymentsAsset: 0, retailAsset: 0, sharedAsset: 0, otherOrgAsset: 0 };

  beforeAll(async () => {
    const harness = await createTestDb({ asRole: "quantaxscan_app", organizations: [ORG_ONE, ORG_TWO] });
    scope = harness.scope;
    close = harness.close;

    await harness.seedAsSuperuser(async (client) => {
      const division = async (slug: string) =>
        (
          await client.query<{ id: number }>(
            `insert into divisions (organization_id, name, slug) values ($1, $2, $2) returning id`,
            [ORG_ONE, slug],
          )
        ).rows[0].id;

      ids.payments = await division("payments");
      ids.retail = await division("retail");

      const asset = async (org: number, divisionId: number | null, fingerprint: string) =>
        (
          await client.query<{ id: number }>(
            `insert into assets (organization_id, division_id, fingerprint, surface, algorithm, location, status)
             values ($1, $2, $3, 'source', 'RSA-2048', $3, 'active') returning id`,
            [org, divisionId, fingerprint],
          )
        ).rows[0].id;

      ids.paymentsAsset = await asset(ORG_ONE, ids.payments, "fp-payments");
      ids.retailAsset = await asset(ORG_ONE, ids.retail, "fp-retail");
      ids.sharedAsset = await asset(ORG_ONE, null, "fp-shared");
      ids.otherOrgAsset = await asset(ORG_TWO, null, "fp-other-org");

      const waiver = async (org: number, divisionId: number | null, assetId: number, justification: string) => {
        await client.query(
          `insert into waivers (organization_id, division_id, asset_id, justification, signed_off_by, expires_at)
           values ($1, $2, $3, $4, 'A Person', now() + interval '90 days')`,
          [org, divisionId, assetId, justification],
        );
      };

      await waiver(ORG_ONE, ids.payments, ids.paymentsAsset, "payments waiver");
      await waiver(ORG_ONE, ids.retail, ids.retailAsset, "retail waiver");
      await waiver(ORG_ONE, null, ids.sharedAsset, "shared waiver");
      await waiver(ORG_TWO, null, ids.otherOrgAsset, "other org waiver");
    });
  });

  afterAll(async () => {
    await close();
  });

  /** Every waiver the caller can see, with no `where` clause of any kind. */
  async function visible(organizationId: number, divisionIds: number[]): Promise<string[]> {
    const rows = await scope.withOrg({ organizationId, userId: "u_test", divisionIds }, (tx) =>
      executeRows<{ justification: string }>(tx, sql`select justification from waivers order by justification`),
    );
    return rows.map((r) => r.justification);
  }

  it("the negative control: an unrestricted caller in org one sees all three of its waivers", async () => {
    // If this ever stops seeing everything, the restriction assertions below
    // would pass because the caller sees nothing rather than because scoping works.
    expect(await visible(ORG_ONE, [])).toEqual(["payments waiver", "retail waiver", "shared waiver"]);
  });

  it("never returns another organisation's waiver", async () => {
    expect(await visible(ORG_ONE, [])).not.toContain("other org waiver");
    expect(await visible(ORG_TWO, [])).toEqual(["other org waiver"]);
  });

  it("confines a division-restricted caller to their division plus the division-less rows", async () => {
    expect(await visible(ORG_ONE, [ids.payments])).toEqual(["payments waiver", "shared waiver"]);
    expect(await visible(ORG_ONE, [ids.retail])).toEqual(["retail waiver", "shared waiver"]);
  });

  it("refuses a write stamped with another organisation", async () => {
    let thrown: unknown;
    try {
      await scope.withOrg({ organizationId: ORG_ONE, userId: "u_test" }, (tx) =>
        tx.execute(sql`insert into waivers (organization_id, asset_id, justification, signed_off_by, expires_at)
                       values (${ORG_TWO}, ${ids.otherOrgAsset}, 'smuggled', 'A Person', now() + interval '1 day')`),
      );
    } catch (err) {
      thrown = err;
    }
    const messages: string[] = [];
    for (let err = thrown; err instanceof Error; err = err.cause) messages.push(err.message);
    expect(messages.join("\n")).toMatch(/row-level security/i);
  });

  it("refuses a waiver that expires before it was signed — the CHECK is real SQL, not a TypeScript intention", async () => {
    let thrown: unknown;
    try {
      await scope.withOrg({ organizationId: ORG_ONE, userId: "u_test" }, (tx) =>
        tx.execute(sql`insert into waivers (organization_id, asset_id, justification, signed_off_by, expires_at)
                       values (${ORG_ONE}, ${ids.sharedAsset}, 'already over', 'A Person', now() - interval '1 day')`),
      );
    } catch (err) {
      thrown = err;
    }
    const messages: string[] = [];
    for (let err = thrown; err instanceof Error; err = err.cause) messages.push(err.message);
    expect(messages.join("\n")).toMatch(/waivers_expiry_after_signoff_check/);
  });
});
