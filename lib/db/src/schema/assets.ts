import { pgTable, text, serial, integer, real, timestamp, jsonb, check, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { SURFACE_VALUES, ASSET_STATUS_VALUES, type LocationDetail } from "@workspace/collectors";
import { oneOf } from "./sql-helpers";

/**
 * Stable identity, survives re-scans. docs/Claude/04-architecture.md
 * §"Target model": `asset — a thing that has crypto, persists across scans`.
 *
 * `organizationId` has no `references()` — there is no `organizations` table
 * yet (multi-tenancy is F2, out of scope for this change). It is carried
 * here, unenforced, so the fingerprint uniqueness scope and the eventual F2
 * migration do not require touching this table again.
 *
 * `fingerprint` is unique per organization, not globally: two organizations
 * legitimately scanning identical code should each get their own asset, not
 * collide into one.
 */
export const assetsTable = pgTable(
  "assets",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull(),
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

    // ownership + risk inputs (consumed by A3/A4, not built here)
    ownerId: integer("owner_id"),
    dataClassification: text("data_classification"),
    secrecyLifetimeYears: integer("secrecy_lifetime_years"),
    effortHours: real("effort_hours"),
    agilityScore: real("agility_score"),
  },
  (table) => [
    uniqueIndex("assets_org_fingerprint_idx").on(table.organizationId, table.fingerprint),
    check("assets_surface_check", oneOf(table.surface, SURFACE_VALUES)),
    check("assets_status_check", oneOf(table.status, ASSET_STATUS_VALUES)),
  ],
);

export const insertAssetSchema = createInsertSchema(assetsTable).omit({ id: true, firstSeen: true, lastSeen: true });
export type InsertAsset = z.infer<typeof insertAssetSchema>;
export type Asset = typeof assetsTable.$inferSelect;
