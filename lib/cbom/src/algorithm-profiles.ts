/**
 * Detector algorithm label → CycloneDX `algorithmProperties`.
 *
 * CycloneDX 1.7 moved `algorithmFamily` and `ellipticCurve` into closed
 * enumerations (`schema/cryptography-defs.schema.json`), so an unmapped or
 * approximated family is a **schema validation failure**, not a cosmetic
 * imprecision. That is the useful pressure A5 is supposed to apply to the
 * asset model, so the mapping is explicit and conservative:
 *
 * - A field is emitted only when the detector's label determines it.
 * - `RSA` gets **no** `algorithmFamily`: the enum has only the scheme-specific
 *   members (`RSAES-OAEP`, `RSASSA-PSS`, …) and a bare `RSA` match does not say
 *   which. Naming one would be a fabrication of exactly the kind
 *   docs/Claude/09-open-gaps.md forbids for key sizes.
 * - `ECDH/DH` is one detector pattern spanning two enum members (`ECDH`,
 *   `FFDH`), so the family is likewise omitted. The primitive is not in doubt.
 * - `primitive: "unknown"` is the schema's own way of saying "not determined"
 *   and is preferred over silence where the label genuinely leaves it open.
 *
 * Adding a collector means adding its labels here. An unmapped label still
 * exports — as an `algorithm` asset with no family — rather than being dropped;
 * losing an asset from an inventory is worse than under-describing it.
 */

export interface AlgorithmProfile {
  /** Member of `cryptography-defs.schema.json#/definitions/algorithmFamiliesEnum`, or undefined. */
  family?: string;
  /** Member of the `primitive` enum in `bom-1.7.schema.json`. */
  primitive?: string;
  /** Member of the `mode` enum — block-cipher mode of operation. */
  mode?: string;
}

export const ALGORITHM_PROFILES: Readonly<Record<string, AlgorithmProfile>> = {
  // Asymmetric — the Shor-vulnerable set the source collector detects today.
  RSA: { primitive: "unknown" },
  DSA: { family: "DSA", primitive: "signature" },
  ECDSA: { family: "ECDSA", primitive: "signature" },
  "ECDH/DH": { primitive: "key-agree" },

  // Hashes.
  MD5: { family: "MD5", primitive: "hash" },
  "SHA-1": { family: "SHA-1", primitive: "hash" },

  // Symmetric. The detector's label carries the mode; the family does not.
  "AES-ECB": { family: "AES", primitive: "block-cipher", mode: "ecb" },
};

export function algorithmProfileFor(algorithm: string): AlgorithmProfile {
  return ALGORITHM_PROFILES[algorithm] ?? {};
}
