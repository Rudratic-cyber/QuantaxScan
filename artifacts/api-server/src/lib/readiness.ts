import type { ProjectCoverage } from "./coverage";

/**
 * D1 — the CISA quantum-readiness posture tracker, computed.
 * docs/Claude/03-features.md §D1, docs/Claude/06-cisa-dashboard.md §"Row 1".
 *
 * Five sections, one per named part of the joint CISA/NSA/NIST factsheet
 * ("Quantum-Readiness: Migration to Post-Quantum Cryptography", August
 * 2023). The doc is explicit that the factsheet is **not** a numbered
 * five-stage roadmap — an earlier draft invented one, and this file must not
 * repeat that mistake. `framing` below states the source and its date; no
 * other prose here quotes or paraphrases the factsheet's own wording.
 *
 * The honesty rule this module exists to hold: **two of five sections have
 * no data source in this product today** (there is no roadmap-document
 * attachment feature and no vendor register — B9 is unbuilt), and a third
 * (supply chain) only has half of one (dependency evidence exists; COTS/
 * cloud-provider assessment does not, and no "threshold" is defined
 * anywhere in this codebase to compare dependency coverage against). A
 * section with no data source renders `percentComplete: null` and a
 * `state` of `"not-tracked"` — never `0`, which would assert a measurement
 * nobody took. Pure and drizzle-free, for the same reason `coverage.ts` and
 * `posture-timeline.ts` are: every judgement call here is a claim about
 * honesty and belongs in a unit test.
 */

export const READINESS_FACTSHEET_FRAMING =
  "Aligned to the joint CISA/NSA/NIST quantum-readiness guidance, \"Quantum-Readiness: Migration to " +
  "Post-Quantum Cryptography\" (TLP:CLEAR, as of August 17, 2023). The factsheet is organised into " +
  "named sections, not a numbered stage sequence — nothing below should be read as a CISA-authored " +
  "numbering.";

export type ReadinessSectionId =
  | "roadmap"
  | "cryptographic-inventory"
  | "prioritisation"
  | "vendor-engagement"
  | "supply-chain";

export interface ReadinessSection {
  id: ReadinessSectionId;
  label: string;
  /** What "complete" means for this section, stated plainly rather than left implicit. */
  definition: string;
  /**
   * `tracked` — this product holds data this section can be computed from.
   * `not-tracked` — no data source exists; showing 0% here would be a
   * measurement nobody took, so the section says so instead.
   */
  state: "tracked" | "not-tracked";
  /** Null exactly when `state` is `not-tracked`. Never a guessed number. */
  percentComplete: number | null;
  numerator: number | null;
  denominator: number | null;
  reason: string;
}

export interface ReadinessAssetRow {
  status: string;
  /** `resolveSecrecyLifetime(...).classificationSource` — "asset" | "project" | "default". */
  classificationSource: "asset" | "project" | "default";
}

export interface ReadinessInput {
  /** Estate-wide, i.e. `summariseProjectCoverage` called with every run/asset/observation in the organisation, unfiltered by project. */
  coverage: ProjectCoverage;
  /** Present assets (status !== "gone") across the whole organisation, with their resolved classification provenance. */
  presentAssets: ReadinessAssetRow[];
  /** Count of assets on the `dependency` surface — informative context for the supply-chain section, not a completeness fraction (no threshold is defined). */
  dependencyAssetCount: number;
}

export interface ReadinessSummary {
  generatedAt: string;
  framing: string;
  sections: ReadinessSection[];
}

function roundPct(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 100);
}

