import { CONFIDENCE_BY_TIER, lookupCryptoPackage, statusOf } from "./crypto-packages";
import { detectLockfileKind, ecosystemForLockfile, parseLockfile, purlFor, type Ecosystem, type LockfileKind } from "./lockfiles";
import { curveBitSize } from "./named-curves";
import type { Collector, CollectorContext, CollectionTarget, RawObservation } from "./types";

/**
 * B2 — the dependency / SBOM collector (docs/Claude/03-features.md, row B2:
 * "Parse lockfiles → map to known crypto libs + versions"). The regex
 * collector can only see crypto a repository writes itself; most enterprise
 * crypto is in its dependencies, which is why the roadmap calls this the
 * largest single coverage jump available.
 *
 * It is a second implementation of the A2 `Collector` contract, not a
 * parallel abstraction: same `collect()` signature, same `CollectionTarget`,
 * same `RawObservation`. It reads the *same* `kind: "source"` target the
 * regex collector reads — a lockfile is just a submitted file — and selects
 * the files it understands by basename (`detectLockfileKind`). That is also
 * why nothing in `scanner.ts` or the API routes changes to add it, which is
 * exactly the A2 acceptance criterion recorded as "not yet demonstrated" in
 * docs/Claude/04-architecture.md §"Acceptance for this seam".
 *
 * Wired into ingestion by `artifacts/api-server/src/lib/asset-ingest.ts`'s
 * `ingestDependencyObservations()`, reached from
 * `POST /api/projects/:id/dependencies`.
 */

/**
 * Confidence (docs/Claude/09-open-gaps.md G-11) is 0.8 / 0.5 by evidence
 * tier, and both numbers — with the reasoning behind them — now live in
 * `docs/Claude/mappings/crypto-packages.json`'s `evidenceTiers` block rather
 * than in this file, so moving one is a data revision (C1's rule).
 *
 * The 0.5 tier was re-examined when B2 was wired, because `elliptic` and
 * `sha.js` are transitive dependencies of much of the JS toolchain and this
 * collector therefore fires on nearly every project. It is the right number
 * and it stays: 0.5 is a statement about the *inference*, not about how
 * common the package is. `elliptic` genuinely offers ECDSA, EdDSA and ECDH,
 * and a lockfile genuinely cannot say which the caller invokes — that is
 * exactly what "one of several primitives the package offers" means. What
 * ubiquity actually changes is a different question (is this a finding about
 * the customer's own code?), and lowering a confidence number would be a
 * poor way to answer it: it would understate the evidence that the library
 * *is* shipped, which is a fact, in order to hint at something the number
 * does not mean. That question is answered instead by the `toolchainUbiquity`
 * flag and the caveat carried on every observation and every response — see
 * G-20.
 */
/** Nominal confidence for the collector as a whole — its best tier, before the per-observation adjustment. */
const NOMINAL_CONFIDENCE = CONFIDENCE_BY_TIER.dedicated;

/**
 * Synchronous detection, mirroring `collectSourceObservations`: parsing
 * in-memory text has no genuine asynchrony, and a synchronous entry point is
 * what a future ingest path (and any back-compat shim) will want.
 */
