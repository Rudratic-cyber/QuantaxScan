import { pgTable, text, serial, integer, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const findingsTable = pgTable("findings", {
  id: serial("id").primaryKey(),
  scanId: integer("scan_id").notNull(),
  fileName: text("file_name").notNull(),
  lineNumber: integer("line_number").notNull(),
  severity: text("severity").notNull(), // critical | alert | safe
  algorithm: text("algorithm").notNull(),
  codeSnippet: text("code_snippet").notNull(),
  nistReplacement: text("nist_replacement"),
  nistStandard: text("nist_standard"),
  effortHours: real("effort_hours").notNull().default(1),
  explanation: text("explanation"),
});

export const insertFindingSchema = createInsertSchema(findingsTable).omit({ id: true });
export type InsertFinding = z.infer<typeof insertFindingSchema>;
export type Finding = typeof findingsTable.$inferSelect;
