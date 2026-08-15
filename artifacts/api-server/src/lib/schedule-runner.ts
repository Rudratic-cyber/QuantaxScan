import { and, eq, lte } from "drizzle-orm";
import {
  collectionSchedulesTable,
  collectionScheduleRunsTable,
  projectRepoId,
  type CollectionSchedule,
  type ScheduleRunStatus,
} from "@workspace/db/schema";
import type { ScopedTx } from "@workspace/db/org-scope";
import type { OrgContext, OrgScope } from "@workspace/db/org-scope";
import { probeTlsTargets, type TlsProbeOutcome } from "./tls-probe";
import { ingestTlsObservations } from "./asset-ingest";
import { logger } from "./logger";

/**
 * M3 — the runner behind scheduled re-collection.
 * docs/Claude/02-roadmap.md "Phase 3 — Continuous & trustworthy".
 *
 * **There is no new collector here, and that is the design.** A schedule stores
 * the input `POST /api/projects/:id/tls` already accepts; this module replays it
 * and hands the result to `ingestTlsObservations`, which reconciles a
 * re-observation exactly as it does for a manual submission — new asset,
 * unchanged asset, `gone` asset, reactivated asset. Anything that had to change
 * inside a collector to make scheduling work would have been a misreading of the
 * ingest.
 *
 * ## Two structural rules, both load-bearing
 *
 * **1. The probe happens outside the scope.** `withOrg` holds a real database
 * transaction for its whole callback, and probing is outbound `node:tls` to
 * hosts this server does not control — up to `TLS_PROBE_TIMEOUT_MS` each. Doing
 * it inside would pin a pooled connection idle for the duration.
 * `routes/projects.ts` splits it the same way and explains why at length; this
 * module inherits both the split and the reason.
 *
 * **2. An attempt that observed nothing must not be able to mark anything
 * `gone`.** That is not a policy applied here — `ingestTlsObservations` throws
 * when handed no completed handshake, and its `reobserved` scope is built from
 * the targets that actually answered, never from the targets that were
 * submitted. So the runner cannot produce a false remediation even if this file
 * is wrong, which is the correct place for that guarantee to live. What this
 * file *does* add is the record that the attempt happened at all: without a
 * `collection_schedule_runs` row, a week of unreachable hosts is
 * indistinguishable from a quiet week, and `GET /api/drift` would report the
 * second when the truth is the first.
 *
 * ## What this is not
 *
 * Not a cross-organisation daemon. Finding due work across every tenant means
 * reading `collection_schedules` — an organisation-scoped table — outside any
 * organisation scope, which `lib/db/src/org-scope.ts` calls out as never
 * legitimate for exactly this class of table. So the entry point is
 * `POST /api/collection-schedules/run-due`, org-scoped, executing the caller's
 * own due schedules; an external scheduler calls it per organisation with that
 * organisation's credential. Wiring an in-process timer needs a per-organisation
 * credential the deployment does not have yet — see docs/Claude/03-features.md
 * §D4.
 */

/** Never execute more than this many schedules in one `run-due` call. A bound on egress and on request duration, not on how much work exists. */
export const MAX_SCHEDULES_PER_RUN = 10;

export interface ScheduleExecution {
  scheduleId: number;
  projectId: number;
  targetKind: string;
  status: ScheduleRunStatus;
  scheduleRunId: number;
  collectionRunId: number | null;
  targetsAttempted: number;
  targetsObserved: number;
  observationsCreated: number;
  assetsCreated: number;
  assetsMarkedGone: number;
  targets: Array<{ host: string; port: number; outcome: string }>;
  error: string | null;
  nextRunAt: string;
}

/**
 * The collector step, isolated so it can be substituted in a unit test without
 * a socket. Production passes `probeTlsTargets`.
 */
export interface ScheduleRunnerDeps {
  probe: (targets: Array<{ host: string; port: number }>) => Promise<TlsProbeOutcome[]>;
  now: () => Date;
}

