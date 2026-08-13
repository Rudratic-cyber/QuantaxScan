import { pgTable, text, serial, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

/**
 * `organizationId` is **nullable**, and the policy treats NULL asymmetrically
 * on purpose: a NULL-org row is a platform-level event, readable by every
 * organisation but writable by none. See lib/db/sql/tenant-isolation.sql and
 * docs/Claude/13-auth-and-tenancy.md §5.3 before "fixing" that asymmetry.
 *
 * The only pre-existing writer of NULL-org rows was the public demo scan
 * route, which no longer writes here — an unauthenticated route should not
 * write to the database, and a hard-coded demo scan produces no useful audit
 * row. So nothing mints new unowned rows; the legacy feed is immutable and
 * prunable.
 */
export const activityTable = pgTable(
  "activity",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").references(() => organizationsTable.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    severity: text("severity").notNull().default("info"), // critical | alert | info
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("activity_org_idx").on(table.organizationId)],
);

export const insertActivitySchema = createInsertSchema(activityTable).omit({ id: true, timestamp: true });
export type InsertActivity = z.infer<typeof insertActivitySchema>;
export type Activity = typeof activityTable.$inferSelect;
