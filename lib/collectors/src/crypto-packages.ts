import cryptoPackagesData from "../../../docs/Claude/mappings/crypto-packages.json" with { type: "json" };
import type { Ecosystem } from "./lockfiles";
import { normalisePackageName } from "./lockfiles";

/**
 * The curated package → algorithm table behind B2. Every entry answers one
 * question: *if this package is in the dependency graph, which
 * quantum-relevant primitives does it put there?*
 *
 * **The table itself is data, not code.** It lives in
 * `docs/Claude/mappings/crypto-packages.json` alongside `algorithms.json`,
 * loaded here as a JSON module exactly the way `algorithm-mapping.ts` loads
 * that file. This module is now the lookup and the schema, nothing more.
 *
 * It used to be a `CryptoPackageEntry[]` literal in this file, and moving it
 * closes the gap its own header flagged: unlike everything under
 * `docs/Claude/mappings/`, it carried no citation and no
 * `verified`/`needs-check` tag, so every row was an uncited claim from
 * general knowledge feeding the same customer-facing reports that four
 * corrected claims (G-05, G-07, G-08, G-09) taught this project to distrust.
 * Three consequences of the move, all intended:
 *
 *  1. **A data revision no longer requires a code edit** — C1's rule, which
 *     `lib/mappings` already lives by.
 *  2. **`pnpm run check:standards` now polices this file**, because it walks
 *     every `retrievedAt` under `docs/Claude/mappings/`. A claim verified
 *     against a package's README will expire after 180 days and demand a
 *     re-read. That is the point: a library's algorithm set changes (paramiko
 *     removed DSA in 4.0.0; jsrsasign removed RSA encryption in 11.0.0), and
 *     nothing else in this repository would have noticed.
 *  3. **`needs-check` entries deliberately carry no `retrievedAt`**, so the
 *     freshness check cannot be satisfied by dating an unverified claim.
 *
 * `verified` means a verbatim quote from the package's own documentation
 * supports the claim on the date recorded. It does **not** mean the claim was
 * checked against the version a given lockfile pins — see the file's
 * `curationRules`, and docs/Claude/09-open-gaps.md G-21.
 *
 * `tier` records how strong the inference is, and becomes the observation's
 * confidence — see `dependency-collector.ts`. It is a property of the
 * *package*, not of the parse: the parse itself is exact either way.
 */

export type EvidenceTier =
  /** The package exists to implement this primitive. Presence ⇒ the primitive is available and almost certainly used. */
  | "dedicated"
  /** One of several primitives the package offers. Presence proves the library is shipped; which primitive the caller uses is unknown. */
  | "multi-primitive";

/** Provenance status. See the JSON's `statusValues` block, which is the customer-facing definition. */
export type CurationStatus = "verified" | "needs-check";

export interface Citation {
  document: string;
  url?: string;
  /** Present only on `verified` claims. Its absence is what keeps `check:standards` honest about the rest. */
  retrievedAt?: string;
  /** Verbatim, from the cited page. A citation without a quote is the unverified claim G-07 punished. */
  quote?: string;
}

export interface CryptoPackageAlgorithm {
  /** `canonicalName` from `algorithms.json`. */
  algorithm: string;
  tier: EvidenceTier;
  /** The one named curve this package pins, when it pins exactly one — resolves to a key size via `named-curves.ts`. Omitted when the package is curve-agnostic. */
  curve?: string;
  /** Why the package implies the algorithm. Carried into `evidence` so a reader can judge the inference rather than trust it. */
  rationale: string;
  /** Overrides the package's status for this one claim — e.g. a claim true only of some major versions. */
  status?: CurationStatus;
  needsCheckReason?: string;
}

export interface CryptoPackageEntry {
  ecosystem: Ecosystem;
  /** Normalised name (see `normalisePackageName`). */
  name: string;
  status: CurationStatus;
  citation?: Citation;
  needsCheckReason?: string;
  /**
   * Flags a package that is a near-universal transitive dependency of the JS
   * toolchain (`elliptic`, `sha.js`). Not a suppression: the package really is
   * in the graph and really does implement the primitive. It marks the
   * findings whose reading is most likely to be over-read as a statement
   * about first-party code — see docs/Claude/09-open-gaps.md G-20.
   */
  toolchainUbiquity?: boolean;
  note?: string;
  algorithms: CryptoPackageAlgorithm[];
}

interface CryptoPackagesFile {
  schemaVersion: string;
  dataVersion: string;
  criticalCaveat: string;
  evidenceTiers: Record<EvidenceTier, { confidence: number; meaning: string; rationale: string }>;
  packages: CryptoPackageEntry[];
}

const data = cryptoPackagesData as unknown as CryptoPackagesFile;

export const CRYPTO_PACKAGES: readonly CryptoPackageEntry[] = data.packages;

/** The snapshot this build resolves against, for stamping provenance on a derived artefact. */
export const CRYPTO_PACKAGES_DATA_VERSION: string = data.dataVersion;

/**
 * The caveat every dependency finding has to carry. Data, not a string
 * constant in TypeScript, for the same reason the algorithm explanations are.
 */
export const CRYPTO_PACKAGES_CRITICAL_CAVEAT: string = data.criticalCaveat;

/**
 * Confidence per evidence tier, read from the data rather than declared here.
 * Moving a tier's confidence is a data revision — the point of C1's rule.
 */
export const CONFIDENCE_BY_TIER: Readonly<Record<EvidenceTier, number>> = {
  dedicated: data.evidenceTiers.dedicated.confidence,
  "multi-primitive": data.evidenceTiers["multi-primitive"].confidence,
};

const byEcosystemAndName = new Map<string, CryptoPackageEntry>(
  CRYPTO_PACKAGES.map((entry) => [`${entry.ecosystem} ${normalisePackageName(entry.ecosystem, entry.name)}`, entry]),
);

/** Curated entry for a package, or `undefined` when the package is not a known crypto library. */
export function lookupCryptoPackage(ecosystem: Ecosystem, name: string): CryptoPackageEntry | undefined {
  return byEcosystemAndName.get(`${ecosystem} ${normalisePackageName(ecosystem, name)}`);
}

/** The status that actually applies to one claim: a per-algorithm status overrides the package's. */
export function statusOf(entry: CryptoPackageEntry, algorithm: CryptoPackageAlgorithm): CurationStatus {
  return algorithm.status ?? entry.status;
}

/** Every canonical algorithm name this table can emit — used to assert they all resolve in `algorithms.json`. */
export const CRYPTO_PACKAGE_ALGORITHMS: readonly string[] = [
  ...new Set(CRYPTO_PACKAGES.flatMap((entry) => entry.algorithms.map((a) => a.algorithm))),
];
