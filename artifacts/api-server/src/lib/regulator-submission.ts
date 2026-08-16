import {
  buildAssumptions,
  buildCostEstimate,
  buildCoverageLimitations,
  buildHeader,
  surfaceLabel,
  type Assumption,
  type CoverageLimitations,
  type ReportHeader,
  type ReportInput,
  type ReportObservationRow,
} from "./report-common";
import type { EnrichedInventoryAsset } from "./inventory-assets";
import type { Citation, Obligation } from "@workspace/mappings";

/**
 * E2 — the regulator / auditor inventory submission, computed.
 * docs/Claude/07-reports.md §"E2 — Regulator / auditor inventory submission".
 *
 * The audience is someone who will try to find holes, so the document is
 * organised around the seven things doc 07's requirements table says it must
 * carry, and each of them is a field rather than a paragraph a renderer might
 * forget:
 *
 * | Requirement | Where |
 * |---|---|
 * | Every asset carries provenance | `inventory[].provenance` |
 * | Every compliance claim carries a citation with retrieval date | `inventory[].obligations[].citation` |
 * | Mapping `dataVersion` pinned in the header | `header.mappingDataVersion` |
 * | Coverage limitations stated prominently | `coverageLimitations`, before the inventory |
 * | Waivers with owner, justification, expiry, approver | `exceptions` — and see below |
 * | Methodology appendix | `methodology` |
 * | Immutable, versioned, signed | `integrity` — and see below |
 *
 * **Two of those seven are answered by an honest refusal rather than by data,
 * and that is the point of stating them as fields.**
 *
 *  - *Waivers.* This product has no waiver register yet. `exceptions` therefore
 *    reports that no register is configured and lists the assets whose status is
 *    `waived` as the only exception evidence the inventory actually holds —
 *    without owner, justification, expiry or approver, because none is
 *    recorded. An empty `waivers: []` would read as "there are no exceptions",
 *    which is a different and unsupported claim.
 *  - *Signed.* `integrity` carries a SHA-256 digest over the document and says
 *    in terms that a digest is not a signature. Calling an unsigned document
 *    signed is the sort of thing an auditor checks first.
 *
 * **Only `verified` obligations appear as claims.** doc 07: anything
 * `needs-check` renders as "indicative, pending verification". They are split
 * into `obligations` and `indicativeObligations` per asset so a renderer cannot
 * merge them by accident, and `complianceClaimSummary.indicative` counts them
 * so their existence is disclosed rather than quietly dropped.
 */

export const INDICATIVE_OBLIGATION_LABEL = "Indicative, pending verification";

export const UNSIGNED_STATEMENT =
  "This document carries a SHA-256 content digest, which lets a recipient detect that a copy has been " +
  "altered relative to the digest they were given. It is not a signature: this product has no signing key " +
  "and no key management, so the digest proves integrity against a value you already trust and nothing " +
  "about origin. Treat it accordingly.";

export const NO_WAIVER_REGISTER_STATEMENT =
  "This product does not yet operate a waiver register, so no exception in this document carries an owner, a " +
  "justification, an expiry or an approver. The assets listed below are the ones an operator has marked as " +
  "waived in the inventory; that marking records only that somebody set the status. The absence of a register " +
  "must not be read as an absence of exceptions.";

export interface AssetProvenance {
  /** `null` when this asset carries no observation at all — the gap is stated, not filled in. */
  collector: string | null;
  collectorVersion: string | null;
  observedAt: string | null;
  /** 0..1, the collector's own confidence at the most recent observation. */
  confidence: number | null;
  /** How the observation was obtained — an active probe and a submitted form are not the same evidence. */
  discoveryModality: string | null;
  /** How many observations back this asset, across every run. */
  observations: number;
  /** Said out loud when there are none, because "says who?" then has no answer. */
  note: string | null;
}

export interface RegulatorObligation {
  framework: string;
  frameworkName: string | null;
  requirement: string;
  severity: string;
  /** From the data, never upgraded. `verified` for anything in `obligations`. */
  confidence: string;
  /** Present when the citing document is a draft; shown wherever the obligation is. */
  draftStatus: string | null;
  deadline: {
    type: string;
    label: string;
    effect: string;
    inEffect: boolean;
    effectiveFrom: string | null;
    appliesTo: string | null;
    securityStrength: string | null;
  } | null;
  replacement: { algorithm: string; standard: string; purpose: string | null } | null;
  citation: { document: string; section: string | null; url: string; retrievedAt: string | null };
  /** True when the citation carries no retrieval date. Stated rather than left to the reader to notice. */
  citationRetrievalDateMissing: boolean;
  caveats: string[];
}

