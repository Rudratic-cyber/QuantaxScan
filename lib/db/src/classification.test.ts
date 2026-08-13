import { describe, expect, it, afterEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  DATA_CLASSIFICATION_PRESETS,
  DATA_CLASSIFICATION_VALUES,
  DEFAULT_DATA_CLASSIFICATION,
  DEFAULT_SECRECY_LIFETIME_YEARS,
  SECRECY_LIFETIME_YEARS_BY_CLASSIFICATION,
  isDataClassification,
  resolveSecrecyLifetime,
} from "./classification";
import { createTestDb } from "./test-support/test-db";
import { assetsTable } from "./schema/assets";
import { projectsTable } from "./schema/projects";
import { executeRows } from "./org-scope";

/**
 * A3 — data classification. docs/Claude/03-features.md §A3.
 *
 * Two halves, and both are needed:
 *
 *   * the pure resolver, which is the contract A4 consumes, and
 *   * the schema, exercised against a real (embedded) Postgres through the
 *     generated migration in `lib/db/drizzle/`. Without the second half a
 *     resolver-only suite would go green while the columns and CHECKs never
 *     landed in any database at all.
 *
 * PGlite boot exceeds vitest's 5s default, so the DB-backed cases carry an
 * explicit per-test timeout rather than relying on a `--testTimeout` flag the
 * CI command does not pass.
 */
const DB_TIMEOUT = 60_000;

describe("A3 presets match the spec table verbatim", () => {
  it("has the five presets from docs/Claude/03-features.md §A3, with the spec's X values", () => {
    expect(DATA_CLASSIFICATION_PRESETS.map((p) => [p.label, p.years])).toEqual([
      ["Public", 0],
      ["Internal", 3],
      ["Confidential", 7],
      ["Regulated", 25],
      ["Indefinite", 50],
    ]);
  });

  it("the preset list and the enum tuple cannot drift apart", () => {
    expect(DATA_CLASSIFICATION_PRESETS.map((p) => p.value)).toEqual([...DATA_CLASSIFICATION_VALUES]);
    expect(Object.keys(SECRECY_LIFETIME_YEARS_BY_CLASSIFICATION).sort()).toEqual([...DATA_CLASSIFICATION_VALUES].sort());
  });

  it("isDataClassification rejects anything outside the tuple", () => {
    expect(isDataClassification("regulated")).toBe(true);
    expect(isDataClassification("Regulated")).toBe(false);
    expect(isDataClassification("top-secret")).toBe(false);
    expect(isDataClassification(null)).toBe(false);
  });
});

