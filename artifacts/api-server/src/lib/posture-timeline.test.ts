import { describe, it, expect } from "vitest";
import { createMappingEngine, defaultMappingData, parseMappingData, type MappingData } from "@workspace/mappings";
import {
  summarisePostureTimeline,
  type TimelineAssetRow,
  type TimelineProjectRow,
  type TimelineRunRow,
} from "./posture-timeline";

/**
 * D7's honesty rules, written down. Each assertion below corresponds to a way
 * of lying about a trend that it prevents — the same discipline `coverage.test.ts`
 * applies to the coverage meter, moved onto the time axis.
 */

const t = (iso: string) => new Date(iso);
const NOW = t("2026-08-14T00:00:00Z");

const run = (over: Partial<TimelineRunRow> & { id: number; completedAt: Date | null }): TimelineRunRow => ({
  surface: "source",
  status: "completed",
  target: "project:1",
  startedAt: over.completedAt ?? NOW,
  ...over,
});

const asset = (over: Partial<TimelineAssetRow> & { id: number; firstSeen: Date }): TimelineAssetRow => ({
  surface: "source",
  algorithm: "RSA",
  location: `project:1:file${over.id}.py`,
  status: "active",
  lastSeen: over.firstSeen,
  dataClassification: null,
  secrecyLifetimeYears: null,
  effortHours: null,
  ...over,
});

const project = (over: Partial<TimelineProjectRow> & { id: number }): TimelineProjectRow => ({
  name: `project ${over.id}`,
  dataClassification: null,
  secrecyLifetimeYears: null,
  ...over,
});

const summarise = (input: Partial<Parameters<typeof summarisePostureTimeline>[0]>) =>
  summarisePostureTimeline({
    runs: [],
    assets: [],
    projects: [project({ id: 1 })],
    now: NOW,
    ...input,
  });

describe("summarisePostureTimeline — the honest-empty states", () => {
  it("refuses to plot anything for an estate that has never been collected from", () => {
    const result = summarise({});

    expect(result.observed.sufficientForTrend).toBe(false);
    expect(result.observed.points).toEqual([]);
    expect(result.observed.distinctCollectionInstants).toBe(0);
    expect(result.observed.observedSpanDays).toBeNull();
    expect(result.observed.firstObservedAt).toBeNull();
    // "Empty, not clean" is the distinction the whole panel turns on.
    expect(result.observed.reason).toMatch(/empty inventory, not a clean one/i);
  });

  it("says plainly that one collection run is not a history", () => {
    const result = summarise({
      runs: [run({ id: 1, completedAt: t("2026-08-01T10:00:00Z") })],
      assets: [asset({ id: 1, firstSeen: t("2026-08-01T10:00:00Z") })],
    });

    expect(result.observed.distinctCollectionInstants).toBe(1);
    // The point still exists — it is a real measurement — but it must not be
    // presented as a trend, and the payload is what tells the renderer so.
    expect(result.observed.points).toHaveLength(1);
    expect(result.observed.sufficientForTrend).toBe(false);
    expect(result.observed.reason).toMatch(/a line needs two measurements/i);
    expect(result.observed.observedSpanDays).toBeNull();
  });

  it("does not invent points between two real collection instants", () => {
    // Two scans four months apart. A regular-grid implementation would emit a
    // dozen points here; only two examinations happened.
    const result = summarise({
      runs: [
        run({ id: 1, completedAt: t("2026-04-01T10:00:00Z") }),
        run({ id: 2, completedAt: t("2026-08-01T10:00:00Z") }),
      ],
      assets: [asset({ id: 1, firstSeen: t("2026-04-01T10:00:00Z") })],
    });

    expect(result.observed.points).toHaveLength(2);
    expect(result.observed.sufficientForTrend).toBe(true);
    expect(result.observed.points.map((p) => p.at)).toEqual([
      "2026-04-01T10:00:00.000Z",
      "2026-08-01T10:00:00.000Z",
    ]);
    expect(result.observed.observedSpanDays).toBe(122);
  });

  it("collapses runs written in one transaction into a single examination", () => {
    // A whole scan writes several collector runs at one instant. Counting them
    // as several points would manufacture history out of a database detail.
    const at = t("2026-05-01T10:00:00Z");
    const result = summarise({
      runs: [
        run({ id: 1, completedAt: at, surface: "source" }),
        run({ id: 2, completedAt: at, surface: "dependency" }),
      ],
      assets: [asset({ id: 1, firstSeen: at })],
    });

    expect(result.observed.distinctCollectionInstants).toBe(1);
    expect(result.observed.points[0].collectionRunIds).toEqual([1, 2]);
    expect(result.observed.points[0].surfaces).toEqual(["dependency", "source"]);
  });

  it("does not count a failed run as an examination", () => {
    // Identical to coverage.ts rule 1: an attempt is not a measurement, and a
    // failed run must never put a point on the timeline.
    const result = summarise({
      runs: [
        run({ id: 1, completedAt: t("2026-04-01T10:00:00Z") }),
        run({ id: 2, completedAt: t("2026-05-01T10:00:00Z"), status: "failed" }),
        run({ id: 3, completedAt: null, status: "running" }),
      ],
      assets: [asset({ id: 1, firstSeen: t("2026-04-01T10:00:00Z") })],
    });

    expect(result.observed.distinctCollectionInstants).toBe(1);
    expect(result.observed.completedRuns).toBe(1);
    expect(result.observed.failedRuns).toBe(1);
    expect(result.observed.sufficientForTrend).toBe(false);
  });
});

