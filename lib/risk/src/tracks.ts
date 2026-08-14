import { deriveAlgorithmMapping, type DerivedAlgorithmMapping } from "@workspace/collectors";

/**
 * The G-10 split: which findings are a *post-quantum* problem and which are
 * classical hygiene that must not touch the PQC score.
 *
 * docs/Claude/09-open-gaps.md G-10 — "three of the seven detection patterns
 * (MD5, SHA-1, AES-ECB) are not quantum vulnerabilities; `computeScanResult()`
 * counts them into the same severity totals and risk score as RSA and ECDSA
 * ... a CISO presenting a post-quantum risk score inflated by MD5 findings
 * will be corrected in the room."
 *
 * **The classification is derived from the mappings data, never from a list
 * of algorithm names in this file.** That is a deliberate constraint, not
 * fastidiousness: a hardcoded name list silently mis-tracks the next
 * algorithm anyone adds to `algorithms.json`, which is exactly the failure
 * G-10 records. The discriminators are, in order:
 *
 * 1. `quantumVulnerable: true`  → `pqc`. RSA, ECDSA, ECDH/DH, DSA, EdDSA.
 * 2. `quantumVulnerable: false` **and a recommended replacement exists**
 *    → `hygiene`. MD5, SHA-1, AES-ECB — real defects, no quantum content.
 * 3. `quantumVulnerable: false` and **no** replacement recommended
 *    → `acceptable`. Today that is plain AES, whose `reportingNote` says
 *    "DO NOT flag AES-128 as quantum-critical ... flagging it inflates the
 *    risk score and a knowledgeable buyer will notice". No source pattern
 *    detects bare AES right now, so this branch is unreachable from the
 *    regex collector — it exists so that adding such a pattern reports AES
 *    as adequate rather than as a hygiene defect.
 * 4. Not in `algorithms.json` at all → `unmapped`. Counted nowhere and
 *    surfaced by name, because inventing a track for an unknown algorithm is
 *    how a wrong number reaches a report.
 *
 * `reportingNote` is carried through on every track so the consumer can print
 * the qualification the data itself asks for (DSA's "report differently",
 * AES-ECB's "best practice, not a compliance failure"). Acting on those notes
 * beyond the PQC/hygiene split is G-07/G-08/G-09, which the register places
 * downstream of A4.
 */

export const RISK_TRACKS = ["pqc", "hygiene", "acceptable", "unmapped"] as const;
export type RiskTrack = (typeof RISK_TRACKS)[number];

export interface RiskTrackClassification {
  algorithm: string;
  track: RiskTrack;
  /** The mappings entry this was derived from. `null` only for `unmapped`. */
  mapping: DerivedAlgorithmMapping | null;
  /** `algorithms.json`'s own qualification for this algorithm, or `null` when it carries none. */
  reportingNote: string | null;
}

export function classifyRiskTrack(canonicalName: string): RiskTrackClassification {
  const mapping = deriveAlgorithmMapping(canonicalName);
  if (!mapping) {
    return { algorithm: canonicalName, track: "unmapped", mapping: null, reportingNote: null };
  }

  const track: RiskTrack = mapping.quantumVulnerable
    ? "pqc"
    : mapping.nistReplacement !== null
      ? "hygiene"
      : "acceptable";

  return { algorithm: canonicalName, track, mapping, reportingNote: mapping.reportingNote };
}

/** The minimum a finding must carry to be scored. Structurally satisfied by the API server's `ScanFinding`. */
export interface TrackableFinding {
  algorithm: string;
  effortHours: number;
}

export type FindingsByTrack<T extends TrackableFinding> = Record<RiskTrack, T[]>;

export function splitFindingsByTrack<T extends TrackableFinding>(findings: readonly T[]): FindingsByTrack<T> {
  const split: FindingsByTrack<T> = { pqc: [], hygiene: [], acceptable: [], unmapped: [] };
  for (const finding of findings) {
    split[classifyRiskTrack(finding.algorithm).track].push(finding);
  }
  return split;
}
