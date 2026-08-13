import { collectSourceObservations, deriveAlgorithmMapping, type RawObservation } from "@workspace/collectors";
import { logger } from "./logger";
import { resolveCompliance, summariseBuckets, type FindingCompliance } from "./compliance";
import type { ReportBucket } from "@workspace/mappings";

export interface ScanFinding {
  fileName: string;
  lineNumber: number;
  severity: "critical" | "alert" | "safe";
  algorithm: string;
  codeSnippet: string;
  nistReplacement: string | null;
  nistStandard: string | null;
  effortHours: number;
  explanation: string;
  /**
   * The C1 mapping engine's answer for this algorithm: which obligations bind, under
   * which framework, by when, with what citation and confidence. `null` when the
   * mapping data has no entry for the algorithm — the finding still reports, it just
   * carries no obligations rather than an invented one.
   *
   * Deliberately NOT persisted. `findings` rows keep only the legacy
   * `nistReplacement`/`nistStandard`/`explanation` columns; this block is derived on
   * every read (see `lib/compliance.ts`) so a mappings-data update reaches historical
   * findings too. That is failure #2 in docs/Claude/05-compliance-mapping.md.
   */
  compliance: FindingCompliance | null;
}

export interface ScanResult {
  findings: ScanFinding[];
  totalLines: number;
  criticalCount: number;
  alertCount: number;
  cleanCount: number;
  riskScore: number;
  totalEffortHours: number;
  estimatedCost: number;
  executiveSummary: string;
}

/**
 * `scanCode()` is a thin back-compat shim over `@workspace/collectors`'s
 * `SourceRegexCollector` (via its synchronous `collectSourceObservations`),
 * kept because four routes (`scans.ts`, `projects.ts`, `demo.ts`,
 * `github.ts`) call it synchronously and expect exactly this `ScanFinding`
 * shape. docs/Claude/04-architecture.md §2: "The existing regex scanner
 * becomes `SourceRegexCollector` — one implementation, unchanged in
 * behaviour". Detection (which line matches which algorithm) is unchanged;
 * `nistReplacement`/`nistStandard`/`explanation`/`severity` are no longer
 * frozen pattern-table copy — they are derived at call time from
 * `docs/Claude/mappings/algorithms.json` (see `algorithm-mapping.ts`), so a
 * mappings-data update changes future scans without touching historical
 * rows. That means this copy text can differ from the original hardcoded
 * strings — deliberately; see docs/Claude/09-open-gaps.md G-11/G-15.
 */
export function scanCode(code: string, fileName: string, _language: string): ScanFinding[] {
  const observations = collectSourceObservations({
    kind: "source",
    repo: "", // scanCode() has no repository identity to offer — see routes/scans.ts for where a real one is threaded through for asset persistence
    files: [{ path: fileName, content: code, language: _language }],
  });

  // One resolution date for the whole scan: two findings in the same report must never
  // land on opposite sides of a deadline because the clock ticked mid-loop.
  const asOf = new Date();
  return observations.map((observation) => toScanFinding(fileName, observation, asOf));
}

function toScanFinding(fileName: string, observation: RawObservation, asOf: Date): ScanFinding {
  const mapping = deriveAlgorithmMapping(observation.algorithm);
  if (!mapping) {
    // Every SOURCE_PATTERNS algorithm name is asserted to exist in
    // algorithms.json (see lib/collectors/src/algorithm-mapping.test.ts).
    // This branch means that invariant broke — log loudly rather than
    // silently inventing standards data.
    logger.error({ algorithm: observation.algorithm }, "No algorithms.json mapping for a detected algorithm");
  }
  const lineNumber = (observation.evidence.lineNumber as number | undefined) ?? 0;
  const codeSnippet = (observation.evidence.codeSnippet as string | undefined) ?? "";
  return {
    fileName,
    lineNumber,
    severity: mapping?.severity ?? "alert",
    algorithm: observation.algorithm,
    codeSnippet,
    nistReplacement: mapping?.nistReplacement ?? null,
    nistStandard: mapping?.nistStandard ?? null,
    effortHours: mapping?.effortHours ?? 1,
    explanation: mapping?.explanation ?? "",
    compliance: resolveCompliance(observation.algorithm, { asOf }),
  };
}

export function computeScanResult(findings: ScanFinding[], totalLines: number): Omit<ScanResult, "executiveSummary" | "findings"> {
  const criticalCount = findings.filter((f) => f.severity === "critical").length;
  const alertCount = findings.filter((f) => f.severity === "alert").length;
  const cleanCount = totalLines - criticalCount - alertCount;
  const totalEffortHours = findings.reduce((sum, f) => sum + f.effortHours, 0);
  const estimatedCost = Math.round(totalEffortHours * 500); // $500/hr security consultant rate

  // Risk score 0-100: higher = more vulnerable
  const riskScore = Math.min(
    100,
    Math.round(
      (criticalCount * 3 + alertCount) /
        Math.max(1, totalLines) *
        1000 +
        (criticalCount > 0 ? 40 : 0) +
        (alertCount > 0 ? 10 : 0)
    )
  );

  return {
    totalLines,
    criticalCount,
    alertCount,
    cleanCount: Math.max(0, cleanCount),
    riskScore: Math.min(100, riskScore),
    totalEffortHours,
    estimatedCost,
  };
}

