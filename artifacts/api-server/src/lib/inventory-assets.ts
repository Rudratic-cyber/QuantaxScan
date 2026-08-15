import {
  DEFAULT_QDAY_SCENARIOS,
  QDAY_FRAMING,
  assessMoscaRisk,
  migrationYearsFromEffortHours,
  type QDayScenario,
} from "@workspace/risk";
import { resolveSecrecyLifetime, type DataClassification } from "@workspace/db/classification";
import { resolveCompliance, type FindingCompliance } from "./compliance";

/**
 * D1 Row 4 (inventory breakdown) and Row 2 drill-down, computed.
 * docs/Claude/06-cisa-dashboard.md §"Row 4", §"Row 2".
 *
 * Present assets (`status !== "gone"`), each carrying its PQC-vs-hygiene
 * track (G-10: MD5/SHA-1/AES-ECB must never inflate a post-quantum score)
 * and which Q-Day scenarios it breaches. Reuses the same exported primitives
 * `posture-timeline.ts` uses for the same X/Y/Z arithmetic — `assessMoscaRisk`,
 * `resolveSecrecyLifetime`, `migrationYearsFromEffortHours` — rather than a
 * second implementation of Mosca, so the two panels cannot disagree about
 * what "breached" means. Pure and drizzle-free, same reason as its siblings.
 */

const PROJECT_PREFIX_PATTERN = /^project:(\d+):/;

/** Mirrors `posture-timeline.ts`'s reading of `projectRepoId()`'s convention — see that file for why the trailing colon matters. */
function projectIdFromLocation(location: string): number | null {
  const match = PROJECT_PREFIX_PATTERN.exec(location);
  return match === null ? null : Number(match[1]);
}

export interface InventoryAssetRow {
  id: number;
  fingerprint: string;
  surface: string;
  algorithm: string;
  keySize: number | null;
  location: string;
  status: string;
  firstSeen: Date | string;
  lastSeen: Date | string;
  ownerId: number | null;
  dataClassification: DataClassification | null;
  secrecyLifetimeYears: number | null;
  effortHours: number | null;
}

export interface InventoryProjectRow {
  id: number;
  dataClassification: DataClassification | null;
  secrecyLifetimeYears: number | null;
}

/** Latest observation per asset — the same "one point, most recent wins" rule `coverage.ts` uses. */
export interface InventoryObservationRow {
  assetId: number;
  confidence: number;
  observedAt: Date | string;
  id: number;
}

export interface EnrichedInventoryAsset {
  id: number;
  fingerprint: string;
  projectId: number | null;
  surface: string;
  algorithm: string;
  keySize: number | null;
  location: string;
  status: string;
  firstSeen: string;
  lastSeen: string;
  ownerId: number | null;
  dataClassification: DataClassification | null;
  secrecyLifetimeYears: number | null;
  /**
   * Effort somebody recorded against *this* asset, in hours. Null means nobody
   * did — no collector writes it today — and it is deliberately not defaulted,
   * for the same reason `keySize` is not (G-05): a report has to be able to say
   * that a number was derived from the algorithm's class average rather than
   * estimated for this asset. `mosca.y` is this value converted to years, so a
   * null here and a `y` of 0 are the same fact seen twice.
   */
  effortHours: number | null;
  /** Where the X used below actually came from — never re-derived by the client. */
  classificationSource: "asset" | "project" | "default";
  latestConfidence: number | null;
  /** Null when the mapping data has no entry for this algorithm — same contract as `withCompliance`. */
  compliance: FindingCompliance | null;
  mosca: {
    x: number;
    y: number;
    xAssumed: boolean;
    /** False when the algorithm carries no quantum-vulnerable track — a hygiene or unmapped finding breaches nothing under Mosca. */
    applicable: boolean;
    breachedScenarios: string[];
  };
}

export interface InventoryAssetsSummary {
  generatedAt: string;
  assets: EnrichedInventoryAsset[];
  /** Every status this organisation's assets hold, including `gone` — so Row 6 (drift) can report removals without listing them as present. */
  statusCounts: Record<string, number>;
  scenarios: readonly QDayScenario[];
  framing: string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export function summariseInventoryAssets(input: {
  assets: InventoryAssetRow[];
  allAssetsStatus: string[];
  projects: InventoryProjectRow[];
  observations: InventoryObservationRow[];
  scenarios?: readonly QDayScenario[];
  now?: Date;
}): InventoryAssetsSummary {
  const now = input.now ?? new Date();
  const scenarios = input.scenarios ?? DEFAULT_QDAY_SCENARIOS;
  const projectById = new Map(input.projects.map((p) => [p.id, p]));

  const latestByAsset = new Map<number, InventoryObservationRow>();
  for (const observation of input.observations) {
    const held = latestByAsset.get(observation.assetId);
    if (
      held === undefined ||
      toMillis(observation.observedAt) > toMillis(held.observedAt) ||
      (toMillis(observation.observedAt) === toMillis(held.observedAt) && observation.id > held.id)
    ) {
      latestByAsset.set(observation.assetId, observation);
    }
  }

  const assets: EnrichedInventoryAsset[] = input.assets.map((row) => {
    const projectId = projectIdFromLocation(row.location);
    const project = projectId === null ? undefined : projectById.get(projectId);
    const lifetime = resolveSecrecyLifetime({
      assetClassification: row.dataClassification,
      assetSecrecyLifetimeYears: row.secrecyLifetimeYears,
      projectClassification: project?.dataClassification ?? null,
      projectSecrecyLifetimeYears: project?.secrecyLifetimeYears ?? null,
    });
    const compliance = resolveCompliance(row.algorithm, { asOf: now });
    const y = migrationYearsFromEffortHours(row.effortHours ?? 0);
    const assessment = assessMoscaRisk({
      secrecyLifetimeYears: lifetime.years,
      migrationYears: y,
      hasQuantumVulnerableCrypto: compliance?.quantumVulnerable ?? false,
      now,
      scenarios,
    });

    return {
      id: row.id,
      fingerprint: row.fingerprint,
      projectId,
      surface: row.surface,
      algorithm: row.algorithm,
      keySize: row.keySize,
      location: row.location,
      status: row.status,
      firstSeen: toIso(row.firstSeen),
      lastSeen: toIso(row.lastSeen),
      ownerId: row.ownerId,
      dataClassification: row.dataClassification,
      secrecyLifetimeYears: row.secrecyLifetimeYears,
      effortHours: row.effortHours,
      classificationSource: lifetime.classificationSource,
      latestConfidence: latestByAsset.get(row.id)?.confidence ?? null,
      compliance,
      mosca: {
        x: lifetime.years,
        y,
        xAssumed: lifetime.assumed,
        applicable: assessment.applicable,
        breachedScenarios: assessment.verdicts.filter((v) => v.breached).map((v) => v.scenario),
      },
    };
  });

  const statusCounts: Record<string, number> = {};
  for (const status of input.allAssetsStatus) {
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }

  return {
    generatedAt: now.toISOString(),
    assets,
    statusCounts,
    scenarios,
    framing: QDAY_FRAMING,
  };
}