describe("resolveSecrecyLifetime — every asset gets an X, and it says where the X came from", () => {
  it("nothing configured anywhere: falls back to the product default and marks it assumed", () => {
    const x = resolveSecrecyLifetime({});

    // A3 acceptance, first clause: "every asset has an X value".
    expect(x.years).toBe(DEFAULT_SECRECY_LIFETIME_YEARS);
    expect(x.classification).toBe(DEFAULT_DATA_CLASSIFICATION);
    expect(x.source).toBe("default");
    // A3 acceptance, third clause: the default is marked as an assumption *in
    // the data*, so a report can state it was assumed rather than supplied.
    expect(x.assumed).toBe(true);
    expect(x.basis).toContain("Assumed, not supplied");
  });

  it("explicit nulls are the same as absent — a row read straight out of the database resolves identically", () => {
    expect(
      resolveSecrecyLifetime({
        assetClassification: null,
        assetSecrecyLifetimeYears: null,
        projectClassification: null,
        projectSecrecyLifetimeYears: null,
      }),
    ).toEqual(resolveSecrecyLifetime({}));
  });

  it("project default only: inherited, and still an assumption about this asset", () => {
    const x = resolveSecrecyLifetime({ projectClassification: "regulated" });

    expect(x.years).toBe(25);
    expect(x.classification).toBe("regulated");
    expect(x.source).toBe("project");
    expect(x.classificationSource).toBe("project");
    // A human chose "Regulated" — but not for this asset, so a report may not
    // present it as supplied. This is the line the `assumed` flag draws.
    expect(x.assumed).toBe(true);
    expect(x.basis).toContain("project default");
  });

  it("asset override beats the project default, and is the only case that is NOT an assumption", () => {
    const x = resolveSecrecyLifetime({ assetClassification: "public", projectClassification: "regulated" });

    expect(x.years).toBe(0);
    expect(x.classification).toBe("public");
    expect(x.source).toBe("asset");
    expect(x.assumed).toBe(false);
    expect(x.basis).toContain("Supplied for this asset");
  });

  it("X = 0 (Public) is a real value, not a missing one — it must not fall through to the default", () => {
    const x = resolveSecrecyLifetime({ assetSecrecyLifetimeYears: 0 });

    expect(x.years).toBe(0);
    expect(x.source).toBe("asset");
    expect(x.assumed).toBe(false);
  });

  it("years are settable independently of the label: 'Confidential, but this one lasts 10 years'", () => {
    const x = resolveSecrecyLifetime({ assetClassification: "confidential", assetSecrecyLifetimeYears: 10 });

    expect(x.years).toBe(10); // not the preset 7
    expect(x.classification).toBe("confidential");
    expect(x.source).toBe("asset");
    expect(x.assumed).toBe(false);
  });

  it("an asset-level year override with an inherited label reports each provenance separately", () => {
    const x = resolveSecrecyLifetime({ assetSecrecyLifetimeYears: 12, projectClassification: "internal" });

    expect(x.years).toBe(12);
    expect(x.source).toBe("asset");
    expect(x.assumed).toBe(false);
    expect(x.classification).toBe("internal");
    expect(x.classificationSource).toBe("project"); // the label was NOT supplied for this asset
    expect(x.basis).toContain("inherited");
  });

  it("a project-level year override beats the project's own label preset", () => {
    const x = resolveSecrecyLifetime({ projectClassification: "internal", projectSecrecyLifetimeYears: 15 });

    expect(x.years).toBe(15);
    expect(x.source).toBe("project");
    expect(x.assumed).toBe(true);
  });

  it("an asset label beats an inherited project year override — precedence is by level, not by field", () => {
    const x = resolveSecrecyLifetime({ assetClassification: "indefinite", projectSecrecyLifetimeYears: 15 });

    expect(x.years).toBe(50);
    expect(x.source).toBe("asset");
    expect(x.assumed).toBe(false);
  });

  it("every preset resolves to its spec X when set at asset level", () => {
    for (const preset of DATA_CLASSIFICATION_PRESETS) {
      expect(resolveSecrecyLifetime({ assetClassification: preset.value }).years).toBe(preset.years);
    }
  });

  it("`basis` never contradicts `assumed` — a report renders them together", () => {
    // The bug this catches: a sentence opening "Assumed…" on a record flagged
    // `assumed: false`, which is easy to write in the mixed-provenance branch
    // (X supplied on the asset, label inherited from the project). Asserting
    // the two fields separately, as the cases above do, would not see it.
    const levels = [undefined, null, "confidential", "regulated"] as const;
    const yearValues = [undefined, null, 0, 12] as const;

    for (const assetClassification of levels) {
      for (const assetSecrecyLifetimeYears of yearValues) {
        for (const projectClassification of levels) {
          for (const projectSecrecyLifetimeYears of yearValues) {
            const x = resolveSecrecyLifetime({
              assetClassification,
              assetSecrecyLifetimeYears,
              projectClassification,
              projectSecrecyLifetimeYears,
            });
            const claimsAssumption = /assumed/i.test(x.basis);
            expect(claimsAssumption, `basis "${x.basis}" disagrees with assumed=${x.assumed}`).toBe(x.assumed);
            expect(x.assumed).toBe(x.source !== "asset");
            expect(Number.isFinite(x.years)).toBe(true);
            expect(x.years).toBeGreaterThanOrEqual(0);
            expect(x.basis).toContain(String(x.years));
          }
        }
      }
    }
  });

  it("is pure — the same input twice gives an identical record", () => {
    const input = { assetClassification: "confidential" } as const;
    expect(resolveSecrecyLifetime(input)).toEqual(resolveSecrecyLifetime(input));
  });
});