describe("summarisePostureTimeline — the observed series is real history", () => {
  it("counts only the assets that existed at each instant", () => {
    const result = summarise({
      runs: [
        run({ id: 1, completedAt: t("2026-04-01T10:00:00Z") }),
        run({ id: 2, completedAt: t("2026-08-01T10:00:00Z") }),
      ],
      assets: [
        asset({ id: 1, firstSeen: t("2026-04-01T10:00:00Z") }),
        asset({ id: 2, firstSeen: t("2026-07-01T10:00:00Z") }),
        asset({ id: 3, firstSeen: t("2026-07-02T10:00:00Z") }),
      ],
    });

    expect(result.observed.points.map((p) => p.assetsPresent)).toEqual([1, 3]);
    // The second point's growth is attributable, which is what makes the
    // scrubber's "N assets appeared here" readable rather than decorative.
    expect(result.observed.points.map((p) => p.assetsAdded)).toEqual([1, 2]);
  });

  it("stops counting an asset once it is gone, without inventing a removal date", () => {
    // `asset-ingest.ts` leaves lastSeen alone when it marks an asset gone, so
    // lastSeen is the last time it was genuinely observed. Nothing here guesses
    // an interval between that and the run that failed to find it.
    const result = summarise({
      runs: [
        run({ id: 1, completedAt: t("2026-04-01T10:00:00Z") }),
        run({ id: 2, completedAt: t("2026-08-01T10:00:00Z") }),
      ],
      assets: [
        asset({ id: 1, firstSeen: t("2026-04-01T10:00:00Z"), lastSeen: t("2026-04-01T10:00:00Z"), status: "gone" }),
        asset({ id: 2, firstSeen: t("2026-08-01T10:00:00Z") }),
      ],
    });

    expect(result.observed.points.map((p) => p.assetsPresent)).toEqual([1, 1]);
    // It is still *known* at the later instant — history keeps it, the current
    // posture does not count it. Both facts are on the point.
    expect(result.observed.points.map((p) => p.assetsKnown)).toEqual([1, 2]);
  });

  it("evaluates Mosca at each historical instant, so an earlier point has more runway", () => {
    // One RSA asset, default X of 3 years. In 2026 the conservative Q-Day of
    // 2030 is ~3.4 years out and the asset is inside its window; by 2028 the
    // same asset with the same X breaches it. Nothing about the estate changed
    // — Z did, which is exactly what the risk axis is supposed to show.
    const result = summarise({
      runs: [
        run({ id: 1, completedAt: t("2026-01-01T00:00:00Z") }),
        run({ id: 2, completedAt: t("2028-01-01T00:00:00Z") }),
      ],
      assets: [asset({ id: 1, firstSeen: t("2026-01-01T00:00:00Z") })],
      now: t("2028-06-01T00:00:00Z"),
    });

    expect(result.observed.points[0].breachedByScenario.conservative).toBe(0);
    expect(result.observed.points[1].breachedByScenario.conservative).toBe(1);
    // Three scenarios, three separate counts. Never one blended number.
    expect(Object.keys(result.observed.points[1].breachedByScenario).sort()).toEqual([
      "aggressive",
      "central",
      "conservative",
    ]);
    expect(result.observed.points[1].breachedByScenario.aggressive).toBe(0);
  });

  it("keeps classical hygiene out of the breach counts but names it", () => {
    // G-10, on the time axis: an MD5 asset must move no Mosca verdict, and must
    // not silently disappear either.
    const result = summarise({
      runs: [run({ id: 1, completedAt: t("2028-01-01T00:00:00Z") })],
      assets: [
        asset({ id: 1, firstSeen: t("2028-01-01T00:00:00Z"), algorithm: "MD5" }),
        asset({ id: 2, firstSeen: t("2028-01-01T00:00:00Z"), algorithm: "RSA" }),
      ],
      now: t("2028-06-01T00:00:00Z"),
    });

    const point = result.observed.points[0];
    expect(point.assetsPresent).toBe(2);
    expect(point.pqcAssets).toBe(1);
    expect(point.hygieneAssets).toBe(1);
    expect(point.breachedByScenario.conservative).toBe(1);
  });

  it("names an algorithm the standards data does not know rather than scoring it", () => {
    const result = summarise({
      runs: [run({ id: 1, completedAt: t("2026-08-01T10:00:00Z") })],
      assets: [asset({ id: 1, firstSeen: t("2026-08-01T10:00:00Z"), algorithm: "SOME-INTERNAL-CIPHER" })],
    });

    const point = result.observed.points[0];
    expect(point.unmappedAssets).toBe(1);
    expect(point.pqcAssets).toBe(0);
    expect(point.hygieneAssets).toBe(0);
  });

  it("ignores a run stamped after `now` instead of drawing the future as observed", () => {
    const result = summarise({
      runs: [
        run({ id: 1, completedAt: t("2026-08-01T10:00:00Z") }),
        run({ id: 2, completedAt: t("2027-01-01T10:00:00Z") }),
      ],
      assets: [asset({ id: 1, firstSeen: t("2026-08-01T10:00:00Z") })],
    });

    expect(result.observed.distinctCollectionInstants).toBe(1);
  });
});

