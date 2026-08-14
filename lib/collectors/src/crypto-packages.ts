import type { Ecosystem } from "./lockfiles";
import { normalisePackageName } from "./lockfiles";

/**
 * The curated package → algorithm table behind B2. Every entry answers one
 * question: *if this package is in the dependency graph, which
 * quantum-relevant primitives does it put there?*
 *
 * Two rules govern what may be added here.
 *
 * 1. **The algorithm must be a property of the package, not of how a caller
 *    configures it.** JWT/JOSE libraries (`jsonwebtoken`, `jose`, `pyjwt`)
 *    are deliberately absent: their algorithm is an `alg` value chosen at
 *    runtime, so a lockfile entry says nothing about which one is in use.
 *    Inferring "RSA" from `jsonwebtoken` would manufacture findings, and a
 *    wrong value is worse than no value (docs/Claude/09-open-gaps.md G-05).
 * 2. **`algorithm` must be a `canonicalName` in
 *    `docs/Claude/mappings/algorithms.json`**, so `algorithm-mapping.ts`
 *    resolves severity/replacement/standard for it at read time. Asserted in
 *    `algorithm-mapping.test.ts`.
 *
 * `tier` records how strong the inference is, and becomes the observation's
 * confidence — see `dependency-collector.ts`. It is a property of the
 * *package*, not of the parse: the parse itself is exact either way.
 *
 * **Provenance caveat — read before a customer sees a dependency finding.**
 * Unlike `docs/Claude/mappings/*.json`, this table carries no `citation` and
 * no `verified`/`needs-check` tag: every row was hand-curated from general
 * knowledge of what each library implements, not transcribed from its
 * documentation. That is the same class of unverified claim the mappings
 * README's discipline exists to catch, and it escapes that discipline only
 * because this is code rather than data. Auditing it row by row against each
 * project's own documentation is the obvious first follow-up; moving it into
 * `mappings/` with citations is the better one.
 *
 * What this table deliberately does not do: version-range reasoning. It
 * records the version the lockfile pins, but has no notion of "vulnerable
 * before x.y.z" — that is CVE/advisory data, a separate dataset with its own
 * provenance requirements, not something to hand-seed here.
 */

export type EvidenceTier =
  /** The package exists to implement this primitive. Presence ⇒ the primitive is available and almost certainly used. */
  | "dedicated"
  /** One of several primitives the package offers. Presence proves the library is shipped; which primitive the caller uses is unknown. */
  | "multi-primitive";

export interface CryptoPackageAlgorithm {
  /** `canonicalName` from `algorithms.json`. */
  algorithm: string;
  tier: EvidenceTier;
  /** The one named curve this package pins, when it pins exactly one — resolves to a key size via `named-curves.ts`. Omitted when the package is curve-agnostic. */
  curve?: string;
  /** Why the package implies the algorithm. Carried into `evidence` so a reader can judge the inference rather than trust it. */
  rationale: string;
}

export interface CryptoPackageEntry {
  ecosystem: Ecosystem;
  /** Normalised name (see `normalisePackageName`). */
  name: string;
  algorithms: CryptoPackageAlgorithm[];
}

