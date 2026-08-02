import type { Collector, CollectorContext, CollectionTarget, RawObservation } from "./types";

/**
 * The regex-over-source detector, generalised behind the `Collector`
 * interface. docs/Claude/04-architecture.md §2: "The existing regex scanner
 * becomes `SourceRegexCollector` — one implementation, unchanged in
 * behaviour, with `nistReplacement`/`nistStandard`/`explanation`/`severity`
 * removed from its pattern table because those now come from `mappings/`."
 *
 * Detection behaviour (which line matches which algorithm, "one finding per
 * line", pattern order) is unchanged from the pre-refactor
 * `artifacts/api-server/src/lib/scanner.ts`. Only the pattern table's shape
 * changed: no more frozen standards copy, plus a best-effort key-size
 * extraction (G-05) confined to the matched line.
 */

interface SourcePattern {
  /** Must equal an `algorithms.json` `canonicalName` so `algorithm-mapping.ts` can resolve it at read time. */
  algorithm: string;
  pattern: RegExp;
}

const SOURCE_PATTERNS: SourcePattern[] = [
  {
    algorithm: "RSA",
    pattern:
      /\b(RSA|Crypto\.PublicKey\.RSA|KeyPairGenerator\s*\(\s*["']RSA["']\)|generateKeyPair\s*\(\s*['"]rsa['"]|new\s+RSA\b)/i,
  },
  {
    algorithm: "ECDSA",
    pattern: /\b(ECDSA|secp256k1|prime256v1|elliptic\.P256|EC\.sign|createSign\s*\(\s*['"]sha256WithRSAEncryption['"])/i,
  },
  {
    algorithm: "ECDH/DH",
    pattern: /\b(ECDH|createECDH|DH\b|DHParameterSpec|getDiffieHellman)/i,
  },
  {
    algorithm: "DSA",
    pattern: /\b(DSA\b|KeyPairGenerator\s*\(\s*["']DSA["'])/i,
  },
  {
    algorithm: "MD5",
    pattern: /\b(md5|hashlib\.md5|createHash\s*\(\s*['"]md5['"]|MD5\b)/i,
  },
  {
    algorithm: "SHA-1",
    pattern: /\b(sha1|hashlib\.sha1|SHA1\b|createHash\s*\(\s*['"]sha1['"]|getInstance\s*\(\s*["']SHA-1["'])/i,
  },
  {
    algorithm: "AES-ECB",
    pattern: /\b(AES[_-]ECB|AES\/ECB|getInstance\s*\(\s*["']AES\/ECB\/|Cipher\.ECB|mode\s*=\s*['"]ECB['"])/i,
  },
];

/**
 * Named-curve bit sizes for algorithms whose "key size" is a curve, not a
 * modulus. Key size here is the stated parameter size (P-384 → 384), not a
 * derived NIST security-strength category (see types.ts `RawObservation.keySize`).
 */
const NAMED_CURVE_BIT_SIZES: Record<string, number> = {
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

/** Modulus sizes an RSA/DSA key is actually generated at, in practice. Used to reject an incidental same-line number (a year, an RFC number, a port) that is not a key size. */
const PLAUSIBLE_MODULUS_BIT_SIZES = new Set([512, 1024, 2048, 3072, 4096, 7680, 8192, 15360]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Best-effort key size extraction, confined to the single line that matched
 * the algorithm pattern (this is a line-based regex detector, not a parser —
 * a modulus/curve named on a different line, e.g. via a variable or a
 * constant defined elsewhere in the file, is genuinely undeterminable here).
 * Returns `undefined` — never a guessed default — when no literal is found.
 */
export function extractKeySizeFromLine(line: string, algorithm: string): number | undefined {
  for (const [curveName, bits] of Object.entries(NAMED_CURVE_BIT_SIZES)) {
    if (new RegExp(`\\b${escapeRegExp(curveName)}\\b`, "i").test(line)) {
      return bits;
    }
  }
  if (algorithm === "RSA" || algorithm === "DSA") {
    const numbers = line.match(/\b\d{3,5}\b/g);
    if (numbers) {
      for (const n of numbers) {
        const value = parseInt(n, 10);
        if (PLAUSIBLE_MODULUS_BIT_SIZES.has(value)) return value;
      }
    }
  }
  return undefined;
}

const REGEX_CONFIDENCE = 0.7;

/**
 * The actual detection work, synchronous. Pattern-matching in-memory
 * strings has no genuine asynchrony, so this is what both
 * `SourceRegexCollector.collect()` (which must satisfy the async
 * `Collector` interface, since other surfaces — network, binary — need it)
 * and callers that want the result synchronously (e.g. the API server's
 * pre-refactor `scanCode()` back-compat shim) actually call.
 */
export function collectSourceObservations(target: CollectionTarget): RawObservation[] {
  const observations: RawObservation[] = [];
  for (const file of target.files) {
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;

      for (const { algorithm, pattern } of SOURCE_PATTERNS) {
        if (pattern.test(line)) {
          observations.push({
            algorithm,
            keySize: extractKeySizeFromLine(line, algorithm),
            location: `${target.repo}:${file.path}`,
            locationDetail: {
              kind: "source",
              source: { repo: target.repo, path: file.path, language: file.language, symbol: algorithm },
            },
            discoveryModality: "static_artifact_analysis",
            confidence: REGEX_CONFIDENCE,
            evidence: {
              lineNumber,
              codeSnippet: line.trim().substring(0, 200),
            },
          });
          break; // one finding per line, matching pre-refactor scanner.ts behaviour
        }
      }
    }
  }
  return observations;
}

export class SourceRegexCollector implements Collector {
  readonly name = "source-regex";
  readonly version = "1.0.0";
  readonly surface = "source" as const;
  readonly capabilities = { confidence: REGEX_CONFIDENCE, canDetermineKeySize: true };

  async *collect(target: CollectionTarget, _ctx: CollectorContext): AsyncIterable<RawObservation> {
    for (const observation of collectSourceObservations(target)) {
      yield observation;
    }
  }
}
