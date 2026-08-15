import { pgTable, text, serial, integer, timestamp, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { SURFACE_VALUES } from "@workspace/collectors";
import { oneOf } from "./sql-helpers";
import { organizationsTable } from "./organizations";

/**
 * One execution of one collector. docs/Claude/04-architecture.md §"Target
 * model": `collection_run — one execution of one collector`.
 *
 * Kept intentionally small. The qx-sp1800-38b investigation report notes
 * that ingesting *external* discovery-tool reports (EDR, SARIF, PCAP) would
 * need target/agent identity, a source report ID, a capture time range, and
 * adapter provenance beyond what is here — that is a follow-up for a future
 * `ReportAdapter`/import boundary, not required for this project's own
 * first-party collectors emitting `RawObservation` directly.
 */
export const collectionRunsTable = pgTable(
  "collection_runs",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /** RBAC — denormalised from the target project, when the run has one. NULL for an estate-wide run. See §4.3. */
    divisionId: integer("division_id"),
    collector: text("collector").notNull(),
    collectorVersion: text("collector_version").notNull(),
    surface: text("surface").notNull(),
    status: text("status").notNull().default("completed"), // running | completed | failed
    target: text("target"), // repo/host/package descriptor the collector was pointed at
    observationCount: integer("observation_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    check("collection_runs_surface_check", oneOf(table.surface, SURFACE_VALUES)),
    check("collection_runs_status_check", oneOf(table.status, ["running", "completed", "failed"])),
  ],
);

export const insertCollectionRunSchema = createInsertSchema(collectionRunsTable).omit({ id: true, startedAt: true });
export type InsertCollectionRun = z.infer<typeof insertCollectionRunSchema>;
export type CollectionRun = typeof collectionRunsTable.$inferSelect;
