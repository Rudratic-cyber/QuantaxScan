import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { assetsTable } from "./assets";
import { organizationsTable } from "./organizations";

/**
 * C8 — the waivers / exceptions register. docs/Claude/03-features.md §C8.
 *
 * A waiver is a **record that somebody accepted a risk**, not a way of making
 * the risk go away. Everything below follows from that one sentence.
 *
 * ## It expires, and there is no way to say otherwise
 *
 * `expires_at` is `NOT NULL` with no default and no "never" encoding. A waiver
 * that does not expire is not an exception, it is a silent edit to the
 * inventory — and the failure mode of an accepted risk is precisely that it is
 * accepted once, in a meeting, and then suppresses a finding for four years
 * because nobody scheduled the conversation again. The `CHECK` below refuses a
 * row whose expiry is not after its own sign-off, so a zero-length or
 * retroactive waiver cannot be written at all.
 *
 * **Expiry is not enforced by this table and cannot be.** `now()` is not
 * immutable, so it cannot appear in a `CHECK` or a generated column, and it
 * must not appear in a `WHERE` on the register read either — an expired waiver
 * has to stay readable or the register loses the history that is its whole
 * point. The decision therefore lives in exactly one pure function,
 * `resolveWaiverStatus()` in `src/waivers.ts`, which every read path calls.
 * One place, injectable clock, testable without sleeping.
 *
 * ## It names somebody, and says whether we checked
 *
 * Two columns, deliberately:
 *
 *   * `signed_off_by` — who accepted the risk, as stated. `NOT NULL`: a waiver
 *     attributed to nobody is an anonymous suppression.
 *   * `signed_off_by_user_id` — the authenticated principal that wrote the row,
 *     or `NULL` when there was no person behind it (the shared API key). Same
 *     rule as `divisions.created_by_user_id` and for the same reason: a
 *     manufactured attribution is worse than an absent one.
 *
 * The pair is what lets a read say `attribution: "authenticated" | "asserted"`
 * instead of laundering a machine credential into a human signature. No foreign
 * key on either: a waiver signed by somebody who has since left the company is
 * still the record of what was decided, and deleting the user must not delete
 * the decision.
 *
 * ## It is revoked, never deleted
 *
 * There is no `DELETE /api/waivers/:id`. `revoked_at` closes a waiver while
 * leaving the row, because a register you can delete from records only what
 * nobody minded recording.
 *
 * The one erasure this schema does permit is `asset_id ON DELETE CASCADE`,
 * chosen knowingly: an asset is deleted when its project is, and a waiver on a
 * row that no longer exists suppresses nothing and can never expire into view
 * again. It is the same cascade `observations` takes from `assets`. If the
 * register is ever required to outlive its subjects, that is a deliberate
 * change to `ON DELETE RESTRICT` plus a tombstone, not a default to drift into.
 *
 * ## What it never does
 *
 * A waiver **annotates**; it does not filter. The asset stays in the inventory,
 * in the CBOM, in `statusCounts`, and in every coverage and readiness number.
 * `summariseInventoryAssets()` attaches the active waiver and changes nothing
 * else, and `tests/e2e/22-waivers.spec.ts` asserts those payloads are
 * byte-identical before and after a waiver is granted. Suppressing a finding
 * from a working list is legitimate; improving a coverage number by accepting a
 * risk is the exact failure this product exists not to commit.
 */
export const waiversTable = pgTable(
  "waivers",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /**
     * RBAC — copied from the asset at sign-off, exactly as `findings.division_id`
     * is copied from its scan's project. A policy cannot cheaply follow
     * `asset_id` into `assets` to find the division, and a waiver that a
     * division-restricted viewer can see but whose asset they cannot is an
     * information leak with extra steps.
     */
    divisionId: integer("division_id"),
    assetId: integer("asset_id")
      .notNull()
      .references(() => assetsTable.id, { onDelete: "cascade" }),
    /** Why the risk was accepted. `NOT NULL`; the route additionally refuses whitespace. */
    justification: text("justification").notNull(),
    /** Who accepted it, as stated by the caller. */
    signedOffBy: text("signed_off_by").notNull(),
    /** The authenticated principal that wrote the row, or NULL for the API-key principal. */
    signedOffByUserId: varchar("signed_off_by_user_id"),
    signedOffAt: timestamp("signed_off_at", { withTimezone: true }).notNull().defaultNow(),
    /** When it stops being a waiver. No default: a caller must decide how long. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: varchar("revoked_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("waivers_org_asset_idx").on(table.organizationId, table.assetId),
    index("waivers_org_expires_idx").on(table.organizationId, table.expiresAt),
    // Column-to-column, so no bind parameter is emitted and no `sql.raw()`
    // dance is needed — see `sql-helpers.ts` for the trap this sidesteps.
    check("waivers_expiry_after_signoff_check", sql`${table.expiresAt} > ${table.signedOffAt}`),
  ],
);

export type Waiver = typeof waiversTable.$inferSelect;
export type InsertWaiver = typeof waiversTable.$inferInsert;