export interface RegulatorAsset {
  fingerprint: string;
  surface: string;
  surfaceName: string;
  algorithm: string;
  /** `null` means the collector looked and could not determine it — never a default. G-05. */
  keySize: number | null;
  keySizeNote: string | null;
  location: string;
  projectId: number | null;
  status: string;
  firstSeen: string;
  lastSeen: string;
  provenance: AssetProvenance;
  classification: {
    dataClassification: string | null;
    secrecyLifetimeYears: number;
    source: string;
    assumed: boolean;
  };
  mosca: { x: number; y: number; applicable: boolean; breachedScenarios: string[] };
  /** `verified` obligations only. */
  obligations: RegulatorObligation[];
  /** `needs-check` obligations, labelled. Never merged with the above. */
  indicativeObligations: RegulatorObligation[];
  /** Null when the standards data has no entry for this algorithm; no obligation is invented. */
  standardsDataEntry: boolean;
  caveats: string[];
}

export interface RegulatorExceptions {
  registerAvailable: false;
  statement: string;
  waivedAssets: Array<{ fingerprint: string; algorithm: string; location: string; surface: string }>;
  /** Assets excluded from the inventory because a later collection proved them absent. */
  removedAssets: number;
}

export interface RegulatorMethodology {
  collectors: ReportHeader["collectors"];
  /** Which evidence modalities this submission rests on, and how many observations each carries. */
  discoveryModalities: Array<{ modality: string; observations: number }>;
  confidenceBasis: string;
  limitations: string[];
}

export interface RegulatorIntegrity {
  digestAlgorithm: "SHA-256";
  /** Filled by the route once the document is complete. Empty here so the digest can cover the rest of it. */
  digest: string;
  signed: false;
  statement: string;
}

export interface RegulatorSubmission {
  kind: "regulator-submission";
  header: ReportHeader;
  /** First, deliberately. doc 07: "Undisclosed gaps are the finding that sinks an audit." */
  coverageLimitations: CoverageLimitations;
  scope: {
    projects: Array<{ id: number; name: string; assets: number }>;
    assetsIncluded: number;
    /** Every status in the organisation, so the exclusions below are checkable arithmetic. */
    statusCounts: Record<string, number>;
    assetsExcluded: number;
    exclusionBasis: string;
  };
  complianceClaimSummary: {
    /** Assets carrying at least one `verified` obligation. */
    assetsWithVerifiedObligations: number;
    /** Assets whose only obligations are `needs-check`. */
    assetsWithIndicativeObligationsOnly: number;
    /** Assets the standards data has no entry for at all. */
    assetsWithNoStandardsEntry: number;
    verifiedObligations: number;
    indicativeObligations: number;
    obligationsMissingRetrievalDate: number;
    indicativeLabel: string;
  };
  inventory: RegulatorAsset[];
  exceptions: RegulatorExceptions;
  methodology: RegulatorMethodology;
  assumptions: Assumption[];
  integrity: RegulatorIntegrity;
}

const KEY_SIZE_UNDETERMINED_NOTE =
  "The collector examined this asset and could not determine a key size. It is recorded as undetermined rather " +
  "than defaulted, so an obligation keyed on security strength is not applied to it on a guessed value.";

function effectiveFrom(deadline: NonNullable<Obligation["deadline"]>): string | null {
  if (deadline.since !== undefined) return deadline.since;
  if (deadline.in !== undefined) return deadline.in;
  if (deadline.after !== undefined) return deadline.after;
  return null;
}

