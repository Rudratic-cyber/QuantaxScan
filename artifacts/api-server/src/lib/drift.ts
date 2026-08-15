import { CATALOGUE_ORDER_BY_SURFACE, catalogueEntryForSurface } from "@workspace/collectors";
import { withCompliance, type FindingCompliance } from "./compliance";

/**
 * D4 — drift, computed. docs/Claude/03-features.md §D4,
 * docs/Claude/06-cisa-dashboard.md "Row 6 — Drift",
 * docs/Claude/04-architecture.md (`GET /api/drift` — new/changed/resolved
 * since a timestamp).
 *
 * Kept pure and free of drizzle, like `coverage.ts`, so the judgement calls
 * below are unit-testable without a database. **Nothing here is persisted.**
 * A drift verdict written to a row would be the exact C1 failure this project
 * exists to fix: standards and Q-Day scenarios move, so an "urgent" recorded in
 * 2026 would still read urgent in 2028 after the deadline that made it urgent
 * had passed. Every obligation on an entry below is resolved through
 * `@workspace/mappings` on the way out, at one `asOf` for the whole response.
 *
 * ---
 *
 * ## The one thing this module must never do
 *
 * **It must never report a remediation that did not happen.** "This asset is
 * gone" can mean the vulnerable line was deleted — or it can mean the collector
 * did not run, the credential expired, the host was behind a firewall that day,
 * or nobody repeated the submission. Telling a CISO a risk is closed when it is
 * not is worse than telling them nothing, because they will stop looking.
 *
 * B3 established the rule at ingest level: an unreachable host is not marked
 * `gone`, because a timeout is not evidence of absence (`ReobservationScope` in
 * `asset-ingest.ts`). This module preserves that distinction on the way out,
 * three ways:
 *
 *   1. **Nothing is called remediated.** `remediated` is a status a human sets;
 *      an unobserved asset is `disappeared`, and every entry carries the word
 *      `not-observed` in its own payload rather than leaving the reader to
 *      infer a meaning.
 *   2. **Every disappearance names the run that missed it.** A disappearance
 *      with no `notObservedByRunId` cannot be produced by this code path at all
 *      — `assets.status_changed_by_run_id` is stamped by the same statement
 *      that sets `gone`. So a reader can always check that a real collection
 *      happened, and an assertion in a report can cite it.
 *   3. **Silence is qualified, never returned bare.** `surfaces[]` states, per
 *      surface, when it was last successfully collected and whether that
 *      happened inside the window. An empty `appeared`/`disappeared` list next
 *      to `observedInWindow: false` means *nobody looked* — a completely
 *      different statement from *nothing changed*, and distinguishing the two
 *      is the entire reason this lane exists.
 *
 * Attempts that produced nothing are reported too (`schedules.attempts`), so a
 * week of failed probes is visible as a week of failed probes rather than as a
 * quiet week.
 */

export interface DriftAssetRow {
  id: number;
  surface: string;
  algorithm: string;
  keySize: number | null;
  location: string;
  status: string;
  firstSeen: Date | string;
  lastSeen: Date | string;
  /** Null when the asset has never left the status it was created in. */
  statusChangedAt: Date | string | null;
  /** The run that observed, or failed to observe, it at the transition. Null with `statusChangedAt`. */
  statusChangedByRunId: number | null;
}

export interface DriftRunRow {
  id: number;
  surface: string;
  collector: string;
  status: string;
  target: string | null;
  startedAt: Date | string;
  completedAt: Date | string | null;
}

export interface DriftScheduleRow {
  id: number;
  projectId: number;
  targetKind: string;
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: Date | string;
  lastRunAt: Date | string | null;
  lastSucceededAt: Date | string | null;
}

export interface DriftScheduleAttemptRow {
  id: number;
  scheduleId: number;
  status: string;
  startedAt: Date | string;
  finishedAt: Date | string | null;
  collectionRunId: number | null;
  targetsAttempted: number;
  targetsObserved: number;
  error: string | null;
}

/** Common shape for every asset an entry is about. Never carries a stored verdict. */
export interface DriftAsset {
  assetId: number;
  surface: string;
  surfaceId: string | null;
  algorithm: string;
  keySize: number | null;
  location: string;
  status: string;
  firstSeen: string;
  lastSeen: string;
  /** Resolved on read through C1. Null for an algorithm the mapping data does not know — never an invented obligation. */
  compliance: FindingCompliance | null;
}

