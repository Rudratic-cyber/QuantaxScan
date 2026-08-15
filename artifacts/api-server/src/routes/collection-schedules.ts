import { Router, type IRouter } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  withOrg,
  collectionSchedulesTable,
  collectionScheduleRunsTable,
  projectsTable,
  MIN_SCHEDULE_INTERVAL_MINUTES,
  type CollectionSchedule,
  type CollectionScheduleRun,
} from "@workspace/db";
import { CreateCollectionScheduleBody, UpdateCollectionScheduleBody } from "@workspace/api-zod";
import { runDueSchedules } from "../lib/schedule-runner";
import { orgContextFor } from "../lib/principal";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * M3 — scheduled re-collection. docs/Claude/02-roadmap.md "Phase 3 —
 * Continuous & trustworthy".
 *
 * Every handler runs inside `withOrg` and uses the `tx` it is handed; `db` is
 * not imported here at all, and the `where organization_id = ...` clauses you
 * might expect are supplied by the row-level-security policies rather than by
 * these handlers.
 *
 * The runner itself lives in `lib/schedule-runner.ts`, which explains why it
 * probes *outside* the scope and why there is no cross-organisation daemon.
 */

/** How many past attempts each schedule carries in a list response. Enough to see a pattern, not a log viewer. */
const RECENT_ATTEMPTS_PER_SCHEDULE = 5;

function attemptPayload(row: CollectionScheduleRun) {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    collectionRunId: row.collectionRunId,
    targetsAttempted: row.targetsAttempted,
    targetsObserved: row.targetsObserved,
    error: row.error,
  };
}

function schedulePayload(row: CollectionSchedule, attempts: CollectionScheduleRun[]) {
  return {
    id: row.id,
    projectId: row.projectId,
    targetKind: row.targetKind,
    target: row.target,
    intervalMinutes: row.intervalMinutes,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt.toISOString(),
    // Two facts, never collapsed into one. A schedule attempted hourly all week
    // against an unreachable host has a recent `lastRunAt` and a week-old
    // `lastSucceededAt`; showing only the first would report an unobserved
    // estate as freshly verified.
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastSucceededAt: row.lastSucceededAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    recentAttempts: attempts.map(attemptPayload),
  };
}

function parseId(raw: unknown): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = parseInt(String(value), 10);
  return Number.isInteger(id) ? id : null;
}

router.get("/collection-schedules", async (req, res): Promise<void> => {
  const payload = await withOrg(orgContextFor(req), async (tx) => {
    const schedules = await tx.select().from(collectionSchedulesTable).orderBy(desc(collectionSchedulesTable.createdAt));
    if (schedules.length === 0) return [];

    // One query for every schedule's attempts, trimmed per schedule in memory.
    // No `where organization_id` here either — the policy is what scopes it.
    const attempts = await tx
      .select()
      .from(collectionScheduleRunsTable)
      .where(
        inArray(
          collectionScheduleRunsTable.scheduleId,
          schedules.map((s) => s.id),
        ),
      )
      .orderBy(desc(collectionScheduleRunsTable.startedAt));

    const bySchedule = new Map<number, CollectionScheduleRun[]>();
    for (const attempt of attempts) {
      const held = bySchedule.get(attempt.scheduleId) ?? [];
      if (held.length < RECENT_ATTEMPTS_PER_SCHEDULE) held.push(attempt);
      bySchedule.set(attempt.scheduleId, held);
    }

    return schedules.map((s) => schedulePayload(s, bySchedule.get(s.id) ?? []));
  });

  res.json(payload);
});