const plural = (n: number, singular: string, pluralForm = `${singular}s`) => (n === 1 ? singular : pluralForm);

function distinctAlgorithms(findings: ScanFinding[]): string {
  return [...new Set(findings.map((f) => f.algorithm))].join(", ");
}

/**
 * The executive summary is the single most-quoted sentence the product emits, so it is
 * the place a false compliance claim does the most damage.
 *
 * It used to assert two things that are not true of every finding: that an alert was
 * "not directly quantum-broken but non-PQC-safe" (wrong for SHA-1 and AES-ECB, which
 * have nothing to do with PQC — G-08/G-09), and, unconditionally, that "immediate
 * migration to NIST PQC standards is recommended" (asserted over MD5 and ECB findings
 * too). It now speaks per bucket, and every standard it names is read back out of the
 * obligations the mapping engine resolved rather than written here.
 */
export function generateExecutiveSummary(
  findings: ScanFinding[],
  totalLines: number,
  language: string
): string {
  const scanned = `We scanned ${totalLines.toLocaleString()} lines of ${language} code`;
  if (findings.length === 0) {
    return `${scanned} and found no cryptographic patterns requiring attention. Note this reflects detected usage only — see the coverage panel for what was not examined.`;
  }

  const buckets = summariseBuckets(findings);
  const inBucket = (bucket: ReportBucket) => findings.filter((f) => f.compliance?.bucket === bucket);
  const parts = [`${scanned}.`];

  const immediate = inBucket("immediate-compliance-failure");
  if (immediate.length > 0) {
    parts.push(
      `${immediate.length} ${plural(immediate.length, "finding")} ${plural(immediate.length, "is", "are")} non-compliant now, with no migration runway (${distinctAlgorithms(immediate)}) — these rank ahead of the dated migration work.`
    );
  }

  const migration = inBucket("pqc-migration");
  if (migration.length > 0) {
    parts.push(
      `${migration.length} quantum-vulnerable ${plural(migration.length, "finding")} (${distinctAlgorithms(migration)}) ${plural(migration.length, "carries", "carry")} a published transition deadline.`
    );
  }

  // Keyed on the risk track, not on the bucket: MD5 and SHA-1 are immediate compliance
  // failures *and* classical hygiene, and a reader must not infer a quantum problem
  // from a bucket that says "non-compliant now" (G-10).
  const hygiene = findings.filter((f) => f.compliance && !f.compliance.countsTowardPostQuantumScore);
  if (hygiene.length > 0) {
    const bestPractice = buckets["best-practice"];
    const bestPracticeClause = bestPractice > 0
      ? ` ${bestPractice} of ${plural(bestPractice, "them")} ${plural(bestPractice, "is", "are")} a best-practice recommendation that violates no standard.`
      : "";
    parts.push(
      `${hygiene.length} ${plural(hygiene.length, "finding")} (${distinctAlgorithms(hygiene)}) ${plural(hygiene.length, "is", "are")} classical hygiene — unrelated to quantum computing, and excluded from the post-quantum picture.${bestPracticeClause}`
    );
  }

  const needsReview = findings.filter((f) => f.compliance?.detection.reviewRequired);
  if (needsReview.length > 0) {
    parts.push(
      `${needsReview.length} ${plural(needsReview.length, "finding")} (${distinctAlgorithms(needsReview)}) ${plural(needsReview.length, "depends", "depend")} on how the algorithm is used, which a pattern match cannot see — confirm the call site before treating ${plural(needsReview.length, "it", "them")} as a failure.`
    );
  }

  // Only recommend a PQC migration when something actually needs one, and name the
  // target standards the resolved obligations name — not a constant written here.
  const replacementStandards = [
    ...new Set(
      migration
        .flatMap((f) => f.compliance?.obligations ?? [])
        .map((o) => o.replacement?.standard)
        .filter((s): s is string => Boolean(s))
    ),
  ].sort();
  if (replacementStandards.length > 0) {
    parts.push(`Migrate the quantum-vulnerable findings to the approved post-quantum replacements (${replacementStandards.join(" / ")}).`);
  }

  if (findings.some((f) => f.compliance?.obligations.some((o) => o.draftStatus))) {
    parts.push("Some transition dates quoted here come from draft guidance, labelled on each obligation.");
  }

  return parts.join(" ");
}
