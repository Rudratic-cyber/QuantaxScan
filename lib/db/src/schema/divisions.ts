import { check, index, integer, pgTable, primaryKey, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { DIVISION_ROLE_VALUES } from "./auth-enums";
import { oneOf } from "./sql-helpers";
import { organizationsTable } from "./organizations";
import { usersTable } from "./auth";

/**
 * A division — a team, a business unit, an application group — inside one
 * tenant. docs/Claude/15-rbac-design.md §2.
 *
 * The unit a role is granted over. Without it the only scopes available are
 * "the whole tenant" and "one project", and neither is how an enterprise is
 * actually organised: nobody wants to re-grant Payments to a new joiner one
 * project at a time.
 *
 * **A project's `division_id` is nullable and null means organisation-wide.**
 * That is what makes this migratable rather than a flag day: every project that
 * existed before divisions did keeps `NULL`, stays visible to everyone in the
 * tenant, and behaves exactly as it did. A tenant that never creates a division
 * sees no change at all. Null here is "belongs to no division", never "belongs
 * to a default division" — the same rule as `assets.key_size` and A3's
 * classification columns, and for the same reason: a default would erase the
 * difference between a decision and its absence.
 */
export const divisionsTable = pgTable(
  "divisions",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** URL-safe handle, unique within the organisation. Never across organisations — two tenants may both have a "payments". */
    slug: text("slug").notNull(),
    description: text("description"),
    /**
     * Who created it, when a person did. Nullable with no default for the same
     * reason `organizations.created_by_user_id` is: an operator script has no
     * user behind it, and a manufactured attribution is worse than an absent
     * one. No foreign key, so deleting a user does not cascade into the
     * division they happened to create.
     */
    createdByUserId: varchar("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("divisions_org_slug_idx").on(table.organizationId, table.slug),
    index("divisions_org_idx").on(table.organizationId),
  ],
);

/**
 * A user's role on one division. The row that makes "read-only on Retail,
 * admin on Payments" expressible.
 *
 * **A grant only ever raises.** The effective role on a project is the stronger
 * of the org-level role and any grant on that project's division
 * (`strongerRole`, auth-enums.ts). A grant cannot demote someone below what the
 * organisation already gave them — expressing "admin everywhere *except*
 * Payments" needs a deny model, which is a different and much larger feature
 * and is recorded as an open question in the design rather than half-built here.
 *
 * `organization_id` is carried redundantly beside `division_id`, which is a
 * denormalisation and a deliberate one: every row-level-security policy in this
 * database filters on `organization_id`, and a table without the column would
 * need a join to be scoped at all. The unique index below keeps the pair
 * honest.
 */
export const divisionGrantsTable = pgTable(
  "division_grants",
  {
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    divisionId: integer("division_id")
      .notNull()
      .references(() => divisionsTable.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("viewer"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.divisionId, table.userId] }),
    index("division_grants_user_idx").on(table.userId),
    index("division_grants_org_idx").on(table.organizationId),
    check("division_grants_role_check", oneOf(table.role, DIVISION_ROLE_VALUES)),
  ],
);

export type Division = typeof divisionsTable.$inferSelect;
export type DivisionGrant = typeof divisionGrantsTable.$inferSelect;
