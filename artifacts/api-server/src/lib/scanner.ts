import { collectSourceObservations, deriveAlgorithmMapping, type RawObservation } from "@workspace/collectors";
import { logger } from "./logger";

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

  return observations.map((observation) => toScanFinding(fileName, observation));
}

function toScanFinding(fileName: string, observation: RawObservation): ScanFinding {
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

export function generateExecutiveSummary(
  findings: ScanFinding[],
  totalLines: number,
  language: string
): string {
  const criticalCount = findings.filter((f) => f.severity === "critical").length;
  const alertCount = findings.filter((f) => f.severity === "alert").length;

  const algoCounts: Record<string, number> = {};
  for (const f of findings) {
    algoCounts[f.algorithm] = (algoCounts[f.algorithm] || 0) + 1;
  }

  const topAlgo = Object.entries(algoCounts).sort((a, b) => b[1] - a[1])[0];

  if (criticalCount === 0 && alertCount === 0) {
    return `We scanned ${totalLines.toLocaleString()} lines of ${language} code and found no quantum-vulnerable cryptographic patterns. Your codebase appears quantum-safe based on detected cryptographic usage.`;
  }

  const parts = [`We scanned ${totalLines.toLocaleString()} lines of ${language} code.`];

  if (criticalCount > 0) {
    parts.push(
      `Found ${criticalCount} quantum-critical vulnerabilit${criticalCount === 1 ? "y" : "ies"} that will break on Q-Day.`
    );
  }

  if (alertCount > 0) {
    parts.push(`Found ${alertCount} weaker-crypto alert${alertCount === 1 ? "" : "s"} (not directly quantum-broken but non-PQC-safe).`);
  }

  if (topAlgo) {
    parts.push(
      `Your highest-risk pattern is ${topAlgo[0]} with ${topAlgo[1]} occurrence${topAlgo[1] === 1 ? "" : "s"}.`
    );
  }

  parts.push("Immediate migration to NIST PQC standards (FIPS 203/204/205) is recommended.");

  return parts.join(" ");
}
