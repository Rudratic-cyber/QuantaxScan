import { describe, it, expect } from "vitest";
import { summariseDrift, type DriftAssetRow, type DriftRunRow, type DriftScheduleRow, type DriftScheduleAttemptRow } from "./drift";

/**
 * D4 — the arithmetic and, much more importantly, the refusals.
 *
 * Most of what follows is negative. A drift feed that reports everything it can
 * think of is easy and worthless; the whole value is in what it declines to
 * say, and every one of those refusals is a line of code somebody could delete
 * without any positive test noticing.
 */

const SINCE = new Date("2026-08-08T00:00:00Z");
const UNTIL = new Date("2026-08-15T00:00:00Z");
const BEFORE_WINDOW = new Date("2026-07-01T00:00:00Z");

function asset(overrides: Partial<DriftAssetRow> & { id: number }): DriftAssetRow {
  return {
    surface: "tls",
    algorithm: "RSA",
    keySize: 2048,
    location: "project:1:host.test:443",
    status: "active",
    firstSeen: BEFORE_WINDOW,
    lastSeen: BEFORE_WINDOW,
    statusChangedAt: null,
    statusChangedByRunId: null,
    ...overrides,
  };
}

function run(overrides: Partial<DriftRunRow> & { id: number }): DriftRunRow {
  return {
    surface: "tls",
    collector: "tls-handshake",
    status: "completed",
    target: "project:1",
    startedAt: new Date("2026-08-10T00:00:00Z"),
    completedAt: new Date("2026-08-10T00:00:00Z"),
    ...overrides,
  };
}

function schedule(overrides: Partial<DriftScheduleRow> & { id: number }): DriftScheduleRow {
  return {
    projectId: 1,
    targetKind: "tls",
    enabled: true,
    intervalMinutes: 60,
    nextRunAt: new Date("2026-08-20T00:00:00Z"),
    lastRunAt: null,
    lastSucceededAt: null,
    ...overrides,
  };
}

function attempt(overrides: Partial<DriftScheduleAttemptRow> & { id: number; scheduleId: number }): DriftScheduleAttemptRow {
  return {
    status: "succeeded",
    startedAt: new Date("2026-08-10T00:00:00Z"),
    finishedAt: new Date("2026-08-10T00:00:05Z"),
    collectionRunId: 1,
    targetsAttempted: 1,
    targetsObserved: 1,
    error: null,
    ...overrides,
  };
}

function summarise(input: {
  assets?: DriftAssetRow[];
  runs?: DriftRunRow[];
  schedules?: DriftScheduleRow[];
  attempts?: DriftScheduleAttemptRow[];
}) {
  return summariseDrift({
    since: SINCE,
    until: UNTIL,
    assets: input.assets ?? [],
    runs: input.runs ?? [],
    schedules: input.schedules ?? [],
    attempts: input.attempts ?? [],
  });
}

