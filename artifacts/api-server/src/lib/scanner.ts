import { collectSourceObservations, deriveAlgorithmMapping, type RawObservation } from "@workspace/collectors";
import {
  computeRiskProfile,
  splitFindingsByTrack,
  CONSULTANT_HOURLY_RATE_USD,
  type HygieneSummary,
  type MoscaAssessment,
  type PqcExposure,
  type QDayScenario,
} from "@workspace/risk";
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
  /**
   * **Post-quantum exposure only, since A4.** Classical-hygiene findings
   * (MD5, SHA-1, AES-ECB) no longer contribute — see `pqc`/`hygiene` below
   * and docs/Claude/09-open-gaps.md G-10. A scan that finds only hygiene
   * issues scores 0 here and reports them in `hygiene`.
   */
  riskScore: number;
  /** Every finding's effort, both tracks. Per-track figures are on `pqc` and `hygiene`. */
  totalEffortHours: number;
  estimatedCost: number;
  executiveSummary: string;
  /** A4: the post-quantum half, with the score decomposed so a UI can explain it. */
  pqc: PqcExposure;
  /** A4/G-10: the classical-hygiene panel, scored separately and never folded into `riskScore`. */
  hygiene: HygieneSummary;
  /** A4: `X + Y > Z` evaluated against every Q-Day scenario, with all three inputs exposed. */
  mosca: MoscaAssessment;
}

/**
 * The risk-engine inputs a route can supply. All optional: A4 must not
 * require any caller to know about data classification before A3 exists.
 */