describe("summarisePostureTimeline — projections are a different kind of claim", () => {
  it("keeps projected points out of the observed series and states its assumption", () => {
    const result = summarise({
      runs: [run({ id: 1, completedAt: t("2026-08-01T10:00:00Z") })],
      assets: [asset({ id: 1, firstSeen: t("2026-08-01T10:00:00Z") })],
    });

    expect(result.observed.points.every((p) => p.kind === "observed")).toBe(true);
    expect(result.projected.points.every((p) => p.kind === "projected")).toBe(true);
    expect(result.projected.points.every((p) => p.at > result.now)).toBe(true);
    expect(result.projected.assumption).toMatch(/Projection, not measurement/i);
    expect(result.projected.basisAt).toBe(result.now);
  });

  it("runs the horizon out to the last scenario or deadline, whichever is later", () => {
    const result = summarise({
      runs: [run({ id: 1, completedAt: t("2026-08-01T10:00:00Z") })],
      assets: [asset({ id: 1, firstSeen: t("2026-08-01T10:00:00Z") })],
    });

    const years = result.projected.points.map((p) => p.year);
    expect(years[0]).toBe(2027);
    expect(Math.max(...years)).toBeGreaterThanOrEqual(Math.max(...result.scenarios.map((s) => s.qDayYear)));
    expect(Math.max(...years)).toBeGreaterThanOrEqual(Math.max(...result.deadlines.map((d) => d.year)));
  });

  it("shows the breach count rising along the projection as runway is consumed", () => {
    const result = summarise({
      runs: [run({ id: 1, completedAt: t("2026-08-01T10:00:00Z") })],
      assets: [asset({ id: 1, firstSeen: t("2026-08-01T10:00:00Z") })],
    });

    const conservative = result.projected.points.map((p) => p.breachedByScenario.conservative);
    // Monotone by construction: the inventory is frozen and only Z moves.
    expect(conservative).toEqual([...conservative].sort((a, b) => a - b));
    expect(conservative[conservative.length - 1]).toBe(1);
  });

  it("carries the mandated Q-Day framing on the payload rather than leaving it to the renderer", () => {
    const result = summarise({});
    expect(result.framing).toMatch(/not predictions about when a quantum computer will exist/i);
  });
});

