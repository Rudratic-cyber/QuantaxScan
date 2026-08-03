import { pgTable, text, serial, timestamp, integer, real, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectsTable } from "./projects";
import { organizationsTable } from "./organizations";

export const scansTable = pgTable("scans", {
  id: serial("id").primaryKey(),
  // Denormalised from `projects` rather than reached through it. A join-based
  // policy works, but it puts an EXISTS subquery in the hot path of every read
  // and makes this table's isolation depend on the parent's policy staying
  // correct. A local column costs 4 bytes, is independently checkable, and —
  // because the policy's WITH CHECK rejects a row carrying the wrong value —
  // cannot drift from its parent. See docs/Claude/13-auth-and-tenancy.md §4.3.
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  // Real FK added during the A1/A2 migration — see
  // docs/Claude/04-architecture.md §"Also: add foreign keys".
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
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
}, (table) => [index("scans_org_idx").on(table.organizationId)]);

export const insertScanSchema = createInsertSchema(scansTable).omit({ id: true, createdAt: true });
export type InsertScan = z.infer<typeof insertScanSchema>;
export type Scan = typeof scansTable.$inferSelect;