describe("what drift reports", () => {
  it("reports an asset first seen inside the window as appeared, with its obligations resolved on read", () => {
    const feed = summarise({
      assets: [asset({ id: 1, firstSeen: new Date("2026-08-10T00:00:00Z"), lastSeen: new Date("2026-08-10T00:00:00Z") })],
    });

    expect(feed.appeared).toHaveLength(1);
    expect(feed.appeared[0].assetId).toBe(1);
    expect(feed.appeared[0].appearedAt).toBe("2026-08-10T00:00:00.000Z");
    // The obligation comes from `docs/Claude/mappings/`, resolved here and
    // stored nowhere. Asserting only that it resolved — the content is
    // `lib/mappings`'s to test, and naming a deadline here would hardcode a
    // date in TypeScript, which C1 forbids.
    expect(feed.appeared[0].compliance).not.toBeNull();
  });

  it("does not report an asset that existed before the window, however recently it was re-observed", () => {
    // Re-observation is not drift. A nightly schedule moves `lastSeen` on the
    // entire estate every night; reporting that as change would drown the
    // signal the feed exists for.
    const feed = summarise({
      assets: [asset({ id: 1, firstSeen: BEFORE_WINDOW, lastSeen: new Date("2026-08-14T00:00:00Z") })],
    });
    expect(feed.appeared).toEqual([]);
    expect(feed.disappeared).toEqual([]);
    expect(feed.reappeared).toEqual([]);
  });

  it("reports a disappearance with the run that failed to observe it, and never calls it remediated", () => {
    const feed = summarise({
      assets: [
        asset({
          id: 1,
          status: "gone",
          lastSeen: new Date("2026-08-09T00:00:00Z"),
          statusChangedAt: new Date("2026-08-10T00:00:00Z"),
          statusChangedByRunId: 7,
        }),
      ],
      runs: [run({ id: 7 })],
    });

    expect(feed.disappeared).toHaveLength(1);
    const entry = feed.disappeared[0];
    expect(entry.meaning).toBe("not-observed");
    expect(entry.evidence).toEqual({
      collectionRunId: 7,
      collector: "tls-handshake",
      runCompletedAt: "2026-08-10T00:00:00.000Z",
      runTarget: "project:1",
    });
    // `lastObservedAt` is when it was last actually seen — never advanced by
    // the run that missed it, and never conflated with `notObservedAt`.
    expect(entry.lastObservedAt).toBe("2026-08-09T00:00:00.000Z");
    expect(entry.notObservedAt).toBe("2026-08-10T00:00:00.000Z");

    // The word must not appear anywhere in the serialised entry, in any field.
    expect(JSON.stringify(entry)).not.toContain("remediat");
  });

  it("reports a reappearance separately from an appearance, and never counts one asset as both", () => {
    const feed = summarise({
      assets: [
        // Created, gone and back, all inside one window. It is news once — as
        // an appearance. Counting it twice would inflate every drift number a
        // dashboard shows.
        asset({
          id: 1,
          firstSeen: new Date("2026-08-09T00:00:00Z"),
          statusChangedAt: new Date("2026-08-12T00:00:00Z"),
          statusChangedByRunId: 7,
        }),
        // Long-standing, went away before the window, back inside it.
        asset({
          id: 2,
          location: "project:1:other.test:443",
          statusChangedAt: new Date("2026-08-11T00:00:00Z"),
          statusChangedByRunId: 7,
        }),
      ],
      runs: [run({ id: 7 })],
    });

    expect(feed.appeared.map((a) => a.assetId)).toEqual([1]);
    expect(feed.reappeared.map((a) => a.assetId)).toEqual([2]);
  });

  it("pairs a departure with an arrival at the same location as a change, and refuses to pair two different locations", () => {
    const feed = summarise({
      assets: [
        asset({
          id: 1,
          algorithm: "RSA",
          keySize: 2048,
          status: "gone",
          statusChangedAt: new Date("2026-08-12T00:00:00Z"),
          statusChangedByRunId: 7,
        }),
        asset({ id: 2, algorithm: "ML-KEM-768", keySize: null, firstSeen: new Date("2026-08-12T00:00:00Z") }),
        // A brand-new asset somewhere else entirely. Pairing it with the
        // departure above would fabricate a migration that nobody performed.
        asset({ id: 3, location: "project:1:elsewhere.test:443", firstSeen: new Date("2026-08-12T00:00:00Z") }),
      ],
      runs: [run({ id: 7 })],
    });

    expect(feed.changed).toHaveLength(1);
    expect(feed.changed[0].from.assetId).toBe(1);
    expect(feed.changed[0].to.assetId).toBe(2);
    // Both halves stay in their own lists — `changed` is a view of them, not a
    // third bucket that removes them.
    expect(feed.appeared.map((a) => a.assetId)).toContain(2);
    expect(feed.disappeared.map((a) => a.assetId)).toContain(1);
  });
});

