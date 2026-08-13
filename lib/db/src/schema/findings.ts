import { pgTable, text, serial, integer, real, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { scansTable } from "./scans";
import { organizationsTable } from "./organizations";

export const findingsTable = pgTable("findings", {
  id: serial("id").primaryKey(),
  /** Denormalised from `scans` — see the matching note on `scans.organizationId`. */
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  // Real FK added during the A1/A2 migration — previously a plain integer
  // with nothing stopping an orphaned row. See docs/Claude/04-architecture.md
  // §"Also: add foreign keys". `findings` is legacy: new writes go to
  // `assets`/`observations`; this table is kept and dual-written to during
  // the transition (see docs/Claude/04-architecture.md §"Migration path")
  // and is not yet read-cut-over or dropped.
  scanId: integer("scan_id")
    .notNull()
    .references(() => scansTable.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  lineNumber: integer("line_number").notNull(),
  severity: text("severity").notNull(), // critical | alert | safe
  algorithm: text("algorithm").notNull(),
  codeSnippet: text("code_snippet").notNull(),
  nistReplacement: text("nist_replacement"),
  nistStandard: text("nist_standard"),
  effortHours: real("effort_hours").notNull().default(1),
  explanation: text("explanation"),
}, (table) => [index("findings_org_idx").on(table.organizationId)]);

export const insertFindingSchema = createInsertSchema(findingsTable).omit({ id: true });
export type InsertFinding = z.infer<typeof insertFindingSchema>;
export type Finding = typeof findingsTable.$inferSelect;
