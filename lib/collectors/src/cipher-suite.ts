/**
 * B11 — decomposition of a *reported* TLS cipher-suite name into the
 * cryptography it actually names.
 *
 * This is the false-positive-critical half of the `network-flow` surface. A
 * flow/session log hands us a string that somebody else's infrastructure wrote
 * down (`ssl_cipher`, `tls_cipher_suite`, an Envoy access-log field), and the
 * whole question is: what does that string *state*, as opposed to what a reader
 * might assume from it?
 *
 * ## The rule that governs every table below
 *
 * **Whole tokens, never substrings.** B6 shipped two bugs of exactly this shape
 * — a comment containing `sha1` reported as a key's algorithm, and a bare `dh`
 * inside an IPsec proposal resolving to a phantom `DH` asset. Every name
 * here is split into whole tokens on `_` and `-` and looked up in a `Record`;
 * nothing does `includes()` on the raw string. `ECDHE` and `DH` are different
 * map keys, and `SHA` never appears in any of them at all.
 *
 * ## The three naming conventions, and why the difference is load-bearing
 *
 * RFC 8446 §1.2, "Major Differences from TLS 1.2", states the change verbatim:
 *
 *   "The cipher suite concept has been changed to separate the authentication
 *    and key exchange mechanisms from the record protection algorithm
 *    (including secret key length) and a hash to be used with both the key
 *    derivation function and handshake message authentication code (MAC)."
 *
 * [Source: RFC 8446 §1.2, https://www.rfc-editor.org/rfc/rfc8446.txt —
 * retrieved 2026-08-15.]
 *
 * So:
 *
 *  1. **`tls13`** — `TLS_AES_128_GCM_SHA256`. Names the AEAD and the hash and
 *     **nothing else**. It does not name a key exchange and it does not name an
 *     authentication algorithm. TLS 1.3 does mandate an (EC)DHE exchange for
 *     every handshake, and B3's prober *does* record one for a TLS 1.3
 *     connection — because B3 completed the handshake and can say a key
 *     exchange happened. We did not. A log line containing this suite name is
 *     evidence of the AEAD only, and minting an `ECDH` asset from it would
 *     be reporting a value we inferred. This is the headline control of this
 *     module and `cipher-suite.test.ts` asserts it directly.
 *  2. **`iana-legacy`** — `TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256`. The tokens
 *     before `WITH` are the key exchange and the authentication; the tokens
 *     after are the record protection. Both halves are *stated*, so both are
 *     reportable.
 *  3. **`openssl-legacy`** — `ECDHE-RSA-AES128-GCM-SHA256`. The same suite in
 *     OpenSSL's spelling. Its shorthand omits a leading `RSA-RSA`
 *     (`AES256-SHA` is `TLS_RSA_WITH_AES_256_CBC_SHA`), and that omission is
 *     precisely why this module refuses to fill it in: the string does not say
 *     RSA, so no RSA is reported. A `key-exchange-not-named` gap is returned
 *     instead.
 *
 * ## What is deliberately never emitted
 *
 *  - **The MAC/PRF hash.** The trailing `SHA`, `SHA256`, `SHA384` in a suite
 *    name is a MAC or KDF hash, not a signature algorithm. `SHA-1` used inside
 *    HMAC is explicitly ACCEPTABLE per SP 800-131A Rev 2 (see
 *    `algorithms.json`'s `detectionNuance` on the SHA-1 entry), so reporting a
 *    `SHA-1` asset off `ECDHE-RSA-AES128-SHA` would be a false positive with a
 *    standards citation against it. `SHA` is not a key in any table here.
 *  - **An authentication algorithm for an anonymous or PSK suite.** `DH_anon`
 *    and `ECDHE_PSK` authenticate with no public-key signature at all.
 *  - **Anything not in `algorithms.json`.** ChaCha20, 3DES, RC4, Camellia,
 *    ARIA and SEED all appear in real suite names and none of them resolves,
 *    so they produce a gap rather than being bent onto AES. Widening the table
 *    means adding the algorithm to `algorithms.json` first, with a citation —
 *    which is the correct order (B7 states the same rule).
 */

/** Which naming convention a suite name follows. Part of the evidence, because it decides what the name is allowed to claim. */
export type CipherSuiteNameForm = "tls13" | "iana-legacy" | "openssl-legacy";

