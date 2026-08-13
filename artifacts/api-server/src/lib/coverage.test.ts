import { describe, it, expect } from "vitest";
import { summariseProjectCoverage, CONFIDENCE_BUCKETS, type CoverageObservationRow } from "./coverage";

/**
 * These assertions are the honesty rules of D3 written down. Each one has a
 * corresponding way of lying about coverage that it prevents.
 */

const t = (iso: string) => new Date(iso);

const observation = (over: Partial<CoverageObservationRow> & { assetId: number; confidence: number }): CoverageObservationRow => ({
  id: over.id ?? over.assetId,
  observedAt: over.observedAt ?? t("2026-08-01T00:00:00Z"),
  ...over,
});

describe("summariseProjectCoverage — surfaces", () => {
  it("reports nothing at all for a project that has never been scanned", () => {
    const result = summariseProjectCoverage({ runs: [], assets: [], observations: [] });
    expect(result.surfaces).toEqual([]);
    expect(result.examinedSurfaces).toBe(0);
    // The denominator is the catalogue's, not a count of what happens to have data.
    expect(result.totalSurfaces).toBe(10);
  });

  it("counts one examined surface after a single source scan — not a near-full bar", () => {
    const result = summariseProjectCoverage({
      runs: [{ surface: "source", status: "completed", startedAt: t("2026-08-01T10:00:00Z"), completedAt: t("2026-08-01T10:00:05Z") }],
      assets: [{ id: 1, surface: "source", status: "active" }],
      observations: [observation({ assetId: 1, confidence: 0.7 })],
    });

    expect(result.examinedSurfaces).toBe(1);
    expect(result.totalSurfaces).toBe(10);
    expect(result.surfaces).toHaveLength(1);
    expect(result.surfaces[0]).toMatchObject({
      surface: "source",
      surfaceId: "source",
      state: "examined",
      completedRuns: 1,
      failedRuns: 0,
      assets: 1,
      activeAssets: 1,
      lastExaminedAt: "2026-08-01T10:00:05.000Z",
    });
  });

  it("distinguishes examined-and-found-nothing from never examined", () => {
    const result = summariseProjectCoverage({
      runs: [{ surface: "source", status: "completed", startedAt: t("2026-08-01T10:00:00Z"), completedAt: t("2026-08-01T10:00:01Z") }],
      assets: [],
      observations: [],
    });

    expect(result.surfaces[0].state).toBe("examined-nothing-found");
    // A clean scan IS coverage — this surface counts toward the numerator.
    expect(result.examinedSurfaces).toBe(1);
  });

  it("does not count a failed run as an examination", () => {
    const result = summariseProjectCoverage({
      runs: [{ surface: "tls", status: "failed", startedAt: t("2026-08-01T10:00:00Z"), completedAt: null }],
      assets: [],
      observations: [],
    });

    expect(result.surfaces[0]).toMatchObject({ surface: "tls", state: "never-examined", failedRuns: 1, completedRuns: 0 });
    expect(result.surfaces[0].lastExaminedAt).toBeNull();
    expect(result.examinedSurfaces).toBe(0);
  });

  it("does not count a still-running collection as an examination", () => {
    const result = summariseProjectCoverage({
      runs: [{ surface: "tls", status: "running", startedAt: t("2026-08-01T10:00:00Z"), completedAt: null }],
      assets: [],
      observations: [],
    });
    expect(result.surfaces[0].state).toBe("never-examined");
    expect(result.examinedSurfaces).toBe(0);
  });

  it("treats a surface with assets but no run row as examined, and does not lose the findings", () => {
    // A missing run row is a bookkeeping gap. Claiming we never looked at a
    // surface we demonstrably have findings from would be the worse error.
    const result = summariseProjectCoverage({
      runs: [],
      assets: [{ id: 1, surface: "source", status: "active" }],
      observations: [observation({ assetId: 1, confidence: 0.7 })],
    });
    expect(result.surfaces[0]).toMatchObject({ state: "examined", completedRuns: 0, assets: 1 });
    expect(result.examinedSurfaces).toBe(1);
  });

  it("takes the latest completed run as the examination time, whatever order rows arrive in", () => {
    const result = summariseProjectCoverage({
      runs: [
        { surface: "source", status: "completed", startedAt: t("2026-08-03T09:00:00Z"), completedAt: t("2026-08-03T09:00:01Z") },
        { surface: "source", status: "completed", startedAt: t("2026-08-01T09:00:00Z"), completedAt: t("2026-08-01T09:00:01Z") },
        { surface: "source", status: "failed", startedAt: t("2026-08-09T09:00:00Z"), completedAt: t("2026-08-09T09:00:01Z") },
      ],
      assets: [],
      observations: [],
    });
    expect(result.surfaces[0].completedRuns).toBe(2);
    // The 9 August failure must not present itself as the last time we looked.
    expect(result.surfaces[0].lastExaminedAt).toBe("2026-08-03T09:00:01.000Z");
  });

  it("falls back to startedAt when a completed run recorded no completion time", () => {
    const result = summariseProjectCoverage({
      runs: [{ surface: "source", status: "completed", startedAt: t("2026-08-01T10:00:00Z"), completedAt: null }],
      assets: [],
      observations: [],
    });
    expect(result.surfaces[0].lastExaminedAt).toBe("2026-08-01T10:00:00.000Z");
  });

  it("orders surfaces the way the coverage page reads, not by insertion", () => {
    const result = summariseProjectCoverage({
      runs: [
        { surface: "binary", status: "completed", startedAt: t("2026-08-01T00:00:00Z"), completedAt: null },
        { surface: "source", status: "completed", startedAt: t("2026-08-01T00:00:00Z"), completedAt: null },
        { surface: "tls", status: "completed", startedAt: t("2026-08-01T00:00:00Z"), completedAt: null },
      ],
      assets: [],
      observations: [],
    });
    expect(result.surfaces.map((s) => s.surface)).toEqual(["source", "tls", "binary"]);
  });

  it("keeps a surface the catalogue does not know about rather than dropping it", () => {
    // Dropping it would quietly shrink the numerator of a coverage claim.
    const result = summariseProjectCoverage({
      runs: [{ surface: "quantum-tea-leaves", status: "completed", startedAt: t("2026-08-01T00:00:00Z"), completedAt: null }],
      assets: [],
      observations: [],
    });
    expect(result.surfaces[0]).toMatchObject({ surface: "quantum-tea-leaves", surfaceId: null, state: "examined-nothing-found" });
    // ...but it cannot inflate "N of 10", because it is not one of the ten.
    expect(result.examinedSurfaces).toBe(0);
  });
});

