import {
  mappingEngine,
  REPORT_BUCKET_META,
  RISK_TRACK_META,
  type MappingResult,
  type ReportBucket,
} from "@workspace/mappings";
import { logger } from "./logger";

/**
 * Read-time compliance enrichment.
 *
 * Every finding the API returns is passed through the C1 mapping engine here, on the
 * way out — never frozen into the `findings` row on the way in. That is deliberate and
 * it is what fixes failure #2 in docs/Claude/05-compliance-mapping.md: a standards-data
 * update changes what *every* historical finding says, so a report generated in 2026
 * and re-read in 2028 does not disagree with a scan run yesterday. The persisted
 * `nistReplacement`/`nistStandard`/`explanation` columns are left exactly as they were
 * — this block sits alongside them and no migration was needed.
 *
 * Nothing in this file knows an algorithm name, a date or a citation.
 */

export interface FindingCompliance extends MappingResult {
  /** Customer-facing name for `bucket`. */
  bucketLabel: string;
  /** Why the finding is in that bucket, in words a CISO can hand to an auditor. */
  bucketDescription: string;
  /**
   * Whether this finding belongs in the post-quantum risk score. False for classical
   * hygiene (MD5, SHA-1, AES-ECB) — see G-10. A4 keys off this.
   */
  countsTowardPostQuantumScore: boolean;
}

const unmappedAlgorithmsWarned = new Set<string>();

/**
 * Resolve the compliance position for one detected algorithm.
 *
 * Returns `null` for an algorithm the mapping data does not know, rather than
 * inventing an obligation. The caller renders the finding without a compliance block.
 */
export function resolveCompliance(algorithm: string, options?: { asOf?: Date; confidence?: number }): FindingCompliance | null {
  const result = mappingEngine.resolve(
    { algorithm, confidence: options?.confidence },
    { asOf: options?.asOf ?? new Date() },
  );

  if (!result) {
    if (!unmappedAlgorithmsWarned.has(algorithm)) {
      unmappedAlgorithmsWarned.add(algorithm);
      logger.error({ algorithm }, "No algorithms.json mapping for a detected algorithm — finding will carry no obligations");
    }
    return null;
  }

  const bucketMeta = REPORT_BUCKET_META[result.bucket];
  return {
    ...result,
    bucketLabel: bucketMeta.label,
    bucketDescription: bucketMeta.description,
    countsTowardPostQuantumScore: RISK_TRACK_META[result.riskTrack].countsTowardPostQuantumScore,
  };
}

/** Attach a compliance block to anything carrying an `algorithm`. Used on every findings read path. */
export function withCompliance<T extends { algorithm: string }>(
  finding: T,
  options?: { asOf?: Date; confidence?: number },
): T & { compliance: FindingCompliance | null } {
  return { ...finding, compliance: resolveCompliance(finding.algorithm, options) };
}

export function withComplianceAll<T extends { algorithm: string }>(
  findings: T[],
  options?: { asOf?: Date },
): Array<T & { compliance: FindingCompliance | null }> {
  // One `asOf` for the whole response, so two findings in the same report can never be
  // resolved against different sides of a deadline.
  const asOf = options?.asOf ?? new Date();
  return findings.map((f) => withCompliance(f, { asOf }));
}

/** Counts per report bucket, for a scan-level summary. */
export function summariseBuckets(
  findings: Array<{ compliance?: FindingCompliance | null }>,
): Record<ReportBucket, number> {
  const counts = Object.fromEntries(Object.keys(REPORT_BUCKET_META).map((b) => [b, 0])) as Record<ReportBucket, number>;
  for (const finding of findings) {
    if (finding.compliance) counts[finding.compliance.bucket] += 1;
  }
  return counts;
}