/**
 * Which part of a session's cryptography an observation describes.
 *
 * Part of the asset identity — see `fingerprint.ts`'s `network-flow` variant.
 * `TLS_RSA_WITH_AES_256_CBC_SHA` names RSA as *both* the key exchange and the
 * authentication, and without the role those two facts would fingerprint
 * identically and collapse into one asset. Same argument as B7's
 * `data-at-rest` role, reached from a different direction.
 */
export const CIPHER_SUITE_ROLE_VALUES = ["key-exchange", "authentication", "bulk-cipher"] as const;
export type CipherSuiteRole = (typeof CIPHER_SUITE_ROLE_VALUES)[number];

/** Why a suite name produced fewer components than a reader might expect. Reported, never inferred away. */
export type CipherSuiteGapReason =
  /** The name states no key exchange. TLS 1.3 names, PSK-only suites, and OpenSSL's `AES256-SHA` shorthand all land here. */
  | "key-exchange-not-named"
  /** The name states no public-key authentication: a TLS 1.3 name, or an `anon`/`PSK` suite that authenticates with no signature. */
  | "authentication-not-named"
  /** A record-protection algorithm is named but resolves to no entry in `algorithms.json` (ChaCha20, 3DES, …). Reported verbatim, never mapped to a neighbour. */
  | "bulk-cipher-not-recognised"
  /** The suite explicitly states the `NULL` cipher — the session carries no record encryption at all. There is no algorithm to record, so this is a gap, not an observation. */
  | "bulk-cipher-none"
  /** Nothing in the string could be parsed as a cipher suite name at all. */
  | "suite-name-not-recognised";

export interface CipherSuiteComponent {
  role: CipherSuiteRole;
  /** Canonical name, resolvable in `docs/Claude/mappings/algorithms.json`. */
  algorithm: string;
  /**
   * The size the *name* states, or `undefined`. Only ever populated for the
   * bulk cipher: `AES_128` states 128 bits. `ECDHE` says nothing about P-256
   * vs X25519 and `RSA` says nothing about a modulus length, so those two
   * roles carry no key size from a suite name — ever. G-05: undetermined stays
   * undetermined rather than acquiring a plausible default.
   */
  keySize?: number;
  /** The token this component was read from, verbatim (upper-cased). Evidence — a reader can go back to the name and check the parse. */
  token: string;
}

export interface ParsedCipherSuite {
  /** The name as submitted, unchanged. */
  reported: string;
  form: CipherSuiteNameForm;
  /** Upper-cased whole tokens, in order. Carried so the parse is auditable from a stored observation. */
  tokens: string[];
  components: CipherSuiteComponent[];
  gaps: CipherSuiteGapReason[];
}

/**
 * Key-exchange tokens.
 *
 * **`ECDHE` and `DHE` are different algorithms here, and used not to be.**
 * Until 2026-08-16 all five resolved to one `ECDH/DH` entry on the reasoning
 * that an X25519 handshake and a classic DHE handshake are "the same family
 * for reporting purposes". They are not, and the difference is a date: IR 8547
 * Table 4 lists Finite Field DH/MQV and Elliptic Curve DH/MQV separately
 * because the stated parameter means different things — a modulus against a
 * curve order. 2048 is ~112-bit security as a modulus, and 112-bit key
 * establishment is deprecated after 2030; read as a curve size it lands in the
 * `>= 128 bits` band and the customer is told 2035. See G-24.
 *
 * A suite name states no key size either way, so nothing here bands anything
 * on its own — but the canonical name it emits decides which table the size
 * gets read against everywhere downstream.
 *
 * `RSA` is here as well as in the authentication table because a legacy static
 * key-transport suite uses the certificate's own RSA key *as* the key exchange.
 */
const KEY_EXCHANGE_TOKENS: Record<string, string> = {
  ECDHE: "ECDH",
  ECDH: "ECDH",
  DHE: "DH",
  DH: "DH",
  EDH: "DH",
  RSA: "RSA",
};

/** Authentication (signature) tokens. `DSS` is the suite-name spelling of DSA — `algorithms.json` already lists it as an alias. */
const AUTHENTICATION_TOKENS: Record<string, string> = {
  RSA: "RSA",
  ECDSA: "ECDSA",
  DSS: "DSA",
  DSA: "DSA",
};

/**
 * Tokens that are recognised as *legitimately* naming no public-key algorithm.
 * Matching one produces a gap and no observation — which is different from an
 * unrecognised token, where the honest answer is that we did not understand the
 * name at all.
 *
 * `NULL` is deliberately absent. It names the *record-protection* half (`…
 * _WITH_NULL_SHA`, OpenSSL's `NULL-SHA`), never the key exchange, and listing
 * it here would let the OpenSSL prefix scan below swallow it — after which the
 * bulk resolver could no longer see it and would report the weaker
 * `bulk-cipher-not-recognised` instead of `bulk-cipher-none`, which is the more
 * serious and more specific fact.
 */
