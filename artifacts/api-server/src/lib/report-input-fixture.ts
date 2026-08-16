import { summariseProjectCoverage } from "./coverage";
import { summariseInventoryAssets, type InventoryAssetRow, type InventoryWaiverRow } from "./inventory-assets";
import type { ReportInput, ReportObservationRow, ReportRunRow } from "./report-common";

/**
 * A `ReportInput` built the way the route builds one, for the E1/E2 suites.
 *
 * It exists so the three report tests exercise the **real** enrichment path —
 * `summariseInventoryAssets` resolving compliance out of the actual standards
 * data, and `summariseProjectCoverage` doing the actual catalogue arithmetic —
 * rather than a hand-written `EnrichedInventoryAsset` literal. A fixture that
 * hand-writes the enriched shape would let a report pass while the thing it
 * summarises had changed underneath it, which is the failure mode doc 07's
 * "generated from real inventory" requirement is aimed at.
 *
 * Not imported by any production module. It lives beside them rather than in a
 * `__fixtures__` directory because this repository has no such convention.
 */

let nextId = 1;

export interface FixtureAsset {
  algorithm: string;
  surface: string;
  location?: string;
  keySize?: number | null;
  status?: string;
  effortHours?: number | null;
  dataClassification?: InventoryAssetRow["dataClassification"];
  secrecyLifetimeYears?: number | null;
  firstSeen?: string;
  lastSeen?: string;
  /** Omit to attach one observation. `null` leaves the asset with no observation at all. */
  observation?: {
    collector: string;
    collectorVersion: string;
    confidence: number;
    discoveryModality: string;
    observedAt: string;
  } | null;
  /**
   * C8 — a register entry for this asset. Passed to `summariseInventoryAssets`
   * unfiltered, so `activeWaiver()` decides whether it applies at `now`: an
   * `expiresAt` in the past belongs here and must come back as no waiver at all.
   */
  waiver?: {
    justification: string;
    signedOffBy: string;
    signedOffByUserId?: string | null;
    signedOffAt: string;
    expiresAt: string;
    revokedAt?: string | null;
  };
}

export interface FixtureRun {
  collector: string;
  collectorVersion: string;
  surface: string;
  status?: string;
  startedAt: string;
  completedAt?: string | null;
}

export function buildReportInput(options: {
  now?: Date;
  assets: FixtureAsset[];
  runs?: FixtureRun[];
  projects?: Array<{ id: number; name: string }>;
  /** Assets a later collection proved absent — counted in `statusCounts`, absent from the inventory. */
  goneAssets?: number;
  hourlyRate?: number;
  currency?: string;
  productVersion?: string | null;
}): ReportInput {
  const now = options.now ?? new Date("2026-08-16T09:00:00.000Z");
  const projects = options.projects ?? [{ id: 1, name: "payments" }];

  const runRows: ReportRunRow[] = (options.runs ?? []).map((run, index) => ({
    id: index + 1,
    collector: run.collector,
    collectorVersion: run.collectorVersion,
    surface: run.surface,
    status: run.status ?? "completed",
    target: "project:1",
    observationCount: 0,
    startedAt: run.startedAt,
    completedAt: run.completedAt === undefined ? run.startedAt : run.completedAt,
  }));

  const assetRows: InventoryAssetRow[] = [];
  const observations: ReportObservationRow[] = [];
  const waivers: InventoryWaiverRow[] = [];

  for (const asset of options.assets) {
    const id = nextId++;
    assetRows.push({
      id,
      fingerprint: `fp-${id.toString().padStart(4, "0")}`,
      surface: asset.surface,
      algorithm: asset.algorithm,
      keySize: asset.keySize ?? null,
      location: asset.location ?? `project:1:src/app-${id}.py:10`,
      status: asset.status ?? "active",
      firstSeen: asset.firstSeen ?? "2026-08-01T00:00:00.000Z",
      lastSeen: asset.lastSeen ?? "2026-08-15T00:00:00.000Z",
      ownerId: null,
      dataClassification: asset.dataClassification ?? null,
      secrecyLifetimeYears: asset.secrecyLifetimeYears ?? null,
      effortHours: asset.effortHours ?? null,
    });

    if (asset.waiver !== undefined) {
      waivers.push({
        id: waivers.length + 1,
        assetId: id,
        justification: asset.waiver.justification,
        signedOffBy: asset.waiver.signedOffBy,
        signedOffByUserId: asset.waiver.signedOffByUserId ?? null,
        signedOffAt: asset.waiver.signedOffAt,
        expiresAt: asset.waiver.expiresAt,
        revokedAt: asset.waiver.revokedAt ?? null,
      });
    }

    if (asset.observation === null) continue;
    const observation = asset.observation ?? {
      collector: "source-regex",
      collectorVersion: "2.1.0",
      confidence: 0.7,
      discoveryModality: "static_artifact_analysis",
      observedAt: "2026-08-15T00:00:00.000Z",
    };
    observations.push({
      id: observations.length + 1,
      assetId: id,
      collectionRunId: runRows[0]?.id ?? 1,
      ...observation,
    });
  }

  const statusExtras = Array.from({ length: options.goneAssets ?? 0 }, () => "gone");
  const enriched = summariseInventoryAssets({
    assets: assetRows,
    allAssetsStatus: [...assetRows.map((a) => a.status), ...statusExtras],
    projects: projects.map((p) => ({ id: p.id, dataClassification: null, secrecyLifetimeYears: null })),
    observations,
    waivers,
    now,
  });

  const coverage = summariseProjectCoverage({
    runs: runRows,
    assets: assetRows.map((a) => ({ id: a.id, surface: a.surface, status: a.status })),
    observations,
  });

  return {
    now,
    assets: enriched.assets,
    statusCounts: enriched.statusCounts,
    projects,
    runs: runRows,
    observations,
    coverage,
    productVersion: options.productVersion ?? null,
    ...(options.hourlyRate === undefined ? {} : { hourlyRate: options.hourlyRate }),
    ...(options.currency === undefined ? {} : { currency: options.currency }),
  };
}
