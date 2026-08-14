import type { ReportBucket, RiskTrack } from "./types";

/**
 * Presentation metadata for the report buckets.
 *
 * This is engine vocabulary, not standards data, so it lives in TypeScript: adding a
 * NIST date never touches it. `countsTowardPostQuantumScore` is the contract A4 (the
 * Mosca risk engine) consumes to close G-10 — a hygiene finding must not inflate a
 * post-quantum risk score, and the decision is keyed on `riskTrack`, not on severity.
 */
export const REPORT_BUCKET_META: Record<ReportBucket, { label: string; description: string; order: number }> = {
  "immediate-compliance-failure": {
    order: 1,
    label: "Immediate compliance failure",
    description:
      "A prohibition that is already in force covers this use. There is no migration runway and no deadline to plan against — it is non-compliant today.",
  },
  "pqc-migration": {
    order: 2,
    label: "Post-quantum migration",
    description:
      "Quantum-vulnerable, with a published transition timeline. Plan the migration against the deadline shown on each obligation.",
  },
  "classical-hygiene": {
    order: 3,
    label: "Classical hygiene",
    description:
      "A classical weakness with a standards obligation attached. Unrelated to quantum computing and tracked separately from post-quantum risk.",
  },
  "best-practice": {
    order: 4,
    label: "Best practice",
    description:
      "No standard is being violated. This is a cryptographic-hygiene recommendation, and presenting it as a compliance failure would not survive an auditor checking the citation.",
  },
  "no-obligation": {
    order: 5,
    label: "No obligation",
    description: "The loaded standards data records no obligation for this algorithm.",
  },
};

export const RISK_TRACK_META: Record<RiskTrack, { label: string; countsTowardPostQuantumScore: boolean }> = {
  "post-quantum": { label: "Post-quantum exposure", countsTowardPostQuantumScore: true },
  "classical-hygiene": { label: "Classical hygiene", countsTowardPostQuantumScore: false },
};

/** Sort order for grouping findings in a report. */
export function bucketOrder(bucket: ReportBucket): number {
  return REPORT_BUCKET_META[bucket]?.order ?? 99;
}
