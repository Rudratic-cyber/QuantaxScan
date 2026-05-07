import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const sharedReportsTable = pgTable("shared_reports", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  repo: text("repo").notNull(),
  repoUrl: text("repo_url").notNull(),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SharedReport = typeof sharedReportsTable.$inferSelect;