export function collectDependencyObservations(target: CollectionTarget): RawObservation[] {
  const observations: RawObservation[] = [];
  // One (ecosystem, package, version, algorithm) fact is one observation even
  // when a repository contains several lockfiles that agree — e.g. a
  // pnpm-lock.yaml at the root and another in a nested app directory. Two
  // lockfiles pinning *different* versions are two distinct facts and both
  // are kept.
  const seen = new Set<string>();

  for (const file of target.files) {
    const lockfileKind = detectLockfileKind(file.path);
    if (!lockfileKind) continue;
    const ecosystem = ecosystemForLockfile(lockfileKind);

    for (const pkg of parseLockfile(lockfileKind, file.content)) {
      const entry = lookupCryptoPackage(ecosystem, pkg.name);
      if (!entry) continue;

      for (const mapped of entry.algorithms) {
        const dedupeKey = `${ecosystem} ${entry.name} ${pkg.version ?? ""} ${mapped.algorithm}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        observations.push({
          algorithm: mapped.algorithm,
          /**
           * Determined only when the package pins exactly one curve
           * (`@noble/ed25519` → ed25519 → 256). An RSA library states no
           * modulus size — the calling code chooses it — so this stays
           * undefined rather than defaulting to a plausible 2048 (G-05).
           */
          keySize: mapped.curve ? curveBitSize(mapped.curve) : undefined,
          /**
           * `<repo>:<purl>`, the same `<repo>:<locator>` shape the source
           * collector emits (`${target.repo}:${file.path}`). The prefix is
           * not decoration: `DELETE /projects/:id`, the D3 coverage meter and
           * the CBOM export's `containedIn` all attribute an asset to a
           * project by testing `location` for a `project:<id>:` prefix, and a
           * bare purl is attributable to nothing.
           *
           * Version-free by design. `location` feeds the asset fingerprint,
           * whose dependency variant is `repo + ecosystem + package +
           * algorithm` (`fingerprint.ts`) — putting the version in here would
           * orphan and recreate the asset on every patch bump, which renders
           * as a mass remediation followed by a mass regression in a trend
           * chart. The version lives in `locationDetail` and `evidence`,
           * which are explicitly allowed to change between observations of
           * one asset.
           */
          location: `${target.repo}:${purlFor(ecosystem, pkg.name)}`,
          locationDetail: {
            kind: "dependency",
            dependency: {
              ecosystem,
              package: pkg.name,
              version: pkg.version,
              purl: purlFor(ecosystem, pkg.name, pkg.version),
            },
          },
          discoveryModality: "static_artifact_analysis",
          confidence: CONFIDENCE_BY_TIER[mapped.tier],
          evidence: {
            lockfilePath: file.path,
            lockfileKind,
            repo: target.repo || null,
            package: pkg.name,
            /** Explicitly null when the manifest states no exact version (a `requirements.txt` range), never a guessed one. */
            version: pkg.version ?? null,
            evidenceTier: mapped.tier,
            rationale: mapped.rationale,
            /**
             * Provenance, carried with the observation so a reader can judge
             * the claim rather than trust it. `curationStatus` is `verified`
             * only when a verbatim quote from the package's own documentation
             * supports it; `needs-check` says out loud that it does not.
             */
            curationStatus: statusOf(entry, mapped),
            needsCheckReason: mapped.needsCheckReason ?? entry.needsCheckReason ?? null,
            citation: entry.citation ?? null,
            /**
             * True for packages that are near-universal transitive
             * dependencies of the JS toolchain. Presence in the graph is
             * still a fact; what this flags is that it is probably not a
             * fact about the customer's own code (G-20).
             */
            toolchainUbiquity: entry.toolchainUbiquity === true,
          },
        });
      }
    }
  }

  return observations;
}

/** Whether a target contains anything this collector can read at all — useful for coverage reporting (D3). */
export function lockfilesIn(target: CollectionTarget): Array<{ path: string; kind: LockfileKind }> {
  return target.files
    .map((file) => ({ path: file.path, kind: detectLockfileKind(file.path) }))
    .filter((entry): entry is { path: string; kind: LockfileKind } => entry.kind !== undefined);
}

/**
 * The ecosystems this target actually carries a readable lockfile for.
 *
 * The ingest path needs this to bound its "what did this run look at, and
 * therefore what may it declare gone?" reconciliation. A submission of only
 * `requirements.txt` has observed nothing whatsoever about the project's npm
 * tree, so it must not be allowed to conclude that an npm package is no
 * longer there — the same reason `ingestSourceObservations` reconciles per
 * scanned file rather than per repo.
 */
export function ecosystemsIn(target: CollectionTarget): Ecosystem[] {
  return [...new Set(lockfilesIn(target).map((entry) => ecosystemForLockfile(entry.kind)))];
}

/**
 * The `location` prefix every asset from one ecosystem in one target shares.
 * One owner of the format, so the collector that writes a location and the
 * ingest that later reconciles against it cannot spell it two ways.
 */
export function dependencyLocationPrefix(repo: string, ecosystem: Ecosystem): string {
  return `${repo}:pkg:${ecosystem}/`;
}

export class DependencyCollector implements Collector {
  readonly name = "dependency-lockfile";
  readonly version = "1.0.0";
  readonly surface = "dependency" as const;
  /** `canDetermineKeySize` is "can, sometimes": only for packages that pin one curve. Most dependency observations carry no key size at all. */
  readonly capabilities = { confidence: NOMINAL_CONFIDENCE, canDetermineKeySize: true };

  async *collect(target: CollectionTarget, _ctx: CollectorContext): AsyncIterable<RawObservation> {
    for (const observation of collectDependencyObservations(target)) {
      yield observation;
    }
  }
}
