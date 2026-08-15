import { describe, it, expect } from "vitest";
import { summariseReadiness, type ReadinessAssetRow } from "./readiness";
import type { ProjectCoverage } from "./coverage";

const emptyCoverage: ProjectCoverage = {
  examinedSurfaces: 0,
  totalSurfaces: 10,
  surfaces: [],
  confidence: {
    basis: "latest observation per active asset",
    scored: 0,
    unscored: 0,
    excludedByAssetStatus: {},
    distinctValues: 0,
    min: null,
    max: null,
    mean: null,
    buckets: [],
  },
};

const now = new Date("2026-08-14T00:00:00Z");

describe("summariseReadiness — the honest-empty gate", () => {
  it("marks roadmap and vendor engagement not-tracked with a null percent, never zero", () => {
    const result = summariseReadiness({ coverage: emptyCoverage, presentAssets: [], dependencyAssetCount: 0 }, now);

    const roadmap = result.sections.find((s) => s.id === "roadmap")!;
    expect(roadmap.state).toBe("not-tracked");
    expect(roadmap.percentComplete).toBeNull();

    const vendor = result.sections.find((s) => s.id === "vendor-engagement")!;
    expect(vendor.state).toBe("not-tracked");
    expect(vendor.percentComplete).toBeNull();

    const supplyChain = result.sections.find((s) => s.id === "supply-chain")!;
    expect(supplyChain.state).toBe("not-tracked");
    expect(supplyChain.percentComplete).toBeNull();
  });

  it("marks prioritisation not-tracked (not 0%) when the estate is empty", () => {
    const result = summariseReadiness({ coverage: emptyCoverage, presentAssets: [], dependencyAssetCount: 0 }, now);
    const prioritisation = result.sections.find((s) => s.id === "prioritisation")!;
    expect(prioritisation.state).toBe("not-tracked");
    expect(prioritisation.percentComplete).toBeNull();
  });

  it("never emits an overall/combined readiness score", () => {
    const result = summariseReadiness({ coverage: emptyCoverage, presentAssets: [], dependencyAssetCount: 0 }, now);
    expect(result).not.toHaveProperty("overallPercentComplete");
    expect(result).not.toHaveProperty("score");
    expect(Object.keys(result).sort()).toEqual(["framing", "generatedAt", "sections"]);
  });

  it("states the factsheet source without inventing a numbered stage sequence", () => {
    const result = summariseReadiness({ coverage: emptyCoverage, presentAssets: [], dependencyAssetCount: 0 }, now);
    expect(result.framing).toContain("August 17, 2023");
    expect(result.framing.toLowerCase()).not.toMatch(/stage 1|stage 2|five-stage/);
  });
});

describe("summariseReadiness — tracked sections compute real fractions", () => {
  it("cryptographic inventory reports surfaces examined, not a percentage of assets", () => {
    const coverage: ProjectCoverage = { ...emptyCoverage, examinedSurfaces: 2, totalSurfaces: 10 };
    const result = summariseReadiness({ coverage, presentAssets: [], dependencyAssetCount: 0 }, now);
    const inventory = result.sections.find((s) => s.id === "cryptographic-inventory")!;
    expect(inventory.state).toBe("tracked");
    expect(inventory.percentComplete).toBe(20);
    expect(inventory.numerator).toBe(2);
    // The fixture's own `totalSurfaces`, deliberately — this is a pure test of
    // the summariser, which passes the coverage payload's denominator through
    // rather than consulting the catalogue. Do not couple it to
    // `COLLECTOR_SURFACES.length`: that would make the assertion pass for the
    // wrong reason if the summariser ever started overriding the input.
    expect(inventory.denominator).toBe(emptyCoverage.totalSurfaces);
  });

  it("prioritisation counts assets with an explicit classification, asset- or project-level", () => {
    const presentAssets: ReadinessAssetRow[] = [
      { status: "active", classificationSource: "asset" },
      { status: "active", classificationSource: "project" },
      { status: "active", classificationSource: "default" },
      { status: "active", classificationSource: "default" },
    ];
    const result = summariseReadiness({ coverage: emptyCoverage, presentAssets, dependencyAssetCount: 0 }, now);
    const prioritisation = result.sections.find((s) => s.id === "prioritisation")!;
    expect(prioritisation.state).toBe("tracked");
    expect(prioritisation.numerator).toBe(2);
    expect(prioritisation.denominator).toBe(4);
    expect(prioritisation.percentComplete).toBe(50);
  });

  it("supply chain stays not-tracked even with dependency evidence — no threshold is defined anywhere", () => {
    const result = summariseReadiness({ coverage: emptyCoverage, presentAssets: [], dependencyAssetCount: 12 }, now);
    const supplyChain = result.sections.find((s) => s.id === "supply-chain")!;
    expect(supplyChain.state).toBe("not-tracked");
    expect(supplyChain.percentComplete).toBeNull();
    expect(supplyChain.reason).toContain("12");
  });
});