export const defaultScheduleRunnerDeps: ScheduleRunnerDeps = {
  probe: probeTlsTargets,
  now: () => new Date(),
};

/** Due = enabled and past its next run time. A disabled schedule is never due, however far past its time it is. */
export function dueSchedules(tx: ScopedTx, at: Date, limit = MAX_SCHEDULES_PER_RUN) {
  return tx
    .select()
    .from(collectionSchedulesTable)
    .where(and(eq(collectionSchedulesTable.enabled, true), lte(collectionSchedulesTable.nextRunAt, at)))
    .orderBy(collectionSchedulesTable.nextRunAt)
    .limit(limit);
}

function advance(from: Date, intervalMinutes: number): Date {
  return new Date(from.getTime() + intervalMinutes * 60_000);
}

/**
 * Execute one schedule.
 *
 * Takes the `OrgScope` rather than a `ScopedTx` because it deliberately opens
 * its scope *after* the probe (see the header) — and scopes do not nest, so a
 * caller must not already hold one when it calls this.
 */
export async function executeSchedule(
  scope: Pick<OrgScope, "withOrg">,
  ctx: OrgContext,
  schedule: CollectionSchedule,
  deps: ScheduleRunnerDeps = defaultScheduleRunnerDeps,
): Promise<ScheduleExecution> {
  const startedAt = deps.now();
  const targets = schedule.target.targets;

  let outcomes: TlsProbeOutcome[] = [];
  let probeError: string | null = null;
  try {
    // `targetKind` is CHECKed to `tls` at the database level, so there is no
    // other branch to take today. When a second kind lands it dispatches here,
    // and the exhaustiveness is what will make that a compile error rather than
    // a silent no-op.
    outcomes = await deps.probe(targets);
  } catch (error) {
    probeError = error instanceof Error ? error.message : String(error);
  }

  const probed = outcomes.filter((o): o is Extract<TlsProbeOutcome, { outcome: "probed" }> => o.outcome === "probed");
  const targetSummary = outcomes.map((o) => ({ host: o.host, port: o.port, outcome: o.outcome }));

  return scope.withOrg(ctx, async (tx) => {
    let status: ScheduleRunStatus;
    let error: string | null = probeError;
    let collectionRunId: number | null = null;
    let observationsCreated = 0;
    let assetsCreated = 0;
    let assetsMarkedGone = 0;

    if (probeError !== null) {
      status = "failed";
    } else if (probed.length === 0) {
      // Real, common, and NOT an error: every target may legitimately be
      // unreachable or refused on a given day. No `collection_runs` row is
      // written — that would make the D3 coverage meter report this surface as
      // "examined, nothing found" — and no asset is reconciled, so nothing can
      // be marked `gone` by an attempt that saw nothing.
      status = "no_evidence";
    } else {
      // Deliberately not wrapped in a try/catch. An ingest failure has already
      // aborted this transaction, so a `collection_schedule_runs` row written
      // after it would roll back along with everything else — recording the
      // attempt has to happen in a *fresh* scope, which is `runDueSchedules`'s
      // job below.
      const result = await ingestTlsObservations(tx, {
        repo: projectRepoId(schedule.projectId),
        probed: probed.map((p) => ({ host: p.host, port: p.port, handshake: p.handshake })),
        organizationId: ctx.organizationId,
      });
      status = "succeeded";
      collectionRunId = result.collectionRunId;
      observationsCreated = result.observationsCreated;
      assetsCreated = result.assetsCreated;
      assetsMarkedGone = result.assetsMarkedGone;
    }

    const finishedAt = deps.now();
    const nextRunAt = advance(finishedAt, schedule.intervalMinutes);

    const [scheduleRun] = await tx
      .insert(collectionScheduleRunsTable)
      .values({
        organizationId: ctx.organizationId,
        scheduleId: schedule.id,
        status,
        startedAt,
        finishedAt,
        collectionRunId,
        targetsAttempted: targets.length,
        targetsObserved: probed.length,
        detail: { targets: targetSummary },
        error,
      })
      .returning();

    await tx
      .update(collectionSchedulesTable)
      .set({
        // Advanced whatever the outcome. A permanently unreachable host must
        // not be retried on every poll — that turns one broken schedule into a
        // hot loop of outbound connections, and the failure is already visible
        // in the attempt log.
        nextRunAt,
        lastRunAt: finishedAt,
        // Only a run that produced evidence moves this. The gap between
        // `lastRunAt` and `lastSucceededAt` is what tells a reader their estate
        // has not actually been looked at for a week.
        ...(status === "succeeded" ? { lastSucceededAt: finishedAt } : {}),
        updatedAt: finishedAt,
      })
      .where(eq(collectionSchedulesTable.id, schedule.id));

    return {
      scheduleId: schedule.id,
      projectId: schedule.projectId,
      targetKind: schedule.targetKind,
      status,
      scheduleRunId: scheduleRun.id,
      collectionRunId,
      targetsAttempted: targets.length,
      targetsObserved: probed.length,
      observationsCreated,
      assetsCreated,
      assetsMarkedGone,
      targets: targetSummary,
      error,
      nextRunAt: nextRunAt.toISOString(),
    };
  });
}

