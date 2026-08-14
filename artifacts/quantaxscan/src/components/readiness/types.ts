/**
 * D1 — payload shapes for `/api/inventory/readiness` and `/api/inventory/assets`.
 * Hand-declared, matching how `CoverageMeter.tsx` and `PostureTimeline.tsx`
 * declare their own payload types rather than importing the generated zod
 * schemas — the generated client wraps react-query, and these panels need to
 * narrate loading/error/data as three distinct render branches themselves so
 * an error can never fall through to a fabricated zero.
 */

export type ReadinessSectionState = "tracked" | "not-tracked";

export interface ReadinessSection {
  id: "roadmap" | "cryptographic-inventory" | "prioritisation" | "vendor-engagement" | "supply-chain";
  label: string;
  definition: string;
  state: ReadinessSectionState;
  percentComplete: number | null;
  numerator: number | null;
  denominator: number | null;
  reason: string;
}

export type SurfaceState = "examined" | "examined-nothing-found" | "never-examined";

export interface SurfaceCoverage {
  surface: string;
  surfaceId: string | null;
  state: SurfaceState;
  completedRuns: number;
  failedRuns: number;
  lastExaminedAt: string | null;
  assets: number;
  activeAssets: number;
}

export interface ConfidenceBucket { label: string; lower: number; upper: number; count: number }

export interface EstateCoverage {
  examinedSurfaces: number;
  totalSurfaces: number;
  surfaces: SurfaceCoverage[];
  confidence: {
    basis: string;
    scored: number;
    unscored: number;
    excludedByAssetStatus: Record<string, number>;
    distinctValues: number;
    min: number | null;
    max: number | null;
    mean: number | null;
    buckets: ConfidenceBucket[];
  };
}

export interface ReadinessResponse {
  generatedAt: string;
  framing: string;
  sections: ReadinessSection[];
  coverage: EstateCoverage;
}

export interface FindingCompliance {
  algorithm: string;
  algorithmId: string;
  quantumVulnerable: boolean;
  riskTrack: "post-quantum" | "classical-hygiene";
  bucket: string;
  bucketLabel: string;
  bucketDescription: string;
  countsTowardPostQuantumScore: boolean;
  headline: string;
}

export interface InventoryMoscaSummary {
  x: number;
  y: number;
  xAssumed: boolean;
  applicable: boolean;
  breachedScenarios: string[];
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
  dataClassification: string | null;
  secrecyLifetimeYears: number | null;
  classificationSource: "asset" | "project" | "default";
  latestConfidence: number | null;
  compliance: FindingCompliance | null;
  mosca: InventoryMoscaSummary;
}

export interface QDayScenarioInfo {
  name: string;
  qDayYear: number;
  rationale: string;
  confidence: string;
}

export interface InventoryAssetsResponse {
  generatedAt: string;
  assets: EnrichedInventoryAsset[];
  statusCounts: Record<string, number>;
  scenarios: QDayScenarioInfo[];
  framing: string;
}