describe("summarisePostureTimeline — deadlines come from the mapping data, not from this file", () => {
  const withOneRsaAsset = () =>
    summarise({
      runs: [run({ id: 1, completedAt: t("2026-08-01T10:00:00Z") })],
      assets: [asset({ id: 1, firstSeen: t("2026-08-01T10:00:00Z"), algorithm: "RSA" })],
    });

  it("emits a marker per obligation deadline covering an algorithm actually in the estate", () => {
    const result = withOneRsaAsset();

    expect(result.deadlines.length).toBeGreaterThan(0);
    for (const marker of result.deadlines) {
      expect(marker.algorithms).toContain("RSA");
      expect(marker.assets).toBeGreaterThan(0);
      expect(marker.citation.url).toMatch(/^https?:\/\//);
      expect(marker.requirement.length).toBeGreaterThan(0);
    }
  });

  it("reads `after: <year>` as binding from 1 January of the following year", () => {
    // The vocabulary's own semantics, from algorithms.json's deadlineTypes
    // block: "after" means once that year has passed.
    const result = withOneRsaAsset();
    const deprecation = result.deadlines.find((d) => d.type === "deprecated");
    expect(deprecation).toBeDefined();
    expect(deprecation!.effectiveFrom).toBe(`${deprecation!.year}-01-01T00:00:00.000Z`);
    expect(deprecation!.inEffect).toBe(false);
  });

  it("emits no marker at all for an estate with no assets", () => {
    // A deadline the customer has no exposure to is not their deadline. The
    // markers are a property of the inventory, not a calendar we ship.
    expect(summarise({}).deadlines).toEqual([]);
  });

  /**
   * The C1 acceptance criterion, applied to D7. Mutate a clone of the standards
   * data, and the markers must follow. If this test ever needs a code edit in
   * `posture-timeline.ts` to pass, a date has been hardcoded there.
   */
  it("moves every marker when the standards data moves — no year is written in TypeScript", () => {
    const before = withOneRsaAsset();
    const baselineYears = before.deadlines.map((d) => d.year).sort((a, b) => a - b);

    // The same path a standards-data pull request takes, exactly as
    // `lib/mappings/src/engine.test.ts` does it: edit a copy of the JSON and
    // rebuild the engine over it. No TypeScript changes.
    const mutated = JSON.parse(JSON.stringify(defaultMappingData)) as MappingData;
    for (const algorithm of mutated.algorithms.algorithms) {
      for (const deadline of algorithm.deadlines) {
        if (deadline.after !== undefined) deadline.after = String(Number(deadline.after) + 7);
        if (deadline.in !== undefined) deadline.in = String(Number(deadline.in) + 7);
      }
    }
    const shiftedEngine = createMappingEngine(parseMappingData(mutated.algorithms, mutated.frameworks));

    const after = summarise({
      runs: [run({ id: 1, completedAt: t("2026-08-01T10:00:00Z") })],
      assets: [asset({ id: 1, firstSeen: t("2026-08-01T10:00:00Z"), algorithm: "RSA" })],
      resolveAlgorithm: (algorithm) => shiftedEngine.resolve({ algorithm }, { asOf: NOW }),
    });

    expect(after.deadlines.map((d) => d.year).sort((a, b) => a - b)).toEqual(
      baselineYears.map((y) => y + 7),
    );
    // And the projection horizon follows the data too, rather than a constant.
    expect(Math.max(...after.projected.points.map((p) => p.year))).toBeGreaterThanOrEqual(
      Math.max(...after.deadlines.map((d) => d.year)),
    );
  });
});

describe("summarisePostureTimeline — the estate roll-up", () => {
  it("attributes assets by the project: prefix without letting project 1 swallow project 10", () => {
    // `project:1` is a textual prefix of `project:10`. Matching without the
    // trailing colon silently moves ten projects' assets into one, and every
    // number downstream is wrong with no error anywhere.
    const result = summarise({
      runs: [run({ id: 1, completedAt: t("2026-08-01T10:00:00Z") })],
      projects: [project({ id: 1 }), project({ id: 10 })],
      assets: [
        asset({ id: 1, firstSeen: t("2026-08-01T10:00:00Z"), location: "project:1:a.py" }),
        asset({ id: 2, firstSeen: t("2026-08-01T10:00:00Z"), location: "project:10:b.py" }),
        asset({ id: 3, firstSeen: t("2026-08-01T10:00:00Z"), location: "project:10:c.py" }),
      ],
    });

    expect(result.estate.projects).toEqual([
      { id: 10, name: "project 10", assets: 2, presentAssets: 2 },
      { id: 1, name: "project 1", assets: 1, presentAssets: 1 },
    ]);
  });

  it("counts assets belonging to no project rather than dropping them from the estate", () => {
    // tls, certificate and kms assets have no project at all. An estate view
    // that quietly excluded them would under-report the estate.
    const result = summarise({
      runs: [run({ id: 1, completedAt: t("2026-08-01T10:00:00Z") })],
      assets: [
        asset({ id: 1, firstSeen: t("2026-08-01T10:00:00Z"), location: "project:1:a.py" }),
        asset({ id: 2, firstSeen: t("2026-08-01T10:00:00Z"), surface: "tls", location: "api.example.com:443" }),
      ],
    });

    expect(result.estate.unassociatedAssets).toBe(1);
    expect(result.estate.totalAssets).toBe(2);
    expect(result.estate.presentAssets).toBe(2);
    // ...and they are still scored, which is the point of counting them.
    expect(result.observed.points[0].assetsPresent).toBe(2);
  });
});

describe("summarisePostureTimeline — the inputs behind the verdicts", () => {
  it("marks a defaulted X as assumed, per asset, with its basis sentence", () => {
    const result = summarise({
      runs: [run({ id: 1, completedAt: t("2026-08-01T10:00:00Z") })],
      assets: [
        asset({ id: 1, firstSeen: t("2026-08-01T10:00:00Z") }),
        asset({ id: 2, firstSeen: t("2026-08-01T10:00:00Z"), secrecyLifetimeYears: 25 }),
      ],
    });

    expect(result.inputs.secrecyLifetime.assumedForAssets).toBe(1);
    expect(result.inputs.secrecyLifetime.bySource).toEqual({ default: 1, asset: 1 });
    expect(result.inputs.secrecyLifetime.bases.some((b) => /Assumed, not supplied/i.test(b))).toBe(true);
  });

  it("inherits a project's classification and says the value came from the project", () => {
    const result = summarise({
      runs: [run({ id: 1, completedAt: t("2026-08-01T10:00:00Z") })],
      projects: [project({ id: 1, dataClassification: "regulated" })],
      assets: [asset({ id: 1, firstSeen: t("2026-08-01T10:00:00Z") })],
    });

    expect(result.inputs.secrecyLifetime.bySource).toEqual({ project: 1 });
    expect(result.inputs.secrecyLifetime.assumedForAssets).toBe(1);
    // A 25-year X breaches every scenario, which is the whole reason X's
    // provenance has to be stated next to the number it produced.
    expect(result.observed.points[0].breachedByScenario.aggressive).toBe(1);
  });

  it("states that Y is unmeasured rather than presenting zero as a finding", () => {
    const result = summarise({
      runs: [run({ id: 1, completedAt: t("2026-08-01T10:00:00Z") })],
      assets: [asset({ id: 1, firstSeen: t("2026-08-01T10:00:00Z") })],
    });

    expect(result.inputs.migrationYears.assetsWithRecordedEffort).toBe(0);
    expect(result.inputs.migrationYears.basis).toMatch(/no collector records a migration effort estimate/i);
  });
});

describe("summarisePostureTimeline — what it declines to compute", () => {
  it("names certificate expiry as uncollected instead of omitting the panel", () => {
    const result = summarise({});
    const certificates = result.notCollected.find((n) => n.id === "certificate-expiry");
    expect(certificates).toBeDefined();
    expect(certificates!.reason).toMatch(/no certificate collector has shipped/i);
  });
});