export interface ScanRiskContext {
  /**
   * X — how long this project's data must stay confidential, in years.
   *
   * **TODO(A3):** docs/Claude/03-features.md §A3 (data classification) is the
   * feature that supplies this per asset, defaulting to a project-level
   * setting. It is being built separately. Until it lands no route passes
   * this, so every scan uses `DEFAULT_SECRECY_LIFETIME_YEARS` and reports
   * `mosca.secrecyLifetimeSource === "assumed-default"` — which is what a
   * report must print beside the verdict rather than implying the customer
   * classified the data.
   */
  secrecyLifetimeYears?: number;
  /** TODO(D5): crypto-agility scoring, which divides into Y. Neutral (1) until D5 exists. */
  agilityScore?: number;
  /** Injected so a scan's verdicts are reproducible in tests. */
  now?: Date;
  /** Customer-supplied Q-Day scenarios; defaults to the three in docs/Claude/01-strategy.md. */
  scenarios?: readonly QDayScenario[];
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

/**
 * Risk, no longer derived from detection alone (A4 —
 * docs/Claude/04-architecture.md §3 "Split the risk engine from detection").
 *
 * What changed and why, in one place:
 *
 * - `riskScore` is now the **post-quantum exposure score** from
 *   `@workspace/risk`, computed over quantum-vulnerable findings only. The
 *   old formula added `alertCount` into its numerator and a flat +10 for any
 *   alert at all, so three MD5 hits made a file look post-quantum exposed.
 *   That is G-10, observed live as "a 10-line file scored risk 100, 3
 *   critical / 2 alert, where 2 of the 5 findings had nothing to do with
 *   quantum computing."
 * - `criticalCount`/`alertCount`/`cleanCount` are **unchanged**, deliberately.
 *   They are persisted columns on `scans` and `projects` read by four routes;
 *   redefining them would be a second, untested behaviour change riding along
 *   with this one. They remain "how the finding is displayed"; `pqc` and
 *   `hygiene` are "which risk this finding is".
 * - `pqc`, `hygiene` and `mosca` are additive, so every existing call site
 *   keeps working untouched.
 */
export function computeScanResult(
  findings: ScanFinding[],
  totalLines: number,
  risk: ScanRiskContext = {},
): Omit<ScanResult, "executiveSummary" | "findings"> {
  const criticalCount = findings.filter((f) => f.severity === "critical").length;
  const alertCount = findings.filter((f) => f.severity === "alert").length;
  const cleanCount = totalLines - criticalCount - alertCount;
  const totalEffortHours = findings.reduce((sum, f) => sum + f.effortHours, 0);
  const estimatedCost = Math.round(totalEffortHours * CONSULTANT_HOURLY_RATE_USD);

  const profile = computeRiskProfile(findings, {
    totalLines,
    secrecyLifetimeYears: risk.secrecyLifetimeYears,
    agilityScore: risk.agilityScore,
    now: risk.now,
    scenarios: risk.scenarios,
  });

  return {
    totalLines,
    criticalCount,
    alertCount,
    cleanCount: Math.max(0, cleanCount),
    riskScore: profile.pqc.riskScore,
    totalEffortHours,
    estimatedCost,
    pqc: profile.pqc,
    hygiene: profile.hygiene,
    mosca: profile.mosca,
  };
}

/**
 * The board-facing paragraph. A4 changes what it is allowed to claim.
 *
 * Before this change it described MD5/SHA-1/AES-ECB matches as "weaker-crypto
 * alerts (not directly quantum-broken but non-PQC-safe)" and then closed
 * every summary — including one over nothing but MD5 — with "immediate
 * migration to NIST PQC standards is recommended". Both are the G-10 category
 * error in prose: there is no PQC migration for a hash that was never
 * approved, and calling it "non-PQC-safe" implies one exists. The split is
 * now stated explicitly, and the PQC recommendation only appears when there
 * is post-quantum exposure to act on.
 *
 * `mosca` is optional so the three existing callers can adopt it
 * independently; when supplied, the summary leads with the verdict rather
 * than the finding count, which is the sentence
 * docs/Claude/01-strategy.md says a CISO actually puts in a board deck.
 */
export function generateExecutiveSummary(
  findings: ScanFinding[],
  totalLines: number,
  language: string,
  mosca?: MoscaAssessment
): string {
  const { pqc: pqcFindings, hygiene: hygieneFindings } = splitFindingsByTrack(findings);

  const topAlgo = (subset: ScanFinding[]): [string, number] | undefined => {
    const counts: Record<string, number> = {};
    for (const f of subset) counts[f.algorithm] = (counts[f.algorithm] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  };

  if (findings.length === 0) {
    return `We scanned ${totalLines.toLocaleString()} lines of ${language} code and found no quantum-vulnerable cryptographic patterns. Your codebase appears quantum-safe based on detected cryptographic usage.`;
  }

  const parts = [`We scanned ${totalLines.toLocaleString()} lines of ${language} code.`];

  if (pqcFindings.length > 0) {
    parts.push(
      `Found ${pqcFindings.length} quantum-vulnerable finding${pqcFindings.length === 1 ? "" : "s"} that will break on Q-Day.`
    );
    const top = topAlgo(pqcFindings);
    if (top) {
      parts.push(`Your highest-exposure algorithm is ${top[0]} with ${top[1]} occurrence${top[1] === 1 ? "" : "s"}.`);
    }
  } else {
    parts.push("Found no quantum-vulnerable cryptography, so the post-quantum exposure score is zero.");
  }

  if (hygieneFindings.length > 0) {
    const top = topAlgo(hygieneFindings);
    parts.push(
      `Separately, ${hygieneFindings.length} classical-hygiene finding${hygieneFindings.length === 1 ? "" : "s"}${top ? ` (mostly ${top[0]})` : ""} — real cryptographic weaknesses, but not quantum vulnerabilities, and excluded from the post-quantum score.`
    );
  }

  if (mosca && mosca.applicable) {
    parts.push(
      mosca.breachedScenarioCount > 0
        ? `Mosca's inequality is breached under ${mosca.breachedScenarioCount} of ${mosca.scenarioCount} Q-Day scenarios (secrecy lifetime ${mosca.x} years${mosca.secrecyLifetimeSource === "assumed-default" ? ", assumed — no data classification set" : ""}, migration ${mosca.y} years).`
        : `Mosca's inequality holds under all ${mosca.scenarioCount} Q-Day scenarios at a secrecy lifetime of ${mosca.x} years${mosca.secrecyLifetimeSource === "assumed-default" ? " (assumed — no data classification set)" : ""}.`
    );
  }

  if (pqcFindings.length > 0) {
    parts.push("Migration to NIST PQC standards (FIPS 203/204/205) is recommended for the quantum-vulnerable findings.");
  }

  return parts.join(" ");
}