const NON_PUBLIC_KEY_TOKENS: ReadonlySet<string> = new Set(["ANON", "PSK", "KRB5", "SRP", "EXPORT"]);

/** Record-protection families this module can resolve. Every value must exist in `algorithms.json` — asserted in `algorithm-mapping.test.ts`. */
const BULK_CIPHER_TOKENS: Record<string, string> = {
  AES: "AES",
};

/** Every canonical name this module can emit. The guard in `algorithm-mapping.test.ts` iterates it. */
export const CIPHER_SUITE_ALGORITHMS: readonly string[] = [
  ...new Set([
    ...Object.values(KEY_EXCHANGE_TOKENS),
    ...Object.values(AUTHENTICATION_TOKENS),
    ...Object.values(BULK_CIPHER_TOKENS),
  ]),
];

/**
 * Split into whole upper-case tokens, separating a size glued to its family
 * (`AES128` → `AES`, `128`) so OpenSSL's spelling and IANA's reach the same
 * result. Nothing else is normalised: a token either matches a table key
 * exactly or it does not match at all.
 */
function tokenise(reported: string): string[] {
  return reported
    .toUpperCase()
    .replace(/[\s_.]+/g, "-")
    .split("-")
    .filter((part) => part.length > 0)
    .flatMap((part) => {
      const glued = /^([A-Z]+)(\d+)$/.exec(part);
      // Only split when the alphabetic half is a family this module knows.
      // `SHA256` and `POLY1305` must stay whole — splitting them would
      // manufacture a bare `256` that the bulk-size scan could pick up.
      if (glued && BULK_CIPHER_TOKENS[glued[1]] !== undefined) return [glued[1], glued[2]];
      return [part];
    });
}

/**
 * Resolve the record-protection half of a suite name.
 *
 * Scans for the first recognised cipher family and takes the size from the
 * immediately following bare-numeric token (or from the digits glued to the
 * family). The size is looked for *after* the family so a trailing `SHA384`
 * cannot be mistaken for a 384-bit AES key — the same ordering B7's
 * `canonicalDataAtRestAlgorithm` uses, for the same reason.
 */
function resolveBulkCipher(tokens: string[]): { component?: CipherSuiteComponent; gap?: CipherSuiteGapReason } {
  const index = tokens.findIndex((token) => BULK_CIPHER_TOKENS[token] !== undefined);
  if (index === -1) {
    // `NULL` as a whole token in the record-protection section means the suite
    // provides no encryption — a real and severe fact, but not an algorithm,
    // so it is reported as its own gap rather than as an observation.
    if (tokens.includes("NULL")) return { gap: "bulk-cipher-none" };
    return { gap: tokens.length === 0 ? "suite-name-not-recognised" : "bulk-cipher-not-recognised" };
  }

  const token = tokens[index];
  const next = tokens[index + 1];
  const keySize = next !== undefined && /^\d+$/.test(next) ? Number(next) : undefined;
  return {
    component: { role: "bulk-cipher", algorithm: BULK_CIPHER_TOKENS[token], keySize, token },
  };
}

/**
 * Resolve the key-exchange/authentication half of a legacy suite name from the
 * tokens that precede `WITH` (IANA) or the record-protection family (OpenSSL).
 *
 * Only one- and two-token sections are interpreted, because only those have an
 * unambiguous reading:
 *
 *  - one token — it is both halves (`TLS_RSA_WITH_…`), or it is a non-public-key
 *    mechanism (`TLS_PSK_WITH_…`) and neither half is named;
 *  - two tokens — `[key exchange, authentication]`.
 *
 * Anything longer (`TLS_SRP_SHA_RSA_WITH_…`) is left unparsed with both gaps
 * reported. That is a deliberate false *negative*: a guessed split of a name
 * this module has never been shown is exactly the kind of confident wrong
 * answer the surface exists to refuse.
 */