export const CRYPTO_PACKAGES: CryptoPackageEntry[] = [
  // ── npm ────────────────────────────────────────────────────────────────
  {
    ecosystem: "npm",
    name: "node-rsa",
    algorithms: [{ algorithm: "RSA", tier: "dedicated", rationale: "node-rsa is an RSA implementation; it offers no other primitive." }],
  },
  {
    ecosystem: "npm",
    name: "keypair",
    algorithms: [{ algorithm: "RSA", tier: "dedicated", rationale: "keypair generates RSA key pairs and nothing else." }],
  },
  {
    ecosystem: "npm",
    name: "node-forge",
    algorithms: [
      { algorithm: "RSA", tier: "multi-primitive", rationale: "forge.pki implements RSA key generation, signing and encryption." },
      { algorithm: "EdDSA", tier: "multi-primitive", curve: "ed25519", rationale: "forge.pki.ed25519 implements Ed25519 signatures." },
    ],
  },
  {
    ecosystem: "npm",
    name: "jsrsasign",
    algorithms: [
      { algorithm: "RSA", tier: "multi-primitive", rationale: "jsrsasign implements RSA signature and encryption." },
      { algorithm: "ECDSA", tier: "multi-primitive", rationale: "jsrsasign implements ECDSA over the NIST prime curves." },
      { algorithm: "DSA", tier: "multi-primitive", rationale: "jsrsasign implements DSA signature." },
    ],
  },
  {
    ecosystem: "npm",
    name: "elliptic",
    algorithms: [
      { algorithm: "ECDSA", tier: "multi-primitive", rationale: "elliptic implements ECDSA over several curves." },
      { algorithm: "EdDSA", tier: "multi-primitive", curve: "ed25519", rationale: "elliptic implements EdDSA over ed25519." },
      { algorithm: "ECDH/DH", tier: "multi-primitive", rationale: "elliptic implements ECDH key agreement." },
    ],
  },
  {
    ecosystem: "npm",
    name: "secp256k1",
    algorithms: [
      { algorithm: "ECDSA", tier: "dedicated", curve: "secp256k1", rationale: "Bindings to libsecp256k1: ECDSA over secp256k1 only." },
    ],
  },
  {
    ecosystem: "npm",
    name: "@noble/secp256k1",
    algorithms: [
      { algorithm: "ECDSA", tier: "dedicated", curve: "secp256k1", rationale: "Single-curve ECDSA implementation (secp256k1)." },
    ],
  },
  {
    ecosystem: "npm",
    name: "@noble/ed25519",
    algorithms: [{ algorithm: "EdDSA", tier: "dedicated", curve: "ed25519", rationale: "Single-curve Ed25519 signature implementation." }],
  },
  {
    ecosystem: "npm",
    name: "@noble/curves",
    algorithms: [
      { algorithm: "ECDSA", tier: "multi-primitive", rationale: "@noble/curves ships ECDSA over the NIST and secp256k1 curves." },
      { algorithm: "EdDSA", tier: "multi-primitive", rationale: "@noble/curves ships Ed25519 and Ed448." },
      { algorithm: "ECDH/DH", tier: "multi-primitive", rationale: "@noble/curves ships ECDH/X25519 key agreement." },
    ],
  },
  {
    ecosystem: "npm",
    name: "tweetnacl",
    algorithms: [
      { algorithm: "EdDSA", tier: "multi-primitive", curve: "ed25519", rationale: "nacl.sign is Ed25519." },
      { algorithm: "ECDH/DH", tier: "multi-primitive", curve: "x25519", rationale: "nacl.box performs X25519 key agreement." },
    ],
  },
  {
    ecosystem: "npm",
    name: "ed25519",
    algorithms: [{ algorithm: "EdDSA", tier: "dedicated", curve: "ed25519", rationale: "Native Ed25519 signature bindings." }],
  },
  {
    ecosystem: "npm",
    name: "sshpk",
    algorithms: [
      { algorithm: "RSA", tier: "multi-primitive", rationale: "sshpk parses and generates SSH RSA keys." },
      { algorithm: "DSA", tier: "multi-primitive", rationale: "sshpk supports SSH DSA keys." },
      { algorithm: "ECDSA", tier: "multi-primitive", rationale: "sshpk supports ecdsa-sha2-nistp* SSH keys." },
      { algorithm: "EdDSA", tier: "multi-primitive", curve: "ed25519", rationale: "sshpk supports ssh-ed25519 keys." },
    ],
  },
  {
    ecosystem: "npm",
    name: "eccrypto",
    algorithms: [
      { algorithm: "ECDSA", tier: "multi-primitive", curve: "secp256k1", rationale: "eccrypto signs with ECDSA over secp256k1." },
      { algorithm: "ECDH/DH", tier: "multi-primitive", curve: "secp256k1", rationale: "eccrypto derives shared secrets with ECDH over secp256k1." },
    ],
  },
  {
    ecosystem: "npm",
    name: "md5",
    algorithms: [{ algorithm: "MD5", tier: "dedicated", rationale: "The package is an MD5 implementation." }],
  },
  {
    ecosystem: "npm",
    name: "js-md5",
    algorithms: [{ algorithm: "MD5", tier: "dedicated", rationale: "The package is an MD5 implementation." }],
  },
  {
    ecosystem: "npm",
    name: "js-sha1",
    algorithms: [{ algorithm: "SHA-1", tier: "dedicated", rationale: "The package is a SHA-1 implementation." }],
  },
  {
    ecosystem: "npm",
    name: "sha.js",
    algorithms: [{ algorithm: "SHA-1", tier: "multi-primitive", rationale: "sha.js implements the whole SHA family, SHA-1 included." }],
  },
  {
    ecosystem: "npm",
    name: "crypto-js",
    algorithms: [
      { algorithm: "MD5", tier: "multi-primitive", rationale: "CryptoJS.MD5 is part of the bundle." },
      { algorithm: "SHA-1", tier: "multi-primitive", rationale: "CryptoJS.SHA1 is part of the bundle." },
    ],
  },

  // ── PyPI ───────────────────────────────────────────────────────────────
  {
    ecosystem: "pypi",
    name: "cryptography",
    algorithms: [
      { algorithm: "RSA", tier: "multi-primitive", rationale: "pyca/cryptography implements RSA key generation, signing and encryption." },
      { algorithm: "ECDSA", tier: "multi-primitive", rationale: "pyca/cryptography implements ECDSA over the NIST curves." },
      { algorithm: "EdDSA", tier: "multi-primitive", rationale: "pyca/cryptography implements Ed25519 and Ed448." },
      { algorithm: "ECDH/DH", tier: "multi-primitive", rationale: "pyca/cryptography implements ECDH and finite-field DH." },
    ],
  },
  {
    ecosystem: "pypi",
    name: "pycryptodome",
    algorithms: [
      { algorithm: "RSA", tier: "multi-primitive", rationale: "Crypto.PublicKey.RSA is part of PyCryptodome." },
      { algorithm: "DSA", tier: "multi-primitive", rationale: "Crypto.PublicKey.DSA is part of PyCryptodome." },
      { algorithm: "ECDSA", tier: "multi-primitive", rationale: "Crypto.Signature.DSS over Crypto.PublicKey.ECC is ECDSA." },
    ],
  },
  {
    ecosystem: "pypi",
    name: "pycryptodomex",
    algorithms: [
      { algorithm: "RSA", tier: "multi-primitive", rationale: "Cryptodome.PublicKey.RSA is part of PyCryptodomex." },
      { algorithm: "DSA", tier: "multi-primitive", rationale: "Cryptodome.PublicKey.DSA is part of PyCryptodomex." },
      { algorithm: "ECDSA", tier: "multi-primitive", rationale: "Cryptodome.Signature.DSS over ECC keys is ECDSA." },
    ],
  },
  {
    ecosystem: "pypi",
    name: "pycrypto",
    algorithms: [
      { algorithm: "RSA", tier: "multi-primitive", rationale: "Crypto.PublicKey.RSA is part of PyCrypto (unmaintained)." },
      { algorithm: "DSA", tier: "multi-primitive", rationale: "Crypto.PublicKey.DSA is part of PyCrypto (unmaintained)." },
    ],
  },
  {
    ecosystem: "pypi",
    name: "paramiko",
    algorithms: [
      { algorithm: "RSA", tier: "multi-primitive", rationale: "paramiko supports ssh-rsa / rsa-sha2-* host and user keys." },
      { algorithm: "DSA", tier: "multi-primitive", rationale: "paramiko supports ssh-dss keys." },
      { algorithm: "ECDSA", tier: "multi-primitive", rationale: "paramiko supports ecdsa-sha2-nistp* keys." },
      { algorithm: "EdDSA", tier: "multi-primitive", curve: "ed25519", rationale: "paramiko supports ssh-ed25519 keys." },
    ],
  },
  {
    ecosystem: "pypi",
    name: "rsa",
    algorithms: [{ algorithm: "RSA", tier: "dedicated", rationale: "python-rsa is a pure-Python RSA implementation." }],
  },
  {
    ecosystem: "pypi",
    name: "ecdsa",
    algorithms: [{ algorithm: "ECDSA", tier: "dedicated", rationale: "python-ecdsa exists to implement ECDSA." }],
  },
  {
    ecosystem: "pypi",
    name: "ed25519",
    algorithms: [{ algorithm: "EdDSA", tier: "dedicated", curve: "ed25519", rationale: "The package is an Ed25519 signature implementation." }],
  },
  {
    ecosystem: "pypi",
    name: "pynacl",
    algorithms: [
      { algorithm: "EdDSA", tier: "multi-primitive", curve: "ed25519", rationale: "nacl.signing is Ed25519." },
      { algorithm: "ECDH/DH", tier: "multi-primitive", curve: "x25519", rationale: "nacl.public performs X25519 key agreement." },
    ],
  },
  {
    ecosystem: "pypi",
    name: "pyopenssl",
    algorithms: [
      { algorithm: "RSA", tier: "multi-primitive", rationale: "pyOpenSSL exposes OpenSSL RSA key and certificate operations." },
      { algorithm: "DSA", tier: "multi-primitive", rationale: "pyOpenSSL exposes OpenSSL DSA keys." },
      { algorithm: "ECDSA", tier: "multi-primitive", rationale: "pyOpenSSL exposes OpenSSL EC keys, used for ECDSA." },
    ],
  },
  {
    ecosystem: "pypi",
    name: "m2crypto",
    algorithms: [
      { algorithm: "RSA", tier: "multi-primitive", rationale: "M2Crypto wraps OpenSSL RSA." },
      { algorithm: "DSA", tier: "multi-primitive", rationale: "M2Crypto wraps OpenSSL DSA." },
      { algorithm: "ECDSA", tier: "multi-primitive", rationale: "M2Crypto wraps OpenSSL EC signing." },
      { algorithm: "ECDH/DH", tier: "multi-primitive", rationale: "M2Crypto wraps OpenSSL DH/ECDH." },
    ],
  },
];

const byEcosystemAndName = new Map<string, CryptoPackageEntry>(
  CRYPTO_PACKAGES.map((entry) => [`${entry.ecosystem} ${normalisePackageName(entry.ecosystem, entry.name)}`, entry]),
);

/** Curated entry for a package, or `undefined` when the package is not a known crypto library. */
export function lookupCryptoPackage(ecosystem: Ecosystem, name: string): CryptoPackageEntry | undefined {
  return byEcosystemAndName.get(`${ecosystem} ${normalisePackageName(ecosystem, name)}`);
}

/** Every canonical algorithm name this table can emit — used to assert they all resolve in `algorithms.json`. */
export const CRYPTO_PACKAGE_ALGORITHMS: readonly string[] = [
  ...new Set(CRYPTO_PACKAGES.flatMap((entry) => entry.algorithms.map((a) => a.algorithm))),
];
