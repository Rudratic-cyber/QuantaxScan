import { Router, type IRouter } from "express";
import { gte } from "drizzle-orm";
import {
  withOrg,
  assetsTable,
  collectionRunsTable,
  collectionSchedulesTable,
  collectionScheduleRunsTable,
} from "@workspace/db";
import { summariseDrift, DEFAULT_DRIFT_WINDOW_DAYS } from "../lib/drift";
import { orgContextFor } from "../lib/principal";

const router: IRouter = Router();

/**
 * D4 — `GET /api/drift`. docs/Claude/04-architecture.md ("new/changed/resolved
 * since a timestamp"), docs/Claude/06-cisa-dashboard.md "Row 6 — Drift".
 *
 * A pure read. Every entry is derived from the `assets` lifecycle
 * (`firstSeen`, `statusChangedAt`, `statusChangedByRunId`) at request time and
 * nothing is written — a stored drift verdict would disagree with a later read
 * the moment a standard or a Q-Day scenario moved, which is the C1 failure this
 * product exists to fix. The arithmetic and every judgement call live in
 * `lib/drift.ts`, which is free of drizzle and unit-tested without a database.
 *
 * The handler's whole job is to read four tables inside one scope and hand them
 * over. No `where organization_id` appears: the policies supply it.
 */
router.get("/drift", async (req, res): Promise<void> => {
  const until = new Date();
  const raw = Array.isArray(req.query.since) ? req.query.since[0] : req.query.since;

  let since: Date;
  if (raw === undefined || raw === "") {
    since = new Date(until.getTime() - DEFAULT_DRIFT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  } else {
    since = new Date(String(raw));
    // Rejected rather than silently falling back to the default window: a
    // caller who asked for a specific window and got a different one would
    // report the wrong period, and the numbers would look plausible.
    if (Number.isNaN(since.getTime())) {
      res.status(400).json({ error: "`since` must be an ISO-8601 instant" });
      return;
    }
    if (since.getTime() > until.getTime()) {
      res.status(400).json({ error: "`since` is in the future" });
      return;
    }
  }

  const feed = await withOrg(orgContextFor(req), async (tx) => {
    // Assets are read whole rather than filtered to the window in SQL: an
    // asset qualifies on `firstSeen` OR `statusChangedAt`, and a location
    // pairing needs both halves of a change even when only one of them is in
    // range. The estate is small enough for this and the alternative is two
    // queries whose union has to be de-duplicated in memory anyway.
    const assets = await tx
      .select({
        id: assetsTable.id,
        surface: assetsTable.surface,
        algorithm: assetsTable.algorithm,
        keySize: assetsTable.keySize,
        location: assetsTable.location,
        status: assetsTable.status,
        firstSeen: assetsTable.firstSeen,
        lastSeen: assetsTable.lastSeen,
        statusChangedAt: assetsTable.statusChangedAt,
        statusChangedByRunId: assetsTable.statusChangedByRunId,
      })
      .from(assetsTable);

    // Every run, not only the ones in the window: `surfaces[].lastCollectedAt`
    // is an all-time fact, and it is what turns "this list is empty" into
    // either "nothing changed" or "nobody has looked since March".
    const runs = await tx
      .select({
        id: collectionRunsTable.id,
        surface: collectionRunsTable.surface,
        collector: collectionRunsTable.collector,
        status: collectionRunsTable.status,
        target: collectionRunsTable.target,
        startedAt: collectionRunsTable.startedAt,
        completedAt: collectionRunsTable.completedAt,
      })
      .from(collectionRunsTable);

    const schedules = await tx
      .select({
        id: collectionSchedulesTable.id,
        projectId: collectionSchedulesTable.projectId,
        targetKind: collectionSchedulesTable.targetKind,
        enabled: collectionSchedulesTable.enabled,
        intervalMinutes: collectionSchedulesTable.intervalMinutes,
        nextRunAt: collectionSchedulesTable.nextRunAt,
        lastRunAt: collectionSchedulesTable.lastRunAt,
        lastSucceededAt: collectionSchedulesTable.lastSucceededAt,
      })
      .from(collectionSchedulesTable);

    const attempts = await tx
      .select({
        id: collectionScheduleRunsTable.id,
        scheduleId: collectionScheduleRunsTable.scheduleId,
        status: collectionScheduleRunsTable.status,
        startedAt: collectionScheduleRunsTable.startedAt,
        finishedAt: collectionScheduleRunsTable.finishedAt,
        collectionRunId: collectionScheduleRunsTable.collectionRunId,
        targetsAttempted: collectionScheduleRunsTable.targetsAttempted,
        targetsObserved: collectionScheduleRunsTable.targetsObserved,
        error: collectionScheduleRunsTable.error,
      })
      .from(collectionScheduleRunsTable)
      .where(gte(collectionScheduleRunsTable.startedAt, since));

    return summariseDrift({ since, until, assets, runs, schedules, attempts });
  });

  res.json(feed);
});

export default router;