export interface DriftAppearance extends DriftAsset {
  /** When this asset was first observed. Inside the window, by construction. */
  appearedAt: string;
}

/**
 * What the evidence for a disappearance actually is. Nullable only because a
 * `collection_runs` row can be pruned; the id is always present.
 */
export interface DriftNotObservedEvidence {
  collectionRunId: number;
  collector: string | null;
  runCompletedAt: string | null;
  runTarget: string | null;
}

export interface DriftDisappearance extends DriftAsset {
  /**
   * Deliberately a fixed literal rather than a free-text label: it is the
   * single statement this payload is allowed to make about an absence, and it
   * is not "remediated". A consumer that wants to claim remediation has to say
   * so in its own voice, having read `evidence` first.
   */
  meaning: "not-observed";
  /** When the collection that did not find it ran. Not when the asset stopped existing — nobody knows that. */
  notObservedAt: string;
  /** When it was last actually observed. Never advanced by the run that missed it. */
  lastObservedAt: string;
  evidence: DriftNotObservedEvidence | null;
}

export interface DriftReappearance extends DriftAsset {
  reappearedAt: string;
  evidence: DriftNotObservedEvidence | null;
}

/**
 * The same location serving different cryptography than it did — a certificate
 * rotated onto a new key type, a config directive edited, a host renegotiating.
 *
 * A correlation, computed here and stored nowhere. `fingerprint.ts` includes the
 * algorithm in an asset's identity, so a changed algorithm at one location is
 * necessarily two rows: the old one no longer observed and a new one appearing.
 * Pairing them is a read over both lists, and both halves stay in
 * `appeared`/`disappeared` as well — this is a view of them, not a third
 * category that removes them from the others.
 */
export interface DriftLocationChange {
  surface: string;
  location: string;
  from: DriftAsset;
  to: DriftAsset;
}

/**
 * Whether anybody actually looked at this surface during the window — the
 * qualifier that stops an empty feed being read as "nothing changed".
 */
export interface SurfaceObservability {
  surface: string;
  surfaceId: string | null;
  /** Completed collection runs inside the window. Zero means no examination happened, whatever the change lists say. */
  completedRunsInWindow: number;
  /** Scheduled attempts inside the window that produced no evidence at all (`failed` or `no_evidence`). */
  unproductiveAttemptsInWindow: number;
  /** The last completed run on this surface at any time, not only in the window. Null: never examined at all. */
  lastCollectedAt: string | null;
  /**
   * The whole point of this block. False means every empty list above is empty
   * because nobody collected, not because nothing changed.
   */
  observedInWindow: boolean;
}

export interface DriftScheduleAttempt {
  id: number;
  scheduleId: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  collectionRunId: number | null;
  targetsAttempted: number;
  targetsObserved: number;
  error: string | null;
}

export interface DriftOverdueSchedule {
  scheduleId: number;
  projectId: number;
  targetKind: string;
  dueAt: string;
  minutesOverdue: number;
  lastSucceededAt: string | null;
  /** True when this schedule has never produced a successful collection at all. */
  neverSucceeded: boolean;
}

export interface DriftFeed {
  window: { since: string; until: string };
  appeared: DriftAppearance[];
  disappeared: DriftDisappearance[];
  reappeared: DriftReappearance[];
  changed: DriftLocationChange[];
  surfaces: SurfaceObservability[];
  schedules: {
    attempts: DriftScheduleAttempt[];
    /** Enabled schedules past their due time that the runner has not executed. Overdue work is unobserved estate. */
    overdue: DriftOverdueSchedule[];
  };
  /** Stated in the payload rather than only in the docs, so a report built from this can quote it. */
  caveat: string;
}

export const DRIFT_CAVEAT =
  "An asset listed under `disappeared` was not observed by the collection run named in its `evidence` — that is all " +
  "this says. It is NOT a remediation: a collector that did not run, a credential that expired, a host behind a " +
  "firewall and a submission nobody repeated all produce the same absence, and only a human who has checked can call " +
  "one of them fixed. Read `surfaces[]` before reading any list as empty: a surface with `observedInWindow: false` " +
  "was not collected during this window, so nothing about it changed as far as anyone here knows — which is a " +
  "different statement from nothing having changed.";