router.post("/collection-schedules", async (req, res): Promise<void> => {
  const parsed = CreateCollectionScheduleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { projectId, targetKind, targets, intervalMinutes, enabled } = parsed.data;

  // Belt and braces with the database CHECK. The generated zod carries the
  // minimum too, but the number lives in one place — `lib/db`'s
  // `MIN_SCHEDULE_INTERVAL_MINUTES` — so a spec edit that loosened it would
  // still be refused here rather than reaching a constraint violation.
  if (intervalMinutes < MIN_SCHEDULE_INTERVAL_MINUTES) {
    res.status(400).json({ error: `intervalMinutes must be at least ${MIN_SCHEDULE_INTERVAL_MINUTES}` });
    return;
  }

  const ctx = orgContextFor(req);
  const schedule = await withOrg(ctx, async (tx) => {
    // `collection_schedules.project_id` IS a real foreign key — and a foreign
    // key is checked with row-level security bypassed, so PostgreSQL would
    // happily accept another organisation's project id here. The parent has to
    // be confirmed visible *inside* the scope, exactly as `POST /scans` and
    // every collector submission route do.
    const [parent] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!parent) return null;

    const [row] = await tx
      .insert(collectionSchedulesTable)
      .values({
        organizationId: ctx.organizationId,
        projectId,
        targetKind,
        target: { targets },
        intervalMinutes,
        enabled: enabled ?? true,
        // Due immediately. A schedule created now and first collected in an
        // hour would leave a window in which the product claims to be watching
        // something it has never looked at.
        nextRunAt: new Date(),
      })
      .returning();
    return row;
  });

  if (schedule === null) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.status(201).json(schedulePayload(schedule, []));
});

/**
 * The runner's entry point. Org-scoped, so an external scheduler calls it once
 * per organisation with that organisation's credential — see
 * `lib/schedule-runner.ts` for why there is no cross-organisation daemon.
 *
 * Registered before `/collection-schedules/:id` would be, and there is no
 * `POST /collection-schedules/:id`, so `run-due` cannot be shadowed by an id
 * route.
 */
router.post("/collection-schedules/run-due", async (req, res): Promise<void> => {
  const ctx = orgContextFor(req);
  const ranAt = new Date();
  const { due, executed } = await runDueSchedules({ withOrg }, ctx);

  logger.info(
    {
      due,
      executed: executed.length,
      succeeded: executed.filter((e) => e.status === "succeeded").length,
      route: "POST /collection-schedules/run-due",
    },
    "scheduled re-collection complete",
  );

  res.json({ ranAt: ranAt.toISOString(), due, executed });
});

/**
 * PATCH, not PUT: a schedule is adjusted a field at a time — paused, re-cadenced,
 * or pointed at a corrected target list. Presence in `parsed.data`, not
 * truthiness, decides what changes, the same idiom `PATCH /ot-fleets/:id` uses.
 */
router.patch("/collection-schedules/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid schedule ID" });
    return;
  }

  const parsed = UpdateCollectionScheduleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const data = parsed.data;
  if (data.intervalMinutes !== undefined && data.intervalMinutes < MIN_SCHEDULE_INTERVAL_MINUTES) {
    res.status(400).json({ error: `intervalMinutes must be at least ${MIN_SCHEDULE_INTERVAL_MINUTES}` });
    return;
  }

  const updates: Partial<typeof collectionSchedulesTable.$inferInsert> = {};
  if (data.targets !== undefined) updates.target = { targets: data.targets };
  if (data.intervalMinutes !== undefined) updates.intervalMinutes = data.intervalMinutes;
  if (data.enabled !== undefined) updates.enabled = data.enabled;

  const ctx = orgContextFor(req);
  const result = await withOrg(ctx, async (tx) => {
    const row =
      Object.keys(updates).length === 0
        ? (await tx.select().from(collectionSchedulesTable).where(eq(collectionSchedulesTable.id, id)))[0]
        : (
            await tx
              .update(collectionSchedulesTable)
              .set({ ...updates, updatedAt: new Date() })
              .where(eq(collectionSchedulesTable.id, id))
              .returning()
          )[0];
    if (!row) return null;

    const attempts = await tx
      .select()
      .from(collectionScheduleRunsTable)
      .where(eq(collectionScheduleRunsTable.scheduleId, row.id))
      .orderBy(desc(collectionScheduleRunsTable.startedAt))
      .limit(RECENT_ATTEMPTS_PER_SCHEDULE);
    return schedulePayload(row, attempts);
  });

  if (result === null) {
    // Another organisation's schedule is indistinguishable from one that does
    // not exist, matching every other route here.
    res.status(404).json({ error: "Schedule not found" });
    return;
  }

  res.json(result);
});

router.delete("/collection-schedules/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid schedule ID" });
    return;
  }

  // The attempt log cascades off the schedule's foreign key. Deleting a
  // schedule therefore deletes the record that its targets were ever watched —
  // which is why disabling is the documented way to pause one, and deletion is
  // for a target that should never have been there.
  await withOrg(orgContextFor(req), (tx) =>
    tx.delete(collectionSchedulesTable).where(and(eq(collectionSchedulesTable.id, id))),
  );
  res.sendStatus(204);
});

export default router;
