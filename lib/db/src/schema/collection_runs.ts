import { pgTable, text, serial, integer, timestamp, jsonb, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { SURFACE_VALUES, type EnumerationRecord } from "@workspace/collectors";
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
/**
 * The three states a run can be in.
 *
 * Defined here, in the schema file, rather than in `@workspace/collectors`:
 * exactly one table uses it, and a collector has no concept of a run's status —
 * it produces observations and the server decides what became of the attempt.
 * Same reasoning as B9's vendor tuples (see CLAUDE.md's recorded exceptions).
 *
 * **`failed` was unreachable until 2026-08-16.** The only production insert
 * into this table hardcoded `"completed"`, so a collection that blew up was
 * filed as one that succeeded, while `coverage.ts` carried a live `failed`
 * branch that nothing could reach. The vocabulary is exported now so the
 * write path has to name a value rather than default into the reassuring one.
 */
export const COLLECTION_RUN_STATUS_VALUES = ["running", "completed", "failed"] as const;
export type CollectionRunStatus = (typeof COLLECTION_RUN_STATUS_VALUES)[number];

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
    status: text("status").notNull().default("completed"), // COLLECTION_RUN_STATUS_VALUES
    target: text("target"), // repo/host/package descriptor the collector was pointed at
    /**
     * What this run could and could not speak for — docs/Claude/17-discovery-design.md §4.4(b).
     *
     * **Nullable with no default, and that is the point.** Absent means a
     * submission, which made no enumeration claim at all: the customer handed
     * us an export and we recorded it. An *empty* record would say "we
     * enumerated, and successfully enumerated nothing", which is a different
     * and much stronger statement. Same discipline as `assets.key_size` and
     * A3's classification columns — a value nobody supplied must not be
     * storable as a value somebody did.
     *
     * `jsonb` rather than columns because the shape is a list of scopes whose
     * fields differ per provider, and because a new scope kind then needs no
     * migration — the property `assets.location_detail` relies on. Validated at
     * the application boundary, not by a `CHECK`.
     */
    enumeration: jsonb("enumeration").$type<EnumerationRecord>(),
    observationCount: integer("observation_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    check("collection_runs_surface_check", oneOf(table.surface, SURFACE_VALUES)),
    check("collection_runs_status_check", oneOf(table.status, COLLECTION_RUN_STATUS_VALUES)),
  ],
);

export const insertCollectionRunSchema = createInsertSchema(collectionRunsTable).omit({ id: true, startedAt: true });
export type InsertCollectionRun = z.infer<typeof insertCollectionRunSchema>;
export type CollectionRun = typeof collectionRunsTable.$inferSelect;
