import { createHash } from "node:crypto";

/**
 * Deterministic asset fingerprint inputs, one variant per surface that
 * currently has a collector or a fully-specified rule.
 *
 * docs/Claude/04-architecture.md §"Asset fingerprint":
 *   source:      repo + path + algorithm + normalised-symbol (NOT line number)
 *   dependency:  ecosystem + package + algorithm
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
 */
export type FingerprintInput =
  | { surface: "source"; repo: string; path: string; algorithm: string; symbol: string }
  | { surface: "dependency"; ecosystem: string; package: string; algorithm: string }
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
      return [input.surface, input.ecosystem, input.package, input.algorithm];
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