export const DEFAULT_DRIFT_WINDOW_DAYS = 7;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function inWindow(value: Date | string | null, sinceMs: number, untilMs: number): boolean {
  if (value === null) return false;
  const at = toMillis(value);
  return at >= sinceMs && at <= untilMs;
}

export function summariseDrift(input: {
  since: Date;
  until: Date;
  assets: DriftAssetRow[];
  runs: DriftRunRow[];
  schedules: DriftScheduleRow[];
  attempts: DriftScheduleAttemptRow[];
  /** One instant for the whole response, so two entries can never land on different sides of a deadline. */
  asOf?: Date;
}): DriftFeed {
  const { assets, runs, schedules, attempts } = input;
  const sinceMs = input.since.getTime();
  const untilMs = input.until.getTime();
  const asOf = input.asOf ?? input.until;

  const runById = new Map(runs.map((r) => [r.id, r]));

  const evidenceFor = (runId: number | null): DriftNotObservedEvidence | null => {
    if (runId === null) return null;
    const run = runById.get(runId);
    // The id is reported even when the run row is not in this read's set — a
    // dangling id is still auditable, and inventing evidence for it would not be.
    return {
      collectionRunId: runId,
      collector: run?.collector ?? null,
      runCompletedAt: run?.completedAt != null ? toIso(run.completedAt) : null,
      runTarget: run?.target ?? null,
    };
  };

  const describe = (asset: DriftAssetRow): DriftAsset =>
    withCompliance(
      {
        assetId: asset.id,
        surface: asset.surface,
        surfaceId: catalogueEntryForSurface(asset.surface)?.id ?? null,
        algorithm: asset.algorithm,
        keySize: asset.keySize,
        location: asset.location,
        status: asset.status,
        firstSeen: toIso(asset.firstSeen),
        lastSeen: toIso(asset.lastSeen),
      },
      { asOf },
    );

  const appeared: DriftAppearance[] = assets
    .filter((a) => inWindow(a.firstSeen, sinceMs, untilMs))
    .map((a) => ({ ...describe(a), appearedAt: toIso(a.firstSeen) }));

  const appearedIds = new Set(appeared.map((a) => a.assetId));

  const disappeared: DriftDisappearance[] = assets
    .filter((a) => a.status === "gone" && inWindow(a.statusChangedAt, sinceMs, untilMs))
    .map((a) => ({
      ...describe(a),
      meaning: "not-observed" as const,
      notObservedAt: toIso(a.statusChangedAt as Date | string),
      lastObservedAt: toIso(a.lastSeen),
      evidence: evidenceFor(a.statusChangedByRunId),
    }));

  const reappeared: DriftReappearance[] = assets
    .filter(
      (a) =>
        a.status === "active" &&
        inWindow(a.statusChangedAt, sinceMs, untilMs) &&
        // An asset created inside this window is news as an *appearance*.
        // Reporting it as a reappearance too would double-count a single
        // story and inflate every drift count a dashboard shows.
        !appearedIds.has(a.id),
    )
    .map((a) => ({
      ...describe(a),
      reappearedAt: toIso(a.statusChangedAt as Date | string),
      evidence: evidenceFor(a.statusChangedByRunId),
    }));

  // Pair a departure with an arrival at the same (surface, location). Keyed on
  // both because `location` alone is not unique across surfaces — a config
  // path and a certificate location are different namespaces.
  const changed: DriftLocationChange[] = [];
  const appearedByLocation = new Map<string, DriftAppearance[]>();
  for (const entry of appeared) {
    const key = `${entry.surface} ${entry.location}`;
    const held = appearedByLocation.get(key);
    if (held) held.push(entry);
    else appearedByLocation.set(key, [entry]);
  }
  for (const departure of disappeared) {
    const arrivals = appearedByLocation.get(`${departure.surface} ${departure.location}`) ?? [];
    for (const arrival of arrivals) {
      // Same algorithm at the same location is not a change — it is the same
      // asset re-fingerprinted, which should not happen, and reporting it as a
      // migration would be a fabricated event.
      if (arrival.algorithm === departure.algorithm && arrival.keySize === departure.keySize) continue;
      changed.push({ surface: departure.surface, location: departure.location, from: departure, to: arrival });
    }
  }

  // ── Observability, per surface ─────────────────────────────────────────────
  // Built over every surface that has an asset, a run or a schedule, so a
  // surface whose only news is "we tried and failed" still gets a row.
  const observability = new Map<string, SurfaceObservability>();
  const surfaceEntry = (surface: string): SurfaceObservability => {
    let held = observability.get(surface);
    if (held === undefined) {
      held = {
        surface,
        surfaceId: catalogueEntryForSurface(surface)?.id ?? null,
        completedRunsInWindow: 0,
        unproductiveAttemptsInWindow: 0,
        lastCollectedAt: null,
        observedInWindow: false,
      };
      observability.set(surface, held);
    }
    return held;
  };

  for (const asset of assets) surfaceEntry(asset.surface);

  for (const run of runs) {
    const entry = surfaceEntry(run.surface);
    // A `failed` or still-`running` row is an attempt, not an examination —
    // the same rule `coverage.ts` applies, for the same reason.
    if (run.status !== "completed") continue;
    const at = run.completedAt ?? run.startedAt;
    const iso = toIso(at);
    if (entry.lastCollectedAt === null || iso > entry.lastCollectedAt) entry.lastCollectedAt = iso;
    if (inWindow(at, sinceMs, untilMs)) {
      entry.completedRunsInWindow += 1;
      entry.observedInWindow = true;
    }
  }

  const scheduleById = new Map(schedules.map((s) => [s.id, s]));
  // A schedule's target kind is the surface it re-collects; today the two
  // vocabularies coincide on `tls`, and a kind with no matching surface simply
  // contributes no observability row rather than inventing one.
  const surfaceOfAttempt = (attempt: DriftScheduleAttemptRow): string | null =>
    scheduleById.get(attempt.scheduleId)?.targetKind ?? null;

  const attemptsInWindow = attempts.filter((a) => inWindow(a.startedAt, sinceMs, untilMs));
  for (const attempt of attemptsInWindow) {
    if (attempt.status === "succeeded") continue;
    const surface = surfaceOfAttempt(attempt);
    if (surface === null) continue;
    surfaceEntry(surface).unproductiveAttemptsInWindow += 1;
  }

  const positionOf = (surface: string) => CATALOGUE_ORDER_BY_SURFACE.get(surface) ?? Number.MAX_SAFE_INTEGER;
  const surfaces = [...observability.values()].sort((a, b) => positionOf(a.surface) - positionOf(b.surface));

  const overdue: DriftOverdueSchedule[] = schedules
    .filter((s) => s.enabled && toMillis(s.nextRunAt) <= untilMs)
    .map((s) => ({
      scheduleId: s.id,
      projectId: s.projectId,
      targetKind: s.targetKind,
      dueAt: toIso(s.nextRunAt),
      minutesOverdue: Math.max(0, Math.round((untilMs - toMillis(s.nextRunAt)) / 60000)),
      lastSucceededAt: s.lastSucceededAt === null ? null : toIso(s.lastSucceededAt),
      neverSucceeded: s.lastSucceededAt === null,
    }))
    .sort((a, b) => b.minutesOverdue - a.minutesOverdue);

  const byTimeDesc = (a: { startedAt: string }, b: { startedAt: string }) => b.startedAt.localeCompare(a.startedAt);

  return {
    window: { since: input.since.toISOString(), until: input.until.toISOString() },
    appeared: appeared.sort((a, b) => b.appearedAt.localeCompare(a.appearedAt)),
    disappeared: disappeared.sort((a, b) => b.notObservedAt.localeCompare(a.notObservedAt)),
    reappeared: reappeared.sort((a, b) => b.reappearedAt.localeCompare(a.reappearedAt)),
    changed,
    surfaces,
    schedules: {
      attempts: attemptsInWindow
        .map((a) => ({
          id: a.id,
          scheduleId: a.scheduleId,
          status: a.status,
          startedAt: toIso(a.startedAt),
          finishedAt: a.finishedAt === null ? null : toIso(a.finishedAt),
          collectionRunId: a.collectionRunId,
          targetsAttempted: a.targetsAttempted,
          targetsObserved: a.targetsObserved,
          error: a.error,
        }))
        .sort(byTimeDesc),
      overdue,
    },
    caveat: DRIFT_CAVEAT,
  };
}
