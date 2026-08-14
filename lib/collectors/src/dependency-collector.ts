import { lookupCryptoPackage, type EvidenceTier } from "./crypto-packages";
import { detectLockfileKind, ecosystemForLockfile, parseLockfile, purlFor, type LockfileKind } from "./lockfiles";
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
 * Not wired into ingestion by this change: `asset-ingest.ts` computes a
 * `surface: "source"` fingerprint from `repo`/`path`, so persisting
 * dependency assets needs a `surface: "dependency"` ingest path
 * (`ecosystem + package + algorithm`, per `fingerprint.ts`). That is a
 * separate change with database and route surface; this one is the collector.
 */

/**
 * Confidence (docs/Claude/09-open-gaps.md G-11). Two values, because a
 * lockfile match is really two claims of very different strength:
 *
 *  - *The package is in the dependency graph.* Near-certain. A lockfile is
 *    machine-generated and exactly parsed — there is no equivalent of the
 *    regex collector's false positives on prose, comments or `DHCP`. That is
 *    why the higher tier sits **above** the regex collector's 0.7.
 *  - *Therefore this algorithm is used.* Depends entirely on the package.
 *    For a single-purpose library (`node-rsa`, `@noble/ed25519`) it follows
 *    almost automatically: nobody installs it for anything else. For a
 *    general-purpose library (`cryptography`, `elliptic`, `node-forge`) it
 *    genuinely does not follow — the primitive is *available*, and which of
 *    several the caller actually invokes is not visible in a lockfile.
 *
 * Hence 0.8 / 0.5. Neither approaches 1.0, which is reserved for evidence
 * that observes the algorithm in operation (a completed TLS handshake), and
 * neither is 0: static presence of a crypto library is real inventory
 * evidence, and a CISO's blind spot today is precisely the dependency tree.
 */
const CONFIDENCE_BY_TIER: Record<EvidenceTier, number> = {
  dedicated: 0.8,
  "multi-primitive": 0.5,
};

/** Nominal confidence for the collector as a whole — its best tier, before the per-observation adjustment above. */
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
           * Version-free by design. `location` feeds the asset fingerprint,
           * whose dependency variant is `ecosystem + package + algorithm`
           * (`fingerprint.ts`) — putting the version in here would orphan
           * and recreate the asset on every patch bump, which renders as a
           * mass remediation followed by a mass regression in a trend chart.
           * The version lives in `locationDetail` and `evidence`, which are
           * explicitly allowed to change between observations of one asset.
           */
          location: purlFor(ecosystem, pkg.name),
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