function toRegulatorObligation(obligation: Obligation): RegulatorObligation {
  const citation: Citation = obligation.citation;
  return {
    framework: obligation.framework,
    frameworkName: obligation.frameworkName ?? null,
    requirement: obligation.requirement,
    severity: obligation.severity,
    confidence: obligation.confidence,
    draftStatus: obligation.draftStatus ?? null,
    deadline:
      obligation.deadline === undefined
        ? null
        : {
            type: obligation.deadline.type,
            label: obligation.deadline.label,
            effect: obligation.deadline.effect,
            inEffect: obligation.deadline.inEffect,
            effectiveFrom: effectiveFrom(obligation.deadline),
            appliesTo: obligation.deadline.appliesTo ?? null,
            securityStrength: obligation.deadline.securityStrength ?? null,
          },
    replacement:
      obligation.replacement === undefined
        ? null
        : {
            algorithm: obligation.replacement.algorithm,
            standard: obligation.replacement.standard,
            purpose: obligation.replacement.purpose ?? null,
          },
    citation: {
      document: citation.document,
      section: citation.section ?? null,
      url: citation.url,
      retrievedAt: citation.retrievedAt ?? null,
    },
    citationRetrievalDateMissing: citation.retrievedAt === undefined,
    caveats: obligation.caveats,
  };
}

/** The most recent observation per asset — the same "one point, most recent wins" rule the coverage meter uses. */
function latestObservationByAsset(observations: ReportObservationRow[]): Map<number, ReportObservationRow> {
  const latest = new Map<number, ReportObservationRow>();
  for (const observation of observations) {
    const held = latest.get(observation.assetId);
    const at = new Date(observation.observedAt).getTime();
    const heldAt = held === undefined ? -Infinity : new Date(held.observedAt).getTime();
    if (held === undefined || at > heldAt || (at === heldAt && observation.id > held.id)) {
      latest.set(observation.assetId, observation);
    }
  }
  return latest;
}

function buildAsset(
  asset: EnrichedInventoryAsset,
  latest: ReportObservationRow | undefined,
  observationCount: number,
): RegulatorAsset {
  const obligations = asset.compliance?.obligations ?? [];
  const verified = obligations.filter((o) => o.confidence === "verified").map(toRegulatorObligation);
  const indicative = obligations.filter((o) => o.confidence !== "verified").map(toRegulatorObligation);

  const caveats = [...(asset.compliance?.caveats ?? [])];
  if (asset.compliance === null) {
    caveats.push(
      "This algorithm has no entry in the standards data at the version pinned in this document's header. No " +
        "obligation, deadline or replacement is stated for it, and it is counted toward no compliance figure.",
    );
  }
  if (asset.compliance?.detection.reviewRequired) {
    caveats.push(
      asset.compliance.detection.reason ??
        "A human must classify this call site before the finding is presented as a compliance failure.",
    );
  }

  return {
    fingerprint: asset.fingerprint,
    surface: asset.surface,
    surfaceName: surfaceLabel(asset.surface),
    algorithm: asset.algorithm,
    keySize: asset.keySize,
    keySizeNote: asset.keySize === null ? KEY_SIZE_UNDETERMINED_NOTE : null,
    location: asset.location,
    projectId: asset.projectId,
    status: asset.status,
    firstSeen: asset.firstSeen,
    lastSeen: asset.lastSeen,
    provenance: {
      collector: latest?.collector ?? null,
      collectorVersion: latest?.collectorVersion ?? null,
      observedAt: latest === undefined ? null : new Date(latest.observedAt).toISOString(),
      confidence: latest?.confidence ?? null,
      discoveryModality: latest?.discoveryModality ?? null,
      observations: observationCount,
      note:
        latest === undefined
          ? "No observation record backs this asset, so no collector, version, timestamp or confidence can be stated for it."
          : null,
    },
    classification: {
      dataClassification: asset.dataClassification,
      secrecyLifetimeYears: asset.mosca.x,
      source: asset.classificationSource,
      assumed: asset.mosca.xAssumed,
    },
    mosca: {
      x: asset.mosca.x,
      y: asset.mosca.y,
      applicable: asset.mosca.applicable,
      breachedScenarios: asset.mosca.breachedScenarios,
    },
    obligations: verified,
    indicativeObligations: indicative,
    standardsDataEntry: asset.compliance !== null,
    caveats,
  };
}

