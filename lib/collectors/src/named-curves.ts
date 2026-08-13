/**
 * Named-curve bit sizes for algorithms whose "key size" is a curve, not a
 * modulus. Key size here is the stated parameter size (P-384 → 384), not a
 * derived NIST security-strength category (see types.ts `RawObservation.keySize`).
 *
 * Lifted out of `source-regex-collector.ts` unchanged — including its key
 * order, which `extractKeySizeFromLine` depends on (it is a first-match loop
 * over `Object.entries`) — so the dependency collector can resolve the same
 * curve names without a second copy of the table. One curve name means one
 * bit size across every collector; a divergence here would show up as two
 * different key sizes for the same asset depending on which surface saw it.
 */
export const NAMED_CURVE_BIT_SIZES: Record<string, number> = {
  secp256r1: 256,
  prime256v1: 256,
  "p-256": 256,
  p256: 256,
  nistp256: 256,
  secp256k1: 256,
  secp384r1: 384,
  "p-384": 384,
  p384: 384,
  nistp384: 384,
  secp521r1: 521,
  "p-521": 521,
  p521: 521,
  nistp521: 521,
  x25519: 256,
  curve25519: 256,
  ed25519: 256,
  x448: 448,
  ed448: 448,
};

/**
 * Bit size of a named curve, or `undefined` for a name this table does not
 * know — never a guessed default (docs/Claude/09-open-gaps.md G-05).
 */
export function curveBitSize(curveName: string): number | undefined {
  return NAMED_CURVE_BIT_SIZES[curveName.toLowerCase()];
}
