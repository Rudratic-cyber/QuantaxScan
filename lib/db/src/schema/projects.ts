import { pgTable, text, serial, timestamp, integer, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  language: text("language").notNull(),
  riskScore: integer("risk_score"),
  lastScanAt: timestamp("last_scan_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  totalScans: integer("total_scans").notNull().default(0),
  criticalCount: integer("critical_count").notNull().default(0),
  alertCount: integer("alert_count").notNull().default(0),
  cleanCount: integer("clean_count").notNull().default(0),
});

export const insertProjectSchema = createInsertSchema(projectsTable).omit({ id: true, createdAt: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;
