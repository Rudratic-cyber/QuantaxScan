import { pgTable, text, serial, integer, timestamp, boolean, jsonb, index, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { oneOf, nullableAtLeast } from "./sql-helpers";
import { organizationsTable } from "./organizations";
import { projectsTable } from "./projects";

/**
 * M3 — scheduled re-collection. docs/Claude/02-roadmap.md "Phase 3 —
 * Continuous & trustworthy", docs/Claude/03-features.md §D4.
 *
 * Every collection in this product used to be a one-shot: somebody uploaded a
 * lockfile or probed a host, and the numbers were a snapshot of whenever that
 * happened. A schedule is the row that turns a target back into something the
 * product re-checks, which is the difference between a report generator and an
 * inventory of record.
 *
 * There is no new collector behind this. A schedule stores the *inputs* to a
 * collector that already exists and the runner replays them —
 * `asset-ingest.ts` already reconciles a re-observation correctly (new asset,
 * unchanged asset, reactivated asset, asset no longer present), so scheduled
 * re-collection is a caller, not a capability.
 */

/**
 * What the runner is able to re-execute **without being handed new input**,
 * which is a much smaller set than `Surface`.
 *
 * Six of the eight live surfaces are fed by a human uploading an export — a
 * lockfile, a certificate bundle, an `sshd_config`, a key inventory, a store
 * list. Re-running one of those against the *stored* submission would re-derive
 * the identical result and report it as a fresh observation, which is worse
 * than useless: it would keep `lastSeen` moving on assets nobody has looked at
 * since the original upload, and make a stale estate read as continuously
 * verified. So they are not schedulable, and the vocabulary below says so
 * rather than leaving it to a route to remember.
 *
 * `tls` is the one surface whose collector reaches out and observes the world
 * on its own — it opens a socket to a host the customer named and records what
 * that host negotiates *today*. Re-running it is a genuinely new observation.
 *
 * **Recorded exception to CLAUDE.md's "shared enums live in
 * `@workspace/collectors`" rule**, the fourth, alongside `auth-enums.ts`,
 * `classification.ts` and B9's vendor enums. `lib/collectors` is deliberately
 * dependency-free so it can ship as a standalone on-prem agent, and an on-prem
 * collector has no concept of a schedule — it is handed work, it does not
 * decide when work happens. This vocabulary describes what *the server's
 * scheduler* can replay, not what a collector observes, so it belongs on this
 * side of that boundary. The rule's mechanism is preserved exactly: one const
 * tuple, `text` + a `CHECK` built by `oneOf()`, never a Postgres `ENUM`.
 *
 * Widening this is a deliberate act. A `repo` kind (re-fetch a git remote and
 * re-run the source and dependency collectors) is the obvious next entry and is
 * the reason the column is `target_kind` rather than `surface`: adding it must
 * read as a widening, not slip in because some other surface value happened to
 * pass a `CHECK`.
 */
export const SCHEDULE_TARGET_KIND_VALUES = ["tls"] as const;

export type ScheduleTargetKind = (typeof SCHEDULE_TARGET_KIND_VALUES)[number];

/**
 * A schedule is refused below this cadence. Not a performance guard: this
 * product's only re-collectable target opens sockets to a customer's own hosts,
 * and a one-minute schedule pointed at a production endpoint is a self-inflicted
 * denial of service the customer would blame on us. Fifteen minutes is well
 * under any drift-detection requirement and well over anything that looks like
 * traffic.
 */
export const MIN_SCHEDULE_INTERVAL_MINUTES = 15;

export const collectionSchedulesTable = pgTable(
  "collection_schedules",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /** RBAC — denormalised from the project. See §4.3. */
    divisionId: integer("division_id"),
    /**
     * The project whose estate this schedule re-collects. A real foreign key,
     * unlike the `project:<id>:` location-prefix association `assets` uses —
     * a schedule is configuration, not an observation, and deleting a project
     * must take its schedules with it rather than leave a runner probing hosts
     * for something that no longer exists.
     *
     * A foreign key is **not** subject to RLS, so a route accepting this id
     * from a client must still confirm the project is visible inside the scope
     * before writing the row. See CLAUDE.md "Tenant isolation".
     */
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    targetKind: text("target_kind").$type<ScheduleTargetKind>().notNull(),
    /**
     * The collector's stored input, in the shape that collector already takes.
     * For `tls` this is `{ targets: [{ host, port }] }` — exactly the body
     * `POST /api/projects/:id/tls` accepts, validated at the application
     * boundary by the same zod schema, so a schedule cannot hold a target the
     * one-shot route would have rejected.
     */
    target: jsonb("target").$type<ScheduleTarget>().notNull(),
    intervalMinutes: integer("interval_minutes").notNull(),
    /**
     * A disabled schedule is never due. Kept rather than deleted so a customer
     * can pause a noisy target without losing the target list and its history.
     */
    enabled: boolean("enabled").notNull().default(true),
    /**
     * When this schedule next becomes due. Advanced by the runner after every
     * attempt — including a failed one, so a permanently unreachable host does
     * not get retried on every poll.
     */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * When the runner last *attempted* this schedule, and when it last
     * attempted one that produced evidence. Two columns rather than one because
     * the difference between them is the whole point: a schedule attempted
     * every hour for a week whose host has been unreachable all week has a
     * recent `lastRunAt` and a week-old `lastSucceededAt`, and reporting only
     * the first would make an unobserved estate look freshly verified.
     *
     * Both null until the first attempt — never defaulted to `now()`, which
     * would claim a run that never happened.
     */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastSucceededAt: timestamp("last_succeeded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("collection_schedules_org_idx").on(table.organizationId),
    // The runner's due query: enabled schedules whose next_run_at has passed.
    index("collection_schedules_org_next_run_idx").on(table.organizationId, table.nextRunAt),
    check("collection_schedules_target_kind_check", oneOf(table.targetKind, SCHEDULE_TARGET_KIND_VALUES)),
    // The column is NOT NULL, so only the `>=` branch of `nullableAtLeast()`
    // can ever apply here — reused rather than duplicated because the trap it
    // exists for (a numeric literal becoming a `$n` bind parameter, which is
    // invalid in DDL) applies identically. See sql-helpers.ts.
    check(
      "collection_schedules_interval_minutes_check",
      nullableAtLeast(table.intervalMinutes, MIN_SCHEDULE_INTERVAL_MINUTES),
    ),
  ],
);

/** The stored input for a `tls` schedule — the same shape `POST /projects/:id/tls` accepts. */
export interface TlsScheduleTarget {
  targets: Array<{ host: string; port: number }>;
}

export type ScheduleTarget = TlsScheduleTarget;

/**
 * What one attempt at one schedule produced.
 *
 * **This table is why the drift feed can be trusted.** A `gone` asset means
 * "a collection ran, its scope covered this asset, and it was not there". An
 * absence with no successful collection behind it means nothing at all — the
 * host was behind a firewall that day, the credential expired, the runner never
 * fired. Those two states look identical from the `assets` table alone, and
 * telling a CISO the second is the first is reporting a remediation that did
 * not happen.
 *
 * So every attempt is recorded, including the ones that produced nothing, and
 * `GET /api/drift` reports them alongside the changes. Silence in the feed is
 * only meaningful next to evidence that somebody looked.
 */
export const SCHEDULE_RUN_STATUS_VALUES = [
  /** The collector ran and its observations were ingested. The only status that makes an absence meaningful. */
  "succeeded",
  /**
   * The runner executed, nothing failed, and the collector had nothing it could
   * observe — every TLS target refused by the SSRF guard or unreachable. A real
   * outcome, not an error, and deliberately **not** `succeeded`: no collection
   * run is written for it (that would make the D3 meter report the surface as
   * "examined, nothing found"), and no asset may be marked `gone` because of it.
   */
  "no_evidence",
  /** The attempt itself threw. Same consequence as `no_evidence` for the estate, plus an error worth showing a human. */
  "failed",
] as const;

export type ScheduleRunStatus = (typeof SCHEDULE_RUN_STATUS_VALUES)[number];

export const collectionScheduleRunsTable = pgTable(
  "collection_schedule_runs",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    scheduleId: integer("schedule_id")
      .notNull()
      .references(() => collectionSchedulesTable.id, { onDelete: "cascade" }),
    status: text("status").$type<ScheduleRunStatus>().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /**
     * The `collection_runs` row this attempt produced, when it produced one.
     * Null for `no_evidence` and `failed`, which is the join a reader follows
     * to check that an absence has a real examination behind it.
     *
     * Not a foreign key, for the same reason `assets.statusChangedByRunId` is
     * not one: referential integrity is checked with RLS bypassed, so an FK
     * would be a cross-tenant write path, and this column is only ever written
     * with the id of a run created in the same scope moments earlier.
     */
    collectionRunId: integer("collection_run_id"),
    /**
     * How many of the schedule's stored targets the collector attempted, and how
     * many it actually observed. `targetsObserved < targetsAttempted` is the
     * shape a partially unreachable estate has, and it is reported rather than
     * collapsed into a single success/failure bit — the same discipline
     * `POST /projects/:id/tls` applies to its per-target `outcome` list.
     */
    targetsAttempted: integer("targets_attempted").notNull().default(0),
    targetsObserved: integer("targets_observed").notNull().default(0),
    /** Per-target outcomes, in the collector's own vocabulary (`probed`/`refused`/`unreachable` for TLS). */
    detail: jsonb("detail").$type<ScheduleRunDetail>(),
    /** The error, for `failed`. Null otherwise — never an empty string standing in for "no error". */
    error: text("error"),
  },
  (table) => [
    index("collection_schedule_runs_org_started_idx").on(table.organizationId, table.startedAt),
    index("collection_schedule_runs_schedule_idx").on(table.scheduleId, table.startedAt),
    check("collection_schedule_runs_status_check", oneOf(table.status, SCHEDULE_RUN_STATUS_VALUES)),
  ],
);

export interface ScheduleRunDetail {
  targets?: Array<{ host: string; port: number; outcome: string }>;
}

export const insertCollectionScheduleSchema = createInsertSchema(collectionSchedulesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCollectionSchedule = z.infer<typeof insertCollectionScheduleSchema>;
export type CollectionSchedule = typeof collectionSchedulesTable.$inferSelect;

export const insertCollectionScheduleRunSchema = createInsertSchema(collectionScheduleRunsTable).omit({
  id: true,
  startedAt: true,
});
export type InsertCollectionScheduleRun = z.infer<typeof insertCollectionScheduleRunSchema>;
export type CollectionScheduleRun = typeof collectionScheduleRunsTable.$inferSelect;