function resolveKeyExchangeAndAuthentication(section: string[]): {
  components: CipherSuiteComponent[];
  gaps: CipherSuiteGapReason[];
} {
  const components: CipherSuiteComponent[] = [];
  const gaps: CipherSuiteGapReason[] = [];

  const kexFrom = (token: string): void => {
    const algorithm = KEY_EXCHANGE_TOKENS[token];
    if (algorithm === undefined) gaps.push("key-exchange-not-named");
    else components.push({ role: "key-exchange", algorithm, token });
  };
  const authFrom = (token: string): void => {
    const algorithm = AUTHENTICATION_TOKENS[token];
    if (algorithm === undefined) gaps.push("authentication-not-named");
    else components.push({ role: "authentication", algorithm, token });
  };

  if (section.length === 1) {
    const token = section[0];
    if (NON_PUBLIC_KEY_TOKENS.has(token)) {
      gaps.push("key-exchange-not-named", "authentication-not-named");
      return { components, gaps };
    }
    kexFrom(token);
    authFrom(token);
    return { components, gaps };
  }

  if (section.length === 2) {
    kexFrom(section[0]);
    authFrom(section[1]);
    return { components, gaps };
  }

  gaps.push("key-exchange-not-named", "authentication-not-named");
  return { components, gaps };
}

/**
 * Parse a reported cipher-suite name.
 *
 * Returns `undefined` only for a string that is not a cipher-suite name at all
 * (empty, or nothing but punctuation). Everything else comes back as a
 * `ParsedCipherSuite` whose `components` may legitimately be empty and whose
 * `gaps` say why — the caller reports those gaps rather than filling them in.
 */
export function parseCipherSuite(reported: string): ParsedCipherSuite | undefined {
  const trimmed = reported.trim();
  if (trimmed.length === 0) return undefined;

  const tokens = tokenise(trimmed);
  // A cipher-suite name is made of alphanumeric tokens. A string with none at
  // all is not one, and saying so is different from — and more honest than —
  // returning a parse whose every component happened to resolve to nothing.
  // Tokens that *are* present but non-alphanumeric are kept in place rather
  // than dropped: they match no table key, so they resolve nothing, and
  // removing them could silently reshape the kex/auth section's length.
  if (!tokens.some((token) => /^[A-Z0-9]+$/.test(token))) return undefined;

  const withIndex = tokens.indexOf("WITH");

  // TLS 1.3: a `TLS_`-prefixed name with no `WITH`. RFC 8446 §1.2 (quoted in
  // this file's header) is the authority for the fact that such a name states
  // neither the key exchange nor the authentication.
  if (tokens[0] === "TLS" && withIndex === -1) {
    const bulk = resolveBulkCipher(tokens.slice(1));
    return {
      reported: trimmed,
      form: "tls13",
      tokens,
      components: bulk.component ? [bulk.component] : [],
      gaps: [
        "key-exchange-not-named",
        "authentication-not-named",
        ...(bulk.gap !== undefined ? [bulk.gap] : []),
      ],
    };
  }

  if (tokens[0] === "TLS" && withIndex !== -1) {
    const section = tokens.slice(1, withIndex);
    const kexAuth = resolveKeyExchangeAndAuthentication(section);
    const bulk = resolveBulkCipher(tokens.slice(withIndex + 1));
    return {
      reported: trimmed,
      form: "iana-legacy",
      tokens,
      components: [...kexAuth.components, ...(bulk.component ? [bulk.component] : [])],
      gaps: [...kexAuth.gaps, ...(bulk.gap !== undefined ? [bulk.gap] : [])],
    };
  }

  // OpenSSL spelling: consume leading tokens for as long as they are part of
  // the key-exchange/authentication vocabulary. `AES256-SHA` consumes none,
  // which is the case that must NOT become an RSA asset.
  let prefix = 0;
  while (
    prefix < tokens.length &&
    (KEY_EXCHANGE_TOKENS[tokens[prefix]] !== undefined ||
      AUTHENTICATION_TOKENS[tokens[prefix]] !== undefined ||
      NON_PUBLIC_KEY_TOKENS.has(tokens[prefix])) &&
    BULK_CIPHER_TOKENS[tokens[prefix]] === undefined
  ) {
    prefix += 1;
  }

  const section = tokens.slice(0, prefix);
  const kexAuth =
    section.length === 0
      ? { components: [], gaps: ["key-exchange-not-named", "authentication-not-named"] as CipherSuiteGapReason[] }
      : resolveKeyExchangeAndAuthentication(section);
  const bulk = resolveBulkCipher(tokens.slice(prefix));

  return {
    reported: trimmed,
    form: "openssl-legacy",
    tokens,
    components: [...kexAuth.components, ...(bulk.component ? [bulk.component] : [])],
    gaps: [...kexAuth.gaps, ...(bulk.gap !== undefined ? [bulk.gap] : [])],
  };
}