describe("what drift refuses to report — the false-positive controls", () => {
  it("never reports a disappearance for an asset that went gone before this feature existed", () => {
    // A pre-existing `gone` asset has a null `statusChangedAt`. Backfilling one
    // — with `lastSeen`, say — would flood the first feed after deployment with
    // years of history presented as this week's news.
    const feed = summarise({
      assets: [asset({ id: 1, status: "gone", statusChangedAt: null, statusChangedByRunId: null })],
    });
    expect(feed.disappeared).toEqual([]);
  });

  it("a window in which nothing was collected reports observedInWindow: false rather than a bare empty feed", () => {
    // The whole reason this lane exists. Both feeds below have empty change
    // lists; only one of them means "nothing changed".
    const nobodyLooked = summarise({
      assets: [asset({ id: 1 })],
      runs: [run({ id: 1, completedAt: BEFORE_WINDOW, startedAt: BEFORE_WINDOW })],
    });
    expect(nobodyLooked.appeared).toEqual([]);
    expect(nobodyLooked.surfaces.find((s) => s.surface === "tls")?.observedInWindow).toBe(false);
    expect(nobodyLooked.surfaces.find((s) => s.surface === "tls")?.lastCollectedAt).toBe(BEFORE_WINDOW.toISOString());

    const weLookedAndNothingChanged = summarise({
      assets: [asset({ id: 1 })],
      runs: [run({ id: 1 })],
    });
    expect(weLookedAndNothingChanged.appeared).toEqual([]);
    expect(weLookedAndNothingChanged.surfaces.find((s) => s.surface === "tls")?.observedInWindow).toBe(true);
  });

  it("a failed collection run is never counted as an examination", () => {
    // `coverage.ts` applies the same rule. An attempt is not coverage, and a
    // surface whose only run in the window failed has not been observed.
    const feed = summarise({
      assets: [asset({ id: 1 })],
      runs: [run({ id: 1, status: "failed", completedAt: null })],
    });
    const surface = feed.surfaces.find((s) => s.surface === "tls");
    expect(surface?.completedRunsInWindow).toBe(0);
    expect(surface?.observedInWindow).toBe(false);
    expect(surface?.lastCollectedAt).toBeNull();
  });

  it("a scheduled attempt that reached nothing is reported as an attempt, and produces no disappearance at all", () => {
    // The case the brief calls out: every target unreachable. There is nothing
    // in `disappeared` because no ingest ran, and the attempt is visible so the
    // silence is legible rather than mistakable for a quiet week.
    const feed = summarise({
      assets: [asset({ id: 1 })],
      schedules: [schedule({ id: 3 })],
      attempts: [
        attempt({ id: 1, scheduleId: 3, status: "no_evidence", collectionRunId: null, targetsAttempted: 2, targetsObserved: 0 }),
      ],
    });

    expect(feed.disappeared).toEqual([]);
    expect(feed.schedules.attempts).toHaveLength(1);
    expect(feed.schedules.attempts[0].status).toBe("no_evidence");
    expect(feed.schedules.attempts[0].collectionRunId).toBeNull();

    const surface = feed.surfaces.find((s) => s.surface === "tls");
    expect(surface?.unproductiveAttemptsInWindow).toBe(1);
    expect(surface?.observedInWindow).toBe(false);
  });

  it("reports a schedule that is past due and has never succeeded, because overdue work is unobserved estate", () => {
    const feed = summarise({
      schedules: [
        schedule({ id: 3, nextRunAt: new Date("2026-08-14T00:00:00Z") }),
        // Disabled. Never due, however far past its time — a paused schedule is
        // a decision, not a failure, and reporting it as overdue would train a
        // reader to ignore the list.
        schedule({ id: 4, enabled: false, nextRunAt: new Date("2026-01-01T00:00:00Z") }),
        // Not yet due.
        schedule({ id: 5, nextRunAt: new Date("2026-09-01T00:00:00Z") }),
      ],
    });

    expect(feed.schedules.overdue.map((o) => o.scheduleId)).toEqual([3]);
    expect(feed.schedules.overdue[0].minutesOverdue).toBe(24 * 60);
    expect(feed.schedules.overdue[0].neverSucceeded).toBe(true);
  });

  it("states the caveat in the payload, so a report built from this cannot quietly drop it", () => {
    const feed = summarise({});
    expect(feed.caveat).toContain("NOT a remediation");
    expect(feed.caveat).toContain("observedInWindow");
  });
});
