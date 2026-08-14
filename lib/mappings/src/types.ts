/**
 * The public contract of the C1 mapping engine.
 *
 * Everything here is a *shape*. No algorithm name, date, citation or
 * standards claim appears in this package's TypeScript — those live in
 * `docs/Claude/mappings/*.json` and reach the caller through these types.
 * See docs/Claude/05-compliance-mapping.md.
 */

/** How a finding should be tracked for risk scoring. Derived from `quantumVulnerable`. */
export type RiskTrack = "post-quantum" | "classical-hygiene";

/**
 * Where the finding stands against the standards data *at `asOf`*.
 *
 * - `immediate-failure` — a prohibition that is already in effect covers a use of this
 *   algorithm. There is no runway. (DSA signature generation, MD5, SHA-1 signing.)
 * - `future-obligation` — a deprecation or disallowance is scheduled but not yet in effect.
 * - `no-obligation` — no standard prohibits it. May still be a best-practice finding.
 */
export type ComplianceStatus = "immediate-failure" | "future-obligation" | "no-obligation";

/**
 * Report grouping. `immediate-compliance-failure` deliberately outranks `pqc-migration`
 * so a DSA signing site is not filed alongside RSA under a 2035 horizon — see G-07.
 */
export type ReportBucket =
  | "immediate-compliance-failure"
  | "pqc-migration"
  | "classical-hygiene"
  | "best-practice"
  | "no-obligation";

export type ObligationSeverity = "critical" | "high" | "medium" | "informational";

/** What a deadline type *does*, read from `algorithms.json`'s `deadlineTypes` block. */
export type DeadlineEffect = "prohibition" | "caution" | "permitted";

export interface Citation {
  document: string;
  section?: string;
  url: string;
  retrievedAt?: string;
  published?: string;
}

export interface ObligationDeadline {
  /** The raw vocabulary term from the data (`disallowed`, `not-approved`, ...). */
  type: string;
  /** Customer-facing label for that term, from `deadlineTypes`. */
  label: string;
  effect: DeadlineEffect;
  /** True when this rule binds at the resolution date. */
  inEffect: boolean;
  /** Effective from the day after this year ends. */
  after?: string;
  /** Effective from the start of this year. */
  in?: string;
  /** Effective from this date. */
  since?: string;
  /** Which use of the algorithm the rule covers. Load-bearing for SHA-1 and DSA. */
  appliesTo?: string;
  /** Security strength the rule is keyed on, when the data keys it that way (IR 8547). */
  securityStrength?: string;
  source?: string;
  note?: string;
}

export interface ObligationReplacement {
  algorithm: string;
  standard: string;
  purpose?: string;
  note?: string;
}

export type ObligationSource =
  | "algorithm-deadline"
  | "algorithm-replacement"
  | "algorithm-best-practice"
  | "framework";

export interface Obligation {
  /** Framework id exactly as the data writes it. */
  framework: string;
  frameworkName?: string;
  requirement: string;
  severity: ObligationSeverity;
  replacement?: ObligationReplacement;
  deadline?: ObligationDeadline;
  citation: Citation;
  /** `verified` or `needs-check`, straight from the data. Never upgraded here. */
  confidence: string;
  /** Set when the citing document is a draft; must be shown wherever the obligation is. */
  draftStatus?: string;
  /** Anything that must travel with this claim (unverified sources, per-category dates, ...). */
  caveats: string[];
  source: ObligationSource;
}

/** One row of the "which uses are actually disallowed" table. Populated when the rule is use-dependent. */
export interface UseCondition {
  use: string;
  status: string;
  permitted: boolean;
  framework: string;
}

/** How much of the finding the collector could actually establish. */
export interface DetectionQualifier {
  /** Multiplier applied to the collector's own confidence, from the data. 1 when unqualified. */
  multiplier: number;
  /** `baseConfidence * multiplier`, present only when a base confidence was supplied. */
  adjustedConfidence?: number;
  /** True when a human must classify the call site before this is presented as a failure. */
  reviewRequired: boolean;
  /** Why, in customer-facing words. From the data. */
  reason: string | null;
}

/** What the engine is asked about. A subset of `RawObservation` — the engine never sees a database. */
export interface MappingInput {
  /** Canonical name, alias or entry id. Matched case-insensitively. */
  algorithm: string;
  /** Stated parameter size, not a security strength. Optional and never guessed — see G-05. */
  keySize?: number | null;
  /** The collector's own confidence, 0..1, if the caller has it. */
  confidence?: number;
}

/** Filters frameworks whose applicability does not cover the customer. See doc 05 "Applicability — do not over-claim". */
export interface CustomerProfile {
  jurisdiction?: string;
  sector?: string;
  systemType?: string;
}

export interface ResolveOptions {
  /** Resolution date. Deadlines are evaluated against it. Defaults to now. */
  asOf?: Date | string;
  /** Assert the loaded data is this `dataVersion`; throws `MappingVersionError` if not. */
  version?: string;
  /** Omit and only universally-applicable frameworks are used. */
  profile?: CustomerProfile;
}

export interface MappingResult {
  /** Canonical name from the data, not the string the caller passed in. */
  algorithm: string;
  algorithmId: string;
  quantumVulnerable: boolean;
  riskTrack: RiskTrack;
  complianceStatus: ComplianceStatus;
  bucket: ReportBucket;
  /** One sentence, composed entirely from data fields. Safe to print. */
  headline: string;
  /** True when the standard's answer depends on how the algorithm is used (SHA-1, DSA). */
  useDependent: boolean;
  useConditions: UseCondition[];
  obligations: Obligation[];
  detection: DetectionQualifier;
  /** Internal reporting instruction from the data, e.g. "do not count toward the PQC score". */
  reportingNote: string | null;
  /** Everything that must be shown alongside this result. */
  caveats: string[];
  citation: Citation;
  /** Provenance: which `algorithms.json` snapshot produced this. Pin it with the report. */
  dataVersion: string;
  /** ISO date the deadlines were evaluated against. */
  asOf: string;
}

export interface MappingEngine {
  readonly dataVersion: string;
  readonly frameworksDataVersion: string;
  /** Returns `undefined` for an algorithm absent from the data — the caller decides, this never invents standards. */
  resolve(input: MappingInput, options?: ResolveOptions): MappingResult | undefined;
  /** Canonical names of every algorithm the data knows. */
  listAlgorithms(): string[];
}
