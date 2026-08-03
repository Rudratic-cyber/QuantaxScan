import { boolean, check, index, pgTable, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { IDENTITY_PROVIDER_VALUES } from "./auth-enums";
import { oneOf } from "./sql-helpers";
import { usersTable } from "./auth";

/**
 * One row per (identity provider, subject) a user has linked.
 * docs/Claude/13-auth-and-tenancy.md §4.2 and §3.6.
 *
 * This table exists so that `users.id` can be an internal identifier rather
 * than one provider's `sub`. Under the single-provider Replit pattern the two
 * were the same value; with three providers they cannot be.
 *
 * `(provider, provider_user_id)` is the ONLY join key from a sign-in to a
 * user. Email is a hint and never an identifier — Google: "*Don't use the
 * email field as a unique identifier for a user. Always use the `sub`
 * field.*"; Microsoft: "*Never use it for authorization or to save data for a
 * user.*" Matching on email is the account-takeover surface this table
 * removes.
 *
 * No sign-in flow reads this table yet — that is P2. The table lands in P1
 * with the rest of the schema so the migration happens once.
 */
export const userIdentitiesTable = pgTable(
  "user_identities",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /** google: `sub` · microsoft: `oid` (not `sub`, which is per-application) · github: the numeric id as text. NEVER an email. */
    providerUserId: text("provider_user_id").notNull(),
    /** microsoft: the `tid` claim. Null for the others — `oid` alone is not unique across tenants for a guest user. */
    providerTenantId: text("provider_tenant_id"),
    /** As asserted at link time. Informational — never a join key. */
    email: text("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("user_identities_provider_subject_idx").on(table.provider, table.providerUserId),
    index("user_identities_user_idx").on(table.userId),
    check("user_identities_provider_check", oneOf(table.provider, IDENTITY_PROVIDER_VALUES)),
  ],
);

export type UserIdentity = typeof userIdentitiesTable.$inferSelect;
export type InsertUserIdentity = typeof userIdentitiesTable.$inferInsert;
