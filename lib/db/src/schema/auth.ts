import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * `connect-pg-simple`'s table, near-verbatim from its `table.sql`.
 *
 * `expire` is `timestamptz`, and that is a bug fix rather than a preference:
 * `connect-pg-simple` compares `expire >= to_timestamp($2)`, and
 * `to_timestamp()` returns `timestamptz`. Against a `timestamp without time
 * zone` column PostgreSQL resolves that by reading the stored value as local
 * time in the session's `TimeZone`, so a row written under one `TimeZone` and
 * read under another expires at the wrong moment — measured at ~13 h early
 * for a session written under `Etc/GMT0` and read under `Pacific/Auckland`.
 * See docs/Claude/13-auth-and-tenancy.md §2.3.
 *
 * Not RLS-scoped, deliberately: sessions are read before any organisation
 * context exists.
 */
export const sessionsTable = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire", { withTimezone: true }).notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

/**
 * The person. A profile table, not an identity table: provider subjects live
 * in `user_identities` (see user_identities.ts), so `id` is an internal
 * identifier and its `gen_random_uuid()` default is what generates it.
 *
 * Not RLS-scoped, deliberately: a user is read before an organisation context
 * exists. Enumeration is still contained, because the only route that lists
 * users joins through `organization_members`, which *is* scoped.
 */
export const usersTable = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type UpsertUser = typeof usersTable.$inferInsert;
export type User = typeof usersTable.$inferSelect;
