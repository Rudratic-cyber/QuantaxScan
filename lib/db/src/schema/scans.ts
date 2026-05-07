import { pgTable, text, serial, timestamp, integer, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const scansTable = pgTable("scans", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  mode: text("mode").notNull().default("scan-only"),
  status: text("status").notNull().default("pending"),
  riskScore: integer("risk_score"),
  totalLines: integer("total_lines").notNull().default(0),
  criticalCount: integer("critical_count").notNull().default(0),
  alertCount: integer("alert_count").notNull().default(0),
  cleanCount: integer("clean_count").notNull().default(0),
  totalEffortHours: real("total_effort_hours").notNull().default(0),
  estimatedCost: integer("estimated_cost").notNull().default(0),
  executiveSummary: text("executive_summary"),
  code: text("code"),
  language: text("language"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const insertScanSchema = createInsertSchema(scansTable).omit({ id: true, createdAt: true });
export type InsertScan = z.infer<typeof insertScanSchema>;
export type Scan = typeof scansTable.$inferSelect;
