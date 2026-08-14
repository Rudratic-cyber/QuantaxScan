import algorithmsData from "../../../docs/Claude/mappings/algorithms.json" with { type: "json" };

/**
 * Read-time derivation of standards data from the versioned
 * `docs/Claude/mappings/algorithms.json` (schemaVersion 1.0.0). This is the
 * mechanism docs/Claude/04-architecture.md describes: `nistReplacement`,
 * `nistStandard`, `explanation` and `severity` are no longer frozen into a
 * pattern table or a persisted row — they are looked up by canonical
 * algorithm name whenever a finding is displayed, so a mappings-data update
 * changes every future read without touching historical rows.
 *
 * This module is intentionally small: a by-canonical-name lookup and a
 * severity/effort/replacement derivation, nothing more. It is not the C1
 * dynamic mapping engine (deadline resolution, security-strength keying,
 * crosswalks) — that is out of scope here; see docs/Claude/09-open-gaps.md
 * and docs/Claude/03-features.md §C.
 *
 * `algorithms.json` is imported as a JSON module so esbuild inlines it into
 * the built bundle at compile time — there is no runtime filesystem lookup
 * to get wrong across the Docker build/deploy boundary.
 *
 * IR 8547, the source most of this data cites, is an **initial public
 * draft**, not final NIST guidance — see `algorithms.json`'s own
 * `criticalCaveat` field, which must be surfaced anywhere this data reaches
 * a customer.
 */

interface AlgorithmReplacement {
  purpose: string;
  algorithm: string;
  standard: string;
  note?: string;
}

interface AlgorithmEntry {
  id: string;
  canonicalName: string;
  aliases: string[];
  quantumVulnerable: boolean;
  baseEffortHours: number;
  replacements: AlgorithmReplacement[];
  explanation: string;
  reportingNote?: string;
  confidence: string;
  citation: { document: string; section?: string; url: string; retrievedAt: string };
}

interface AlgorithmsFile {
  dataVersion: string;
  criticalCaveat: string;
  algorithms: AlgorithmEntry[];
}

const data = algorithmsData as unknown as AlgorithmsFile;

const byCanonicalName = new Map<string, AlgorithmEntry>(data.algorithms.map((a) => [a.canonicalName, a]));

/**
 * The mappings snapshot this build resolves against. Exported so a consumer
 * can stamp provenance on a derived artefact (a risk profile, a report)
 * without having to look up an arbitrary algorithm to read it off.
 */
export const MAPPINGS_DATA_VERSION: string = data.dataVersion;

export interface DerivedAlgorithmMapping {
  severity: "critical" | "alert";
  /**
   * `algorithms.json`'s own `quantumVulnerable` flag, surfaced verbatim
   * rather than left implicit behind `severity`. It is the field the A4 risk
   * engine splits the post-quantum track from the classical-hygiene track on
   * (docs/Claude/09-open-gaps.md G-10) — reading it from the mappings data is
   * what keeps that split out of a hardcoded list of algorithm names. Note
   * that `severity` is a *display* derivation that happens to agree with it
   * today; the two are not the same claim and should not be conflated.
   */
  quantumVulnerable: boolean;
  nistReplacement: string | null;
  nistStandard: string | null;
  explanation: string;
  effortHours: number;
  /** Non-null when the finding needs qualification before it reaches a customer (e.g. draft-guidance caveats, use-dependence). */
  reportingNote: string | null;
  citation: { document: string; url: string };
  /** Data-versioning provenance, so a caller can tell which mappings snapshot produced this derivation. */
  dataVersion: string;
}

/**
 * Derive display fields for a canonical algorithm name at read time.
 * Returns `undefined` for a name absent from `algorithms.json` — the caller
 * decides how to handle an unmapped algorithm rather than this module
 * inventing placeholder standards data.
 */
export function deriveAlgorithmMapping(canonicalName: string): DerivedAlgorithmMapping | undefined {
  const entry = byCanonicalName.get(canonicalName);
  if (!entry) return undefined;

  const replacementNames = [...new Set(entry.replacements.map((r) => r.algorithm))];
  const standardNames = [...new Set(entry.replacements.map((r) => r.standard))];

  return {
    severity: entry.quantumVulnerable ? "critical" : "alert",
    quantumVulnerable: entry.quantumVulnerable,
    nistReplacement: replacementNames.length ? replacementNames.join(" or ") : null,
    nistStandard: standardNames.length ? standardNames.join(" / ") : null,
    explanation: entry.explanation,
    effortHours: entry.baseEffortHours,
    reportingNote: entry.reportingNote ?? null,
    citation: { document: entry.citation.document, url: entry.citation.url },
    dataVersion: data.dataVersion,
  };
}
