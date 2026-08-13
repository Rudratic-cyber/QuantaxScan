import { pgTable, text, serial, integer, real, timestamp, jsonb, check, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { SURFACE_VALUES, ASSET_STATUS_VALUES, type LocationDetail } from "@workspace/collectors";
import { oneOf, nullableAtLeast } from "./sql-helpers";
import { DATA_CLASSIFICATION_VALUES, type DataClassification } from "../classification";
import { organizationsTable } from "./organizations";

/**
 * Stable identity, survives re-scans. docs/Claude/04-architecture.md
 * §"Target model": `asset — a thing that has crypto, persists across scans`.
 *
 * `organizationId` now references the real `organizations` table, and is the
 * column the row-level-security policy compares against. It kept its
 * `integer` type through that change — which is why `organizations.id` is
 * `serial` rather than `uuid`; see organizations.ts.
 *
 * `fingerprint` is unique per organization, not globally: two organizations
 * legitimately scanning identical code should each get their own asset, not
 * collide into one.
 */
export const assetsTable = pgTable(
  "assets",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(), // deterministic identity — see @workspace/collectors fingerprint.ts
    surface: text("surface").notNull(),
    algorithm: text("algorithm").notNull(),
    /** The newest observation's key size (parameter size, not security strength). Null when undetermined — see docs/Claude/09-open-gaps.md G-05. Never a guessed default. */
    keySize: integer("key_size"),
    location: text("location").notNull(), // path, host:port, cert serial, key ARN — stable locator, feeds the fingerprint
    locationDetail: jsonb("location_detail").$type<LocationDetail>(), // validated at the application boundary — see @workspace/collectors location-detail.ts

    // lifecycle
    status: text("status").notNull().default("active"), // active | remediated | waived | gone
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),

    // ownership + risk inputs
    ownerId: integer("owner_id"),
    /**
     * A3 — the per-asset override. **Null means "not supplied for this asset"**,
     * which is a distinct and load-bearing state, not a missing value: it is
     * what lets a report say the X it used was *assumed* rather than given.
     * Never given a database default for that reason — see
     * `src/classification.ts`, and `keySize` above for the same idea (G-05).
     * Resolve it with `resolveSecrecyLifetime()`; do not read it raw.
     */
    dataClassification: text("data_classification").$type<DataClassification>(),
    /**
     * A3 — X, in years, overriding the preset implied by `dataClassification`
     * ("Confidential, but this one has to last 10 years"). Null = not supplied.
     */
    secrecyLifetimeYears: integer("secrecy_lifetime_years"),
    // consumed by A4, not built here
    effortHours: real("effort_hours"),
    agilityScore: real("agility_score"),
  },
  (table) => [
    uniqueIndex("assets_org_fingerprint_idx").on(table.organizationId, table.fingerprint),
    // Supports the per-scan "which assets at these locations did this run not
    // reobserve?" reconciliation, which runs on every scan submission.
    index("assets_org_location_status_idx").on(table.organizationId, table.location, table.status),
    check("assets_surface_check", oneOf(table.surface, SURFACE_VALUES)),
    check("assets_status_check", oneOf(table.status, ASSET_STATUS_VALUES)),
    // Nullable, so NULL satisfies both of these — "not supplied" stays sayable.
    check("assets_data_classification_check", oneOf(table.dataClassification, DATA_CLASSIFICATION_VALUES)),
    // A negative X is not a shorter lifetime, it is nonsense that would invert
    // Mosca's inequality in A4. No upper bound: `indefinite` is 50 years by
    // preset but an organisation may legitimately claim longer.
    check("assets_secrecy_lifetime_years_check", nullableAtLeast(table.secrecyLifetimeYears, 0)),
  ],
);

/**
 * The single owner of the `project:<id>` identity convention. This project
 * has no real git-repo concept yet, so a project stands in for the repo in
 * both the fingerprint's `repo` component and an asset's `location`
 * (`<repo>:<path>`). Everything that produces or reconciles project-scoped
 * assets — the scan routes, the backfill script, and the project-delete
 * handler that has to find those assets again — goes through here rather
 * than re-spelling the format.
 */
export function projectRepoId(projectId: number): string {
  return `project:${projectId}`;
}

export const insertAssetSchema = createInsertSchema(assetsTable).omit({ id: true, firstSeen: true, lastSeen: true });
export type InsertAsset = z.infer<typeof insertAssetSchema>;
export type Asset = typeof assetsTable.$inferSelect;
