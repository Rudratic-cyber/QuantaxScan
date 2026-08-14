import { describe, it, expect } from "vitest";
import { summariseInventoryAssets, type InventoryAssetRow } from "./inventory-assets";

const now = new Date("2026-08-14T00:00:00Z");

const baseAsset = (over: Partial<InventoryAssetRow> & { id: number; algorithm: string }): InventoryAssetRow => ({
  fingerprint: `fp-${over.id}`,
  surface: "source",
  keySize: null,
  location: `project:1:file-${over.id}.py`,
  status: "active",
  firstSeen: now,
  lastSeen: now,
  ownerId: null,
  dataClassification: null,
  secrecyLifetimeYears: null,
  effortHours: null,
  ...over,
});

describe("summariseInventoryAssets — PQC vs classical hygiene, never blended", () => {
  it("keeps a hygiene finding (MD5) out of the quantum-vulnerable track", () => {
    const result = summariseInventoryAssets({
      assets: [baseAsset({ id: 1, algorithm: "MD5" })],
      allAssetsStatus: ["active"],
      projects: [],
      observations: [],
      now,
    });
    const [asset] = result.assets;
    expect(asset.compliance?.riskTrack).toBe("classical-hygiene");
    expect(asset.compliance?.countsTowardPostQuantumScore).toBe(false);
    // Never quantum-breached — Mosca does not apply to a track with nothing for Q-Day to break.
    expect(asset.mosca.applicable).toBe(false);
    expect(asset.mosca.breachedScenarios).toEqual([]);
  });

  it("marks an unmapped algorithm's compliance null rather than inventing an obligation", () => {
    const result = summariseInventoryAssets({
      assets: [baseAsset({ id: 1, algorithm: "some-未知-algorithm-xyz" })],
      allAssetsStatus: ["active"],
      projects: [],
      observations: [],
      now,
    });
    expect(result.assets[0].compliance).toBeNull();
    expect(result.assets[0].mosca.applicable).toBe(false);
  });
});

describe("summariseInventoryAssets — X is resolved with real provenance, not silently defaulted", () => {
  it("uses the default secrecy lifetime and marks it assumed when nothing is supplied", () => {
    const result = summariseInventoryAssets({
      assets: [baseAsset({ id: 1, algorithm: "RSA" })],
      allAssetsStatus: ["active"],
      projects: [],
      observations: [],
      now,
    });
    expect(result.assets[0].classificationSource).toBe("default");
    expect(result.assets[0].mosca.xAssumed).toBe(true);
  });

  it("breaches the conservative scenario for an RSA asset given a long, explicit secrecy lifetime", () => {
    const result = summariseInventoryAssets({
      assets: [baseAsset({ id: 1, algorithm: "RSA", dataClassification: "regulated", secrecyLifetimeYears: 25 })],
      allAssetsStatus: ["active"],
      projects: [],
      observations: [],
      now,
    });
    const asset = result.assets[0];
    expect(asset.classificationSource).toBe("asset");
    expect(asset.mosca.xAssumed).toBe(false);
    expect(asset.mosca.applicable).toBe(true);
    expect(asset.mosca.breachedScenarios).toContain("conservative");
  });
});

describe("summariseInventoryAssets — status counts include gone assets without listing them as present", () => {
  it("reports every status across the org, not just the present ones passed in `assets`", () => {
    const result = summariseInventoryAssets({
      assets: [baseAsset({ id: 1, algorithm: "RSA" })],
      allAssetsStatus: ["active", "active", "gone", "remediated"],
      projects: [],
      observations: [],
      now,
    });
    expect(result.statusCounts).toEqual({ active: 2, gone: 1, remediated: 1 });
    expect(result.assets).toHaveLength(1);
  });
});

describe("summariseInventoryAssets — confidence is the latest observation per asset", () => {
  it("picks the most recent observation, not the first or an average", () => {
    const result = summariseInventoryAssets({
      assets: [baseAsset({ id: 1, algorithm: "RSA" })],
      allAssetsStatus: ["active"],
      projects: [],
      observations: [
        { id: 1, assetId: 1, confidence: 0.2, observedAt: new Date("2026-08-01T00:00:00Z") },
        { id: 2, assetId: 1, confidence: 0.9, observedAt: new Date("2026-08-10T00:00:00Z") },
      ],
      now,
    });
    expect(result.assets[0].latestConfidence).toBe(0.9);
  });

  it("is null when an asset has no observation at all", () => {
    const result = summariseInventoryAssets({
      assets: [baseAsset({ id: 1, algorithm: "RSA" })],
      allAssetsStatus: ["active"],
      projects: [],
      observations: [],
      now,
    });
    expect(result.assets[0].latestConfidence).toBeNull();
  });
});
