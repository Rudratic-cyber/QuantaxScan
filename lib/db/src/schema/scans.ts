import { pgTable, text, serial, timestamp, integer, real, index, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { oneOf } from "./sql-helpers";
import { projectsTable } from "./projects";
import { organizationsTable } from "./organizations";

/**
 * F4 — which retention regime a submission was processed under.
 *
 * `08-security.md` §"Source code handling" ranks four tiers of source handling
 * by how much trust they demand of a customer. This column is what lets the
 * product tell a customer **which tier their submission actually went through**,
 * per submission rather than as a marketing claim:
 *
 *  - `retained` — the "Acceptable" tier. The submitted body is persisted on
 *    `scans.code` and matched lines are persisted as evidence. This is what
 *    every submission before F4 did, and it is still the default, because
 *    replaying a scan and showing the offending line is what the product does.
 *  - `ephemeral` — the "Good" tier. The submission is scanned in memory and the
 *    source is not written anywhere: no `scans.code`, no `findings.code_snippet`,
 *    no `observations.evidence.codeSnippet`. The findings themselves — file,
 *    line, algorithm, severity, effort — are persisted, because they are the
 *    deliverable and none of them is source.
 *
 * The top tier ("only findings leave the customer network") is a self-hosted
 * collector and is not a mode of this API at all.
 *
 * Defined here rather than in `@workspace/collectors` for the same reason the
 * auth and vendor enums are: an on-prem collector has no concept of what this
 * SaaS retains. One const tuple, `text` + `CHECK` via `oneOf()`, never a
 * Postgres `ENUM` — the mechanism CLAUDE.md's rule protects is intact.
 */
export const RETENTION_MODE_VALUES = ["retained", "ephemeral"] as const;

export type RetentionMode = (typeof RETENTION_MODE_VALUES)[number];

/**
 * What a `findings.code_snippet` says when the scan ran under `ephemeral`.
 *
 * The column is `NOT NULL` and dropping that constraint would ripple through
 * the generated client for every consumer, so an ephemeral finding carries a
 * self-describing marker instead of an empty string. Empty would be
 * indistinguishable from "the matched line was blank"; this is unambiguous in a
 * report, and it is a fixed constant so the boundary test can assert the real
 * source is nowhere in the row.
 */
export const EPHEMERAL_SNIPPET_MARKER = "[not retained: ephemeral scan]";

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
    /** RBAC — denormalised from the project, so a policy can scope without a join. See §4.3. */
    divisionId: integer("division_id"),
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
  /**
   * F4 — the retention decision this submission was processed under, recorded
   * so a customer can be told which one their data went through.
   *
   * `NOT NULL DEFAULT 'retained'` is a deliberate exception to CLAUDE.md's
   * "null means not supplied", and the reason it is not a violation of it: this
   * is not a *measurement*. Every row written before F4 persisted its source on
   * `code`, so `'retained'` is a statement of fact about those rows rather than
   * a guessed default standing in for a value nobody supplied. A nullable
   * column here would mean "we do not know what we did with your source", which
   * is the one answer this column exists to make impossible.
   */
  retentionMode: text("retention_mode").$type<RetentionMode>().notNull().default("retained"),
  /**
   * When the source was discarded — set at insert time for an `ephemeral` scan,
   * because there is no later moment: the body is never written. Null on a
   * `retained` scan, where the source is still there.
   *
   * A separate column rather than being inferred from `retentionMode` so that a
   * future "delete the source of this old retained scan" path has somewhere
   * truthful to record itself.
   */
  sourceDiscardedAt: timestamp("source_discarded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("scans_org_idx").on(table.organizationId),
  check("scans_retention_mode_check", oneOf(table.retentionMode, RETENTION_MODE_VALUES)),
]);

export const insertScanSchema = createInsertSchema(scansTable).omit({ id: true, createdAt: true });
export type InsertScan = z.infer<typeof insertScanSchema>;
export type Scan = typeof scansTable.$inferSelect;