export function summariseRegulatorSubmission(input: ReportInput): RegulatorSubmission {
  const coverageLimitations = buildCoverageLimitations(input);
  const header = buildHeader(input, coverageLimitations);
  const cost = buildCostEstimate(input);

  const latest = latestObservationByAsset(input.observations);
  const observationCounts = new Map<number, number>();
  for (const observation of input.observations) {
    observationCounts.set(observation.assetId, (observationCounts.get(observation.assetId) ?? 0) + 1);
  }

  const inventory = input.assets
    .map((asset) => buildAsset(asset, latest.get(asset.id), observationCounts.get(asset.id) ?? 0))
    // Stable, content-derived order so two submissions of an unchanged
    // inventory produce the same document and therefore the same digest.
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));

  const assetsByProject = new Map<number, number>();
  for (const asset of input.assets) {
    if (asset.projectId === null) continue;
    assetsByProject.set(asset.projectId, (assetsByProject.get(asset.projectId) ?? 0) + 1);
  }

  const totalAssets = Object.values(input.statusCounts).reduce((sum, n) => sum + n, 0);
  const verifiedObligations = inventory.reduce((sum, a) => sum + a.obligations.length, 0);
  const indicativeObligations = inventory.reduce((sum, a) => sum + a.indicativeObligations.length, 0);
  const obligationsMissingRetrievalDate = inventory.reduce(
    (sum, a) =>
      sum +
      a.obligations.filter((o) => o.citationRetrievalDateMissing).length +
      a.indicativeObligations.filter((o) => o.citationRetrievalDateMissing).length,
    0,
  );

  const modalities = new Map<string, number>();
  for (const observation of input.observations) {
    modalities.set(observation.discoveryModality, (modalities.get(observation.discoveryModality) ?? 0) + 1);
  }

  return {
    kind: "regulator-submission",
    header,
    coverageLimitations,
    scope: {
      projects: input.projects
        .map((p) => ({ id: p.id, name: p.name, assets: assetsByProject.get(p.id) ?? 0 }))
        .sort((a, b) => a.id - b.id),
      assetsIncluded: input.assets.length,
      statusCounts: input.statusCounts,
      assetsExcluded: Math.max(0, totalAssets - input.assets.length),
      exclusionBasis:
        "Assets a later collection confirmed were no longer present are excluded from the inventory below. A " +
        "current-state submission must not list cryptography that has been removed; the counts by status above " +
        "are over every asset this organisation holds, so the exclusion is checkable.",
    },
    complianceClaimSummary: {
      assetsWithVerifiedObligations: inventory.filter((a) => a.obligations.length > 0).length,
      assetsWithIndicativeObligationsOnly: inventory.filter(
        (a) => a.obligations.length === 0 && a.indicativeObligations.length > 0,
      ).length,
      assetsWithNoStandardsEntry: inventory.filter((a) => !a.standardsDataEntry).length,
      verifiedObligations,
      indicativeObligations,
      obligationsMissingRetrievalDate,
      indicativeLabel: INDICATIVE_OBLIGATION_LABEL,
    },
    inventory,
    exceptions: {
      registerAvailable: false,
      statement: NO_WAIVER_REGISTER_STATEMENT,
      waivedAssets: input.assets
        .filter((a) => a.status === "waived")
        .map((a) => ({ fingerprint: a.fingerprint, algorithm: a.algorithm, location: a.location, surface: a.surface })),
      removedAssets: input.statusCounts["gone"] ?? 0,
    },
    methodology: {
      collectors: header.collectors,
      discoveryModalities: [...modalities.entries()]
        .map(([modality, observations]) => ({ modality, observations }))
        .sort((a, b) => b.observations - a.observations || a.modality.localeCompare(b.modality)),
      confidenceBasis:
        "Confidence is the collector's own, 0 to 1, recorded per observation and reported here from the most recent " +
        "observation of each asset. It expresses how certain the collector is that the cryptography it reports is " +
        "actually there — a pattern match over source text is not a handshake, and neither is a form somebody filled in.",
      limitations: [
        "Detection on the source surface is pattern-based. Patterns produce false positives and miss cryptography " +
          "they were not written for; confidence is recorded per observation so a reader can weight them.",
        "Several surfaces are submission-based rather than credentialed: the product records what an operator " +
          "supplied about a store, a key or a device, not what it independently verified.",
        "Where the size of a key could not be determined it is recorded as undetermined. Obligations keyed on " +
          "security strength are not narrowed on a guess.",
        "Obligations, deadlines and citations are resolved at read time from the standards data version pinned in " +
          "this document's header. Nothing about a standard is stored against an asset, so re-running this " +
          "submission against a later data version will restate them — which is why the version is pinned.",
        cost.statement,
      ],
    },
    assumptions: buildAssumptions(input, cost),
    integrity: {
      digestAlgorithm: "SHA-256",
      digest: "",
      signed: false,
      statement: UNSIGNED_STATEMENT,
    },
  };
}