export function summariseReadiness(input: ReadinessInput, now: Date = new Date()): ReadinessSummary {
  const { coverage, presentAssets, dependencyAssetCount } = input;

  const roadmap: ReadinessSection = {
    id: "roadmap",
    label: "Roadmap",
    definition: "A roadmap document is attached and dated within 12 months.",
    state: "not-tracked",
    percentComplete: null,
    numerator: null,
    denominator: null,
    reason:
      "This product has no roadmap-document attachment feature yet. Nothing here can attest to whether " +
      "one exists or how current it is — that is the customer's own artifact (see the factsheet table: " +
      "\"Establish a quantum-readiness roadmap\" is the customer's job, evidence and a template are ours).",
  };

  // "Cryptographic inventory" — the one section this product exists to
  // automate. Uses the same surfaces-not-assets denominator as D3's meter;
  // the fraction below is "surfaces examined", never re-labelled as a
  // percentage of estate assets (coverage.ts rule 4).
  const inventoryPct =
    coverage.totalSurfaces === 0 ? null : roundPct(coverage.examinedSurfaces, coverage.totalSurfaces);
  const cryptographicInventory: ReadinessSection = {
    id: "cryptographic-inventory",
    label: "Cryptographic inventory",
    definition:
      "≥N surfaces collected, last collection within SLA, coverage gaps acknowledged. This product has " +
      "no SLA concept yet, so that clause is not evaluated; the gap-acknowledgement clause is what the " +
      "coverage panel on this page IS — every unexamined surface is listed, not hidden.",
    state: inventoryPct === null ? "not-tracked" : "tracked",
    percentComplete: inventoryPct,
    numerator: coverage.examinedSurfaces,
    denominator: coverage.totalSurfaces,
    reason:
      inventoryPct === null
        ? "The collector catalogue is empty, which should not happen."
        : `${coverage.examinedSurfaces} of ${coverage.totalSurfaces} collector surfaces have ever produced ` +
          `evidence in this organisation. This is a count of surfaces, not a percentage of the estate — how ` +
          `much cryptography sits in the unexamined surfaces is unknowable from this data.`,
  };

  // "Prioritisation" — every present asset needs a classification decision
  // (asset- or project-level; "default" means nobody made one) and a Mosca
  // verdict. A verdict is always computable (A4 defaults X when unsupplied),
  // so the only real gate here is whether a classification was actually set.
  const classifiedCount = presentAssets.filter((a) => a.classificationSource !== "default").length;
  const prioritisation: ReadinessSection = {
    id: "prioritisation",
    label: "Prioritisation",
    definition: "Every asset has a data classification and a Mosca verdict.",
    state: presentAssets.length === 0 ? "not-tracked" : "tracked",
    percentComplete: presentAssets.length === 0 ? null : roundPct(classifiedCount, presentAssets.length),
    numerator: presentAssets.length === 0 ? null : classifiedCount,
    denominator: presentAssets.length === 0 ? null : presentAssets.length,
    reason:
      presentAssets.length === 0
        ? "No assets are in the inventory yet, so there is nothing to prioritise."
        : `A Mosca verdict is computed for every present asset regardless (defaults apply where a value is ` +
          `not supplied). ${classifiedCount} of ${presentAssets.length} carry an explicit data ` +
          `classification, at the asset or its project; the rest are scored against this product's default, ` +
          `which every verdict marks as an assumption rather than a customer-supplied fact.`,
  };

  const vendorEngagement: ReadinessSection = {
    id: "vendor-engagement",
    label: "Vendor engagement",
    definition: "Every third-party in the register has a recorded PQC position and a review date.",
    state: "not-tracked",
    percentComplete: null,
    numerator: null,
    denominator: null,
    reason:
      "No vendor register exists in this product yet (roadmap B9). Nothing here can say how many vendors " +
      "have been engaged, so this section is not scored rather than scored as zero.",
  };

  const supplyChain: ReadinessSection = {
    id: "supply-chain",
    label: "Supply chain",
    definition: "Dependency coverage above threshold; COTS and cloud providers assessed.",
    state: "not-tracked",
    percentComplete: null,
    numerator: null,
    denominator: null,
    reason:
      dependencyAssetCount > 0
        ? `${dependencyAssetCount} dependency-surface asset(s) have been submitted for lockfile analysis, ` +
          `but no threshold for "dependency coverage" is defined anywhere in this product, and there is no ` +
          `COTS or cloud-provider assessment feature at all — so this section is not scored.`
        : "No dependency evidence has been submitted, and there is no COTS or cloud-provider assessment " +
          "feature in this product yet — so this section is not scored.",
  };

  return {
    generatedAt: now.toISOString(),
    framing: READINESS_FACTSHEET_FRAMING,
    sections: [roadmap, cryptographicInventory, prioritisation, vendorEngagement, supplyChain],
  };
}