describe("A3 schema — persisted against a real (embedded) Postgres via the generated migration", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it(
    "both levels store null by default — 'not supplied' survives a write and a read-back",
    async () => {
      const { db, close } = await createTestDb();
      cleanup = close;

      const [project] = await db
        .insert(projectsTable)
        .values({ organizationId: 1, name: "unclassified", language: "python" })
        .returning();
      const [asset] = await db
        .insert(assetsTable)
        .values({ organizationId: 1, fingerprint: "fp-a3-null", surface: "source", algorithm: "RSA", location: "x" })
        .returning();

      // The failure this catches: a `DEFAULT 'internal'` (or `DEFAULT 3`) added
      // to any of these four columns. It would make every asset look classified
      // and there would be no way left to report the value as assumed.
      const [p] = await db.select().from(projectsTable).where(eq(projectsTable.id, project.id));
      const [a] = await db.select().from(assetsTable).where(eq(assetsTable.id, asset.id));
      expect(p.dataClassification).toBeNull();
      expect(p.secrecyLifetimeYears).toBeNull();
      expect(a.dataClassification).toBeNull();
      expect(a.secrecyLifetimeYears).toBeNull();

      expect(
        resolveSecrecyLifetime({
          assetClassification: a.dataClassification,
          assetSecrecyLifetimeYears: a.secrecyLifetimeYears,
          projectClassification: p.dataClassification,
          projectSecrecyLifetimeYears: p.secrecyLifetimeYears,
        }).assumed,
      ).toBe(true);
    },
    DB_TIMEOUT,
  );

  it(
    "a project default and an asset override round-trip, and resolve end to end",
    async () => {
      const { db, close } = await createTestDb();
      cleanup = close;

      const [project] = await db
        .insert(projectsTable)
        .values({
          organizationId: 1,
          name: "patient records",
          language: "python",
          dataClassification: "regulated",
        })
        .returning();
      const [asset] = await db
        .insert(assetsTable)
        .values({
          organizationId: 1,
          fingerprint: "fp-a3-override",
          surface: "source",
          algorithm: "RSA",
          location: "x",
          dataClassification: "confidential",
          secrecyLifetimeYears: 10,
        })
        .returning();

      const [p] = await db.select().from(projectsTable).where(eq(projectsTable.id, project.id));
      const [a] = await db.select().from(assetsTable).where(eq(assetsTable.id, asset.id));
      expect(p.dataClassification).toBe("regulated");
      expect(a.secrecyLifetimeYears).toBe(10);

      const x = resolveSecrecyLifetime({
        assetClassification: a.dataClassification,
        assetSecrecyLifetimeYears: a.secrecyLifetimeYears,
        projectClassification: p.dataClassification,
        projectSecrecyLifetimeYears: p.secrecyLifetimeYears,
      });
      expect(x).toMatchObject({ years: 10, source: "asset", assumed: false, classification: "confidential" });
    },
    DB_TIMEOUT,
  );

  it(
    "rejects an out-of-enum classification via the CHECK constraint, on both tables",
    async () => {
      const { db, close } = await createTestDb();
      cleanup = close;

      // The columns are `text`, so the CHECK is what has to reject these — not
      // the type system, which a request body cast would walk straight past.
      await expect(
        db.insert(projectsTable).values({
          organizationId: 1,
          name: "p",
          language: "python",
          dataClassification: "top-secret" as never,
        }),
      ).rejects.toThrow();

      await expect(
        db.insert(assetsTable).values({
          organizationId: 1,
          fingerprint: "fp-a3-bad-class",
          surface: "source",
          algorithm: "RSA",
          location: "x",
          dataClassification: "Confidential" as never, // right word, wrong case
        }),
      ).rejects.toThrow();
    },
    DB_TIMEOUT,
  );

  it(
    "rejects a negative secrecy lifetime, and allows 0 and a value beyond the largest preset",
    async () => {
      const { db, close } = await createTestDb();
      cleanup = close;

      // A negative X would invert Mosca's inequality in A4 rather than merely
      // being odd, so the database refuses it.
      await expect(
        db.insert(assetsTable).values({
          organizationId: 1,
          fingerprint: "fp-a3-negative",
          surface: "source",
          algorithm: "RSA",
          location: "x",
          secrecyLifetimeYears: -1,
        }),
      ).rejects.toThrow();

      // 0 is Public, a real value. And there is deliberately no upper bound:
      // `indefinite` is 50 by preset, not by constraint.
      await expect(
        db.insert(assetsTable).values({
          organizationId: 1,
          fingerprint: "fp-a3-zero",
          surface: "source",
          algorithm: "RSA",
          location: "x",
          secrecyLifetimeYears: 0,
        }),
      ).resolves.toBeDefined();
      await expect(
        db.insert(projectsTable).values({
          organizationId: 1,
          name: "century",
          language: "python",
          secrecyLifetimeYears: 100,
        }),
      ).resolves.toBeDefined();
    },
    DB_TIMEOUT,
  );

  it(
    "classification is tenant-scoped: another organisation's classified project and asset are invisible",
    async () => {
      // `asRole` is not optional here. The default pglite superuser has
      // BYPASSRLS, and this assertion would pass while proving nothing.
      const { db, scope, seedAsSuperuser, close } = await createTestDb({ asRole: "quantaxscan_app" });
      cleanup = close;

      await seedAsSuperuser(async (client) => {
        await client.query(
          `insert into projects (organization_id, name, language, data_classification, secrecy_lifetime_years)
             values (1, 'their regulated project', 'python', 'regulated', 25)`,
        );
        await client.query(
          `insert into assets (organization_id, fingerprint, surface, algorithm, location, data_classification)
             values (1, 'fp-a3-theirs', 'source', 'RSA', 'project:1:a.py', 'indefinite')`,
        );
      });

      // No `where organization_id` anywhere below — the policy is what scopes it.
      const seen = await scope.withOrg({ organizationId: 2, userId: "" }, async (tx) => ({
        projects: await tx.select().from(projectsTable),
        assets: await tx.select().from(assetsTable),
      }));
      expect(seen.projects).toEqual([]);
      expect(seen.assets).toEqual([]);

      // Negative control: the same rows are there, and org 1 does see them —
      // so the emptiness above is isolation, not an empty database.
      const theirs = await scope.withOrg({ organizationId: 1, userId: "" }, (tx) =>
        tx.select().from(projectsTable),
      );
      expect(theirs.map((p) => p.dataClassification)).toEqual(["regulated"]);

      // And the harness role really is subject to RLS.
      const [role] = await executeRows<{ current_user: string; bypass: boolean }>(
        db,
        sql`select current_user, rolbypassrls as bypass from pg_roles where rolname = current_user`,
      );
      expect(role.current_user).toBe("quantaxscan_app");
      expect(role.bypass).toBe(false);
    },
    DB_TIMEOUT,
  );
});
