import { boolean, check, index, integer, pgTable, primaryKey, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ORG_ROLE_VALUES } from "./auth-enums";
import { oneOf } from "./sql-helpers";
import { usersTable } from "./auth";

/**
 * The tenant. docs/Claude/13-auth-and-tenancy.md §4.2.
 *
 * `id` is `serial` (integer), not `uuid`, and that is forced rather than
 * chosen: `assets.organization_id` and `collection_runs.organization_id`
 * already exist as `integer NOT NULL` and carry real rows. A `uuid` primary
 * key here would mean retyping those columns and rebuilding
 * `assets_org_fingerprint_idx` on populated tables for no benefit.
 *
 * Organisation 1 is seeded by `apply-tenancy` and is the organisation every
 * pre-existing row already belongs to.
 */
export const organizationsTable = pgTable(
  "organizations",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** True for the organisation auto-created for a solo user. Never surfaced in the UI — a solo user is an organisation of one and should never meet the concept. */
    personal: boolean("personal").notNull().default(false),
    /**
     * Who created this organisation, when a person did. NULL for the ones an
     * operator creates (`apply-tenancy`, `create-organization`), which is why
     * it is nullable with no default — null means "not created by a user",
     * never "created by nobody in particular".
     *
     * It is also load-bearing for row-level security, which is the reason it
     * exists at all rather than being nice-to-have provenance. Sign-up creates
     * a personal organisation for a user who is, by definition, not yet a
     * member of anything — so neither branch of `organizations_org_isolation`'s
     * `USING` can see the row it just inserted, and `INSERT ... RETURNING id`
     * is subject to that policy (verified under PGlite: the RETURNING is
     * refused). This column is the third branch, and it is what lets the
     * bootstrap read back the id it needs.
     *
     * No foreign key to `users`, deliberately: deleting a user must not
     * cascade-delete an organisation, and `ON DELETE SET NULL` would erase the
     * provenance F3's audit log wants. The value is a `users.id` and is read
     * as such.
     */
    createdByUserId: varchar("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("organizations_slug_idx").on(table.slug)],
);

/**
 * Membership, and the authorisation record `resolvePrincipal` re-reads on
 * every authenticated request. It is the grant; `req.session.organizationId`
 * is only ever a cache of it (§6.3).
 *
 * `userId` is `varchar` because `users.id` is `varchar` — see auth.ts. A
 * `uuid` declaration here would be a foreign-key type mismatch at migration
 * time.
 */
export const organizationMembersTable = pgTable(
  "organization_members",
  {
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    index("organization_members_user_idx").on(table.userId),
    check("organization_members_role_check", oneOf(table.role, ORG_ROLE_VALUES)),
  ],
);

export const insertOrganizationSchema = createInsertSchema(organizationsTable).omit({ id: true, createdAt: true });
export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;
export type Organization = typeof organizationsTable.$inferSelect;
export type OrganizationMember = typeof organizationMembersTable.$inferSelect;