describe("summariseProjectCoverage — confidence distribution (G-11)", () => {
  it("reports the source collector's 0.7 as a single populated bucket, with the verified bucket visibly empty", () => {
    const result = summariseProjectCoverage({
      runs: [],
      assets: [1, 2, 3].map((id) => ({ id, surface: "source", status: "active" })),
      observations: [1, 2, 3].map((id) => observation({ assetId: id, confidence: 0.7 })),
    });

    expect(result.confidence.scored).toBe(3);
    expect(result.confidence.distinctValues).toBe(1);
    expect(result.confidence.min).toBe(0.7);
    expect(result.confidence.max).toBe(0.7);
    expect(result.confidence.mean).toBe(0.7);
    expect(result.confidence.buckets.map((b) => b.count)).toEqual([0, 0, 0, 3, 0]);
    // The empty top bucket is the message: nothing here is a verified handshake.
    expect(result.confidence.buckets[4]).toMatchObject({ label: "0.8–1.0", count: 0 });
  });

  it("puts each boundary value in exactly one bucket, with 1.0 in the top one", () => {
    const cases: Array<[number, number]> = [
      [0, 0],
      [0.199, 0],
      [0.2, 1],
      [0.6, 3],
      [0.7, 3],
      [0.799, 3],
      [0.8, 4],
      [1, 4],
    ];
    for (const [confidence, expectedIndex] of cases) {
      const result = summariseProjectCoverage({
        runs: [],
        assets: [{ id: 1, surface: "source", status: "active" }],
        observations: [observation({ assetId: 1, confidence })],
      });
      const populated = result.confidence.buckets.flatMap((b, i) => (b.count > 0 ? [i] : []));
      expect(populated, `confidence ${confidence}`).toEqual([expectedIndex]);
    }
  });

  it("counts one point per asset, not one per observation — a re-scan must not reweight the distribution", () => {
    const result = summariseProjectCoverage({
      runs: [],
      assets: [{ id: 1, surface: "source", status: "active" }],
      observations: [
        observation({ id: 1, assetId: 1, confidence: 0.3, observedAt: t("2026-08-01T00:00:00Z") }),
        observation({ id: 2, assetId: 1, confidence: 0.3, observedAt: t("2026-08-02T00:00:00Z") }),
        observation({ id: 3, assetId: 1, confidence: 0.9, observedAt: t("2026-08-03T00:00:00Z") }),
      ],
    });

    expect(result.confidence.scored).toBe(1);
    expect(result.confidence.max).toBe(0.9);
    expect(result.confidence.buckets.map((b) => b.count)).toEqual([0, 0, 0, 0, 1]);
  });

  it("breaks a same-timestamp tie by observation id — a whole scan is written in one transaction", () => {
    const at = t("2026-08-01T00:00:00Z");
    const result = summariseProjectCoverage({
      runs: [],
      assets: [{ id: 1, surface: "source", status: "active" }],
      observations: [
        observation({ id: 10, assetId: 1, confidence: 0.1, observedAt: at }),
        observation({ id: 11, assetId: 1, confidence: 0.9, observedAt: at }),
      ],
    });
    expect(result.confidence.max).toBe(0.9);
    expect(result.confidence.scored).toBe(1);
  });

  it("scores the live inventory only, and says how many assets it left out and why", () => {
    const result = summariseProjectCoverage({
      runs: [],
      assets: [
        { id: 1, surface: "source", status: "active" },
        { id: 2, surface: "source", status: "gone" },
        { id: 3, surface: "source", status: "waived" },
        { id: 4, surface: "source", status: "gone" },
      ],
      observations: [1, 2, 3, 4].map((id) => observation({ assetId: id, confidence: 0.7 })),
    });

    expect(result.confidence.basis).toBe("latest observation per active asset");
    expect(result.confidence.scored).toBe(1);
    expect(result.confidence.excludedByAssetStatus).toEqual({ gone: 2, waived: 1 });
  });

  it("counts an active asset with no observation rather than hiding it", () => {
    const result = summariseProjectCoverage({
      runs: [],
      assets: [
        { id: 1, surface: "source", status: "active" },
        { id: 2, surface: "source", status: "active" },
      ],
      observations: [observation({ assetId: 1, confidence: 0.7 })],
    });
    expect(result.confidence.scored).toBe(1);
    expect(result.confidence.unscored).toBe(1);
  });

  it("has no distribution at all, rather than a comforting zero, when nothing has been observed", () => {
    const result = summariseProjectCoverage({ runs: [], assets: [], observations: [] });
    expect(result.confidence.min).toBeNull();
    expect(result.confidence.max).toBeNull();
    expect(result.confidence.mean).toBeNull();
    expect(result.confidence.scored).toBe(0);
    expect(result.confidence.buckets).toHaveLength(CONFIDENCE_BUCKETS.length);
    expect(result.confidence.buckets.every((b) => b.count === 0)).toBe(true);
  });

  it("clamps an out-of-range confidence into the distribution instead of discarding it", () => {
    const result = summariseProjectCoverage({
      runs: [],
      assets: [
        { id: 1, surface: "source", status: "active" },
        { id: 2, surface: "source", status: "active" },
      ],
      observations: [observation({ assetId: 1, confidence: 1.4 }), observation({ assetId: 2, confidence: -0.2 })],
    });
    expect(result.confidence.scored).toBe(2);
    expect(result.confidence.buckets.map((b) => b.count)).toEqual([1, 0, 0, 0, 1]);
  });
});