/**
 * Execute every schedule of one organisation that is due, in order of how long
 * it has been waiting.
 *
 * Three scopes, not one, and deliberately: a claim of due work, then one scope
 * per execution. Holding a transaction open across every probe would pin a
 * connection for minutes; and a failure probing the third target must not roll
 * back the first two schedules' real observations.
 */
export async function runDueSchedules(
  scope: Pick<OrgScope, "withOrg">,
  ctx: OrgContext,
  deps: ScheduleRunnerDeps = defaultScheduleRunnerDeps,
): Promise<{ due: number; executed: ScheduleExecution[] }> {
  const at = deps.now();
  const due = await scope.withOrg(ctx, (tx) => dueSchedules(tx, at));

  const executed: ScheduleExecution[] = [];
  for (const schedule of due) {
    try {
      executed.push(await executeSchedule(scope, ctx, schedule, deps));
    } catch (error) {
      // The execution's own transaction rolled back, so nothing it may have
      // half-written survives. Record the attempt in a fresh scope — an attempt
      // nobody can see is exactly the silence this feature exists to remove —
      // and carry on with the remaining schedules.
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ scheduleId: schedule.id, err: error }, "scheduled re-collection failed");
      const recorded = await scope.withOrg(ctx, async (tx) => {
        const finishedAt = deps.now();
        const [row] = await tx
          .insert(collectionScheduleRunsTable)
          .values({
            organizationId: ctx.organizationId,
            scheduleId: schedule.id,
            status: "failed",
            startedAt: at,
            finishedAt,
            targetsAttempted: schedule.target.targets.length,
            targetsObserved: 0,
            error: message,
          })
          .returning();
        await tx
          .update(collectionSchedulesTable)
          .set({ nextRunAt: advance(finishedAt, schedule.intervalMinutes), lastRunAt: finishedAt, updatedAt: finishedAt })
          .where(eq(collectionSchedulesTable.id, schedule.id));
        return { row, finishedAt };
      });
      executed.push({
        scheduleId: schedule.id,
        projectId: schedule.projectId,
        targetKind: schedule.targetKind,
        status: "failed",
        scheduleRunId: recorded.row.id,
        collectionRunId: null,
        targetsAttempted: schedule.target.targets.length,
        targetsObserved: 0,
        observationsCreated: 0,
        assetsCreated: 0,
        assetsMarkedGone: 0,
        targets: [],
        error: message,
        nextRunAt: advance(recorded.finishedAt, schedule.intervalMinutes).toISOString(),
      });
    }
  }

  return { due: due.length, executed };
}
