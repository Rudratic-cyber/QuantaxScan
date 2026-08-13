import { pgTable, text, serial, integer, real, timestamp, jsonb, check, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { DISCOVERY_MODALITY_VALUES } from "@workspace/collectors";
import { oneOf } from "./sql-helpers";
import { assetsTable } from "./assets";
import { collectionRunsTable } from "./collection_runs";
import { organizationsTable } from "./organizations";

/**
 * Evidence, with provenance. docs/Claude/04-architecture.md §"Target model":
 * `observation — a collector saw this at a point in time`.
 *
 * `algorithm`, `keySize` and `location` are deliberately NOT columns here —
 * per docs/Claude/04-architecture.md's `observationsTable`, those live on
 * `assets` (identity), and this table carries provenance for the
 * observation that established or refreshed them. A collector's raw
 * per-observation facts (including its `keySize`, undetermined or not) are
 * preserved in `evidence` — see the ingestion code that writes this table
 * for the exact shape.
 *
 * `discoveryModality` is the qx-sp1800-38b investigation report's addition
 * (SP 1800-38B §4.1.4): carried alongside numeric `confidence` because "how
 * this was found" and "how sure we are" are different axes of evidence
 * quality. See docs/Claude/09-open-gaps.md G-11 and G-15.
 */
export const observationsTable = pgTable(
  "observations",
  {
    id: serial("id").primaryKey(),
    /**
     * Denormalised from `assets` — see the note on `scans.organizationId`.
     * This does not weaken the project-deletion path: observations still
     * cascade off `assets`, and the `project:<id>:` location-prefix
     * reconciliation in `routes/projects.ts` is unchanged.
     */
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    assetId: integer("asset_id")
      .notNull()
      .references(() => assetsTable.id, { onDelete: "cascade" }),
    collectionRunId: integer("collection_run_id")
      .notNull()
      .references(() => collectionRunsTable.id, { onDelete: "cascade" }),
    collector: text("collector").notNull(), // which collector, which version
    collectorVersion: text("collector_version").notNull(),
    /** 0..1 — regex is not certainty. See docs/Claude/09-open-gaps.md G-11. */
    confidence: real("confidence").notNull(),
    /** How this observation was obtained — see @workspace/collectors enums.ts. */
    discoveryModality: text("discovery_modality").notNull(),
    /** Line number, snippet, handshake detail, binary rule match — and this observation's own algorithm/keySize/location facts. */
    evidence: jsonb("evidence"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("observations_org_idx").on(table.organizationId),
    check("observations_discovery_modality_check", oneOf(table.discoveryModality, DISCOVERY_MODALITY_VALUES)),
  ],
);

export const insertObservationSchema = createInsertSchema(observationsTable).omit({ id: true, observedAt: true });
export type InsertObservation = z.infer<typeof insertObservationSchema>;
export type Observation = typeof observationsTable.$inferSelect;
