import { pgTable, text, serial, integer, timestamp, index, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { nullableAtLeast } from "./sql-helpers";
import { organizationsTable } from "./organizations";

/**
 * B8 — the manual OT/embedded register. docs/Claude/03-features.md §B8,
 * docs/Claude/02-roadmap.md "Phase 5 — Long-lead surfaces": OT and embedded
 * deliver value last but have to enter the *plan* first, because their lead
 * time is a hardware replacement cycle (7-15 years) rather than a sprint.
 *
 * **Deliberately not an `assets` row.** `assets` exists to answer "what did a
 * collector observe and does it still hold" — its whole contract is a stable
 * `fingerprint` that *survives re-scans*, reconciled against a
 * `collection_runs` row on a `surface` a collector actually flipped to
 * `live` (rule: a surface counts as examined only when ingestion persists
 * into it). Nothing here is ever collected: a human types it in and edits it
 * by hand as facts change. Routing this through the asset/observation
 * lifecycle would mean either inventing an `ot` surface that no collector
 * ever populates (the exact dishonesty the D3 coverage meter exists to
 * prevent) or bending `firstSeen`/`lastSeen`/reobservation-scope semantics
 * onto data that has no "scan" to be re-observed by. A dedicated org-scoped
 * table, alongside the same isolation machinery every other tenant table
 * uses, says what this is without pretending it is the other thing.
 *
 * Every column but `name` is nullable with **no database default** — see
 * CLAUDE.md "Null means not supplied". The entire reason this register earns
 * its keep is being able to say "nobody told us the next procurement date"
 * rather than manufacturing one; a guessed date that looks supplied would
 * silently read as "within the migration window" (or the opposite) for a
 * claim nobody actually made.
 */
export const otFleetsTable = pgTable(
  "ot_fleets",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /** What the customer calls this fleet, e.g. "Substation PLCs — West region". The only required field. */
    name: text("name").notNull(),
    vendor: text("vendor"),
    model: text("model"),
    /** How many devices this row represents. Null (nobody has counted) is distinct from 0 (counted and there are none). */
    deviceCount: integer("device_count"),
    site: text("site"),
    /** Free text: a team, role or vendor contact — not a user id, because the responsible party is often outside the app entirely. */
    owner: text("owner"),
    /**
     * Free-form description of the cryptography in use, e.g. "RSA-2048
     * firmware signing, no TLS". Deliberately not constrained to the finding
     * algorithm vocabulary (which is derived from parsed evidence): a manual
     * entry is an approximation the customer is asserting, not a detection.
     */
    cryptoInUse: text("crypto_in_use"),
    /** Years between hardware/firmware refreshes for this fleet. */
    refreshCycleYears: integer("refresh_cycle_years"),
    /**
     * The next scheduled procurement/replacement decision point — the field
     * the Q-Day exposure check (`assessOtExposure`, api-server) reads. A
     * fleet whose next window falls after a Q-Day scenario's year is exposed
     * under that scenario *by definition*: no replacement decision is
     * scheduled before the deadline, so nothing currently in flight would
     * have swapped its cryptography out in time.
     */
    nextProcurementDate: timestamp("next_procurement_date", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("ot_fleets_org_idx").on(table.organizationId),
    check("ot_fleets_device_count_check", nullableAtLeast(table.deviceCount, 0)),
    check("ot_fleets_refresh_cycle_years_check", nullableAtLeast(table.refreshCycleYears, 0)),
  ],
);

export const insertOtFleetSchema = createInsertSchema(otFleetsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertOtFleet = z.infer<typeof insertOtFleetSchema>;
export type OtFleet = typeof otFleetsTable.$inferSelect;
