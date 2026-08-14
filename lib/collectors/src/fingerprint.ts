import { createHash } from "node:crypto";
import type { RawObservation } from "./types";

/**
 * Deterministic asset fingerprint inputs, one variant per surface that
 * currently has a collector or a fully-specified rule.
 *
 * docs/Claude/04-architecture.md §"Asset fingerprint":
 *   source:      repo + path + algorithm + normalised-symbol (NOT line number)
 *   dependency:  repo + ecosystem + package + algorithm  (see below)
 *   tls:         host + port + algorithm
 *   certificate: issuer + serial
 *   kms:         provider + key ARN/ID
 *
 * qx-sp1800-38b investigation report §"Binary fingerprint rule":
 *   managed binary: target-or-repository + packageIdentity-or-componentName
 *                   + artifactPath + binaryFormat + architecture + algorithm
 *                   + evidenceDiscriminator
 *
 * Anti-requirement (both sources): never include a line number or a content
 * digest/file hash in the fingerprint. A reformatted file or a routine
 * rebuilt binary must not orphan-and-recreate the asset — that renders as a
 * mass remediation followed by a mass regression in a trend chart.
 *
 * **`repo` was added to the `dependency` variant** when B2's ingest path was
 * built (the architecture table above lists `ecosystem + package + algorithm`
 * and is amended to match). Without it one asset row stands for a package
 * across every project in the organisation, and three mechanisms that key on
 * `assets.location` starting with `project:<id>:` break at once:
 * `DELETE /projects/:id` (which reconciles by that prefix and would delete a
 * package still present in another project, or leave it behind forever),
 * `GET /projects/:id/coverage` (which would find no dependency assets and
 * report the surface as examined-and-empty), and the CBOM export's
 * `containedIn` join. `location` is a single `notNull` column and cannot name
 * two projects, so the identity has to carry the project.
 *
 * It costs the estate-wide dedupe: `elliptic` in two projects is now two
 * rows, and "who uses elliptic" is a GROUP BY rather than a single asset.
 * That is the right trade — a query can aggregate rows, but no query can
 * split one row back into the two projects it stands for. Stability is
 * unaffected: `repo` is `project:<id>`, which does not change.
 */
export type FingerprintInput =
  | { surface: "source"; repo: string; path: string; algorithm: string; symbol: string }
  | { surface: "dependency"; repo: string; ecosystem: string; package: string; algorithm: string }
  | { surface: "tls"; host: string; port: number; algorithm: string }
  | { surface: "certificate"; issuer: string; serial: string }
  | { surface: "kms"; provider: string; keyId: string }
  | {
      surface: "binary";
      targetOrRepository: string;
      packageIdentityOrComponentName: string;
      artifactPath: string;
      binaryFormat: string;
      architecture: string;
      algorithm: string;
      evidenceDiscriminator: string;
    };

/**
 * Ordered, stable field list per surface. Order matters (it is part of the
 * hashed identity) but is fixed here rather than left to object-key
 * iteration order.
 */
function orderedFields(input: FingerprintInput): string[] {
  switch (input.surface) {
    case "source":
      return [input.surface, input.repo, input.path, input.algorithm, input.symbol];
    case "dependency":
      return [input.surface, input.repo, input.ecosystem, input.package, input.algorithm];
    case "tls":
      return [input.surface, input.host, String(input.port), input.algorithm];
    case "certificate":
      return [input.surface, input.issuer, input.serial];
    case "kms":
      return [input.surface, input.provider, input.keyId];
    case "binary":
      return [
        input.surface,
        input.targetOrRepository,
        input.packageIdentityOrComponentName,
        input.artifactPath,
        input.binaryFormat,
        input.architecture,
        input.algorithm,
        input.evidenceDiscriminator,
      ];
  }
}

/**
 * Compute the deterministic asset fingerprint. Fields are JSON-encoded as an
 * ordered array (not delimiter-joined) before hashing, so a field that
 * happens to contain the delimiter character cannot collide two distinct
 * inputs into the same fingerprint.
 */
export function computeFingerprint(input: FingerprintInput): string {
  const fields = orderedFields(input);
  const payload = JSON.stringify(fields);
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * The `RawObservation` → `FingerprintInput` bridge, and therefore the single
 * place that decides which surface an observation is persisted under.
 *
 * It exists because the ingest path used to hardcode `surface: "source"` in
 * its `computeFingerprint` call, which is why a second collector could be
 * built, tested and merged and still have nowhere to write: every observation
 * it produced would have been fingerprinted, and stored, as source code. The
 * surface is a property of the observation, so it is derived from the
 * observation — from `locationDetail`'s discriminator, which every collector
 * already sets and which the database validates on the way in.
 *
 * Returns `undefined` rather than guessing when the observation carries no
 * profile this can turn into an identity (`network`, `binary`, or no
 * `locationDetail` at all). A caller must decide what to do with that; the
 * one thing it must not do is fall back to a surface, which is the bug above.
 *
 * `repo` is the caller's stable target identity (`project:<id>` today), not
 * anything the collector chose — it is the same value the collector was
 * handed as `CollectionTarget.repo`, passed here explicitly so an ingest
 * cannot fingerprint a run against a target other than the one it scanned.
 */
export function fingerprintForObservation(
  observation: RawObservation,
  context: { repo: string },
): FingerprintInput | undefined {
  const detail = observation.locationDetail;
  switch (detail?.kind) {
    case "source":
      return {
        surface: "source",
        repo: context.repo,
        path: detail.source.path,
        algorithm: observation.algorithm,
        // The matched symbol, falling back to the algorithm name — a
        // collector that reports no symbol still needs a stable identity.
        symbol: detail.source.symbol ?? observation.algorithm,
      };
    case "dependency":
      return {
        surface: "dependency",
        repo: context.repo,
        ecosystem: detail.dependency.ecosystem,
        package: detail.dependency.package,
        // Deliberately not the version: `location`/`locationDetail` carry it,
        // and folding it into identity would orphan and recreate the asset on
        // every patch bump — the same anti-requirement as line numbers above.
        algorithm: observation.algorithm,
      };
    default:
      return undefined;
  }
}
