import { curveBitSize } from "./named-curves";

/**
 * Protocol-configuration parsing for B6 (docs/Claude/03-features.md, row B6:
 * "SSH, IPsec, JWT `alg`, SAML/OIDC signing").
 *
 * These parsers answer exactly one question — *which crypto algorithms does
 * this configuration file **declare**?* — and deliberately nothing else. They
 * are hand-written line/JSON/attribute readers rather than YAML/XML
 * dependencies for the same reason `lockfiles.ts` is: `@workspace/collectors`
 * is kept dependency-free apart from `zod` so it can ship as a standalone
 * on-prem agent (CLAUDE.md §"Package boundaries"). The cost is the same
 * trade: anything not recognised is skipped rather than guessed at, so an
 * unparsed section produces *fewer* declarations, never wrong ones.
 *
 * ## What this is not
 *
 * **A declaration is not a negotiation.** B3 (`tls-collector.ts`) opens a real
 * handshake and records what was actually agreed on the wire, at confidence
 * 1.0. This file reads what a config file *states*. The two must never be
 * conflated: a `Ciphers` list is an upper bound on what a daemon will accept,
 * not evidence any peer ever selected an entry from it, and letting a config
 * file's claim masquerade as an observed handshake would inflate the strongest
 * evidence tier this product has with its weakest. The confidence anchors in
 * `protocol-config-collector.ts` are where that distinction is priced.
 *
 * **The absence of a directive is not a declaration.** A `sshd_config` with no
 * `Ciphers` line still negotiates the compiled-in default set, and that set
 * differs by OpenSSH version and distribution patch. Inferring it would be
 * this collector claiming to know something it cannot read; what actually runs
 * is B3's surface.
 *
 * **`Include` / `@include` are not followed.** The caller submits file
 * contents, not a filesystem, so a directive in an included file is simply not
 * seen. Stated on the route's `evidenceCaveat` too, not only here.
 *
 * ## The token table is code, not curated standards data
 *
 * `docs/Claude/mappings/` holds claims about the outside world that can change
 * underneath us — which primitives a third-party package ships (G-21), what a
 * standard says on a given date — and `check:standards` ages them out after
 * 180 days. `ecdsa-sha2-nistp384` is not that kind of claim: it is a name
 * fixed by RFC 5656 that decodes to a curve and a signature scheme, the same
 * category as `named-curves.ts`'s bit-size table, which lives in TypeScript
 * for exactly this reason. Putting it under a `retrievedAt` would imply the
 * decoding could expire.
 *
 * ## Unrecognised tokens contribute nothing — and that is load-bearing
 *
 * Matching is on the **whole normalised token**, never a substring. Modern
 * OpenSSH offers `sntrup761x25519-sha512` and `mlkem768x25519-sha256` by
 * default: a substring match on `x25519` would report a hybrid post-quantum
 * key exchange as quantum-vulnerable `ECDH/DH`, a false positive on the exact
 * axis this product exists to measure. Anchored whole-token matching makes an
 * unknown token — post-quantum, vendor-specific, or simply new — produce no
 * declaration at all, which is the same discipline `certificate-collector.ts`
 * applies to an unrecognised key type. It does mean this collector is silent
 * about PQC adoption rather than positively reporting it; that is a gap, not a
 * wrong answer, and it is recorded in the route's evidence caveat.
 */

export const PROTOCOL_CONFIG_FORMATS = [
  "sshd-config",
  "ssh-config",
  "authorized-keys",
  "ipsec-config",
  "jwks",
  "oidc-discovery",
  "saml-metadata",
] as const;
export type ProtocolConfigFormat = (typeof PROTOCOL_CONFIG_FORMATS)[number];

/**
 * How strongly a declaration evidences that the algorithm is actually in use.
 * Priced into `confidence` by `protocol-config-collector.ts` — see its
 * anchors, which place both tiers well below B3's observed handshake.
 */
export type DeclarationStrength =
  /** A specific key or a specific chosen algorithm: an `authorized_keys` entry, a published JWK, the method a SAML document was signed with. */
  | "materialised"
  /** A menu: an algorithm the endpoint will *accept* if a peer asks for it. A peer may never select it. */
  | "permitted";

export interface DeclaredAlgorithm {
  /**
   * The directive or field the token was written under — `KexAlgorithms`,
   * `alg`, `SignatureMethod`, `esp`. Part of the asset identity: the same
   * token under two directives is two genuinely different declarations
   * (`ssh-rsa` as a host key vs as an accepted client key).
   */
  directive: string;
  /** The token verbatim, as the file wrote it (case and vendor suffix preserved). */
  token: string;
  /** Canonical name, resolving in `docs/Claude/mappings/algorithms.json`. */
  algorithm: string;
  /** The stated parameter size where the token names one (a curve, a MODP group, an AES width). Never a guessed default — G-05. */
  keySize?: number;
  strength: DeclarationStrength;
  /** The enclosing `Match` / `Host` block condition, when the directive sits inside one — it applies conditionally, not globally. */
  condition?: string;
}

interface TokenMapping {
  algorithm: string;
  keySize?: number;
}

/**
 * Whole-token → canonical algorithm. Keys are lowercase and already
 * normalised by {@link normaliseToken}. One table across all formats: the
 * namespaces barely overlap, and where they do (`sha1`, `aes256-cbc`,
 * `ecdh-es`) they mean the same thing, so a second table would only create
 * somewhere for them to disagree.
 *
 * Tokens deliberately absent, because `algorithms.json` has no canonical name
 * for them and inventing one here would be a second definition of the
 * algorithm vocabulary: every HMAC-SHA-2 MAC (`hmac-sha2-256`), the JOSE
 * `HS*` family, `chacha20-poly1305`, `3des`, `umac-*`, and JOSE's `none`
 * (which is not an algorithm at all). They produce no declaration.
 */
const TOKEN_MAPPINGS: Record<string, TokenMapping> = {
  // ── SSH host-key / public-key algorithms (RFC 4253, RFC 8332, RFC 8709) ──
  "ssh-rsa": { algorithm: "RSA" },
  "rsa-sha2-256": { algorithm: "RSA" },
  "rsa-sha2-512": { algorithm: "RSA" },
  "ssh-dss": { algorithm: "DSA" },
  "ssh-ed25519": { algorithm: "EdDSA", keySize: 256 },
  "ssh-ed448": { algorithm: "EdDSA", keySize: 448 },

  // ── SSH key exchange (RFC 4419, RFC 5656, RFC 8731) ──
  "curve25519-sha256": { algorithm: "ECDH/DH", keySize: 256 },
  // Group-exchange negotiates the modulus size at runtime, so the file states
  // no size — undetermined, not defaulted (G-05).
  "diffie-hellman-group-exchange-sha1": { algorithm: "ECDH/DH" },
  "diffie-hellman-group-exchange-sha256": { algorithm: "ECDH/DH" },

  // ── SSH MACs that name a hash `algorithms.json` does know ──
  "hmac-sha1": { algorithm: "SHA-1" },
  "hmac-sha1-96": { algorithm: "SHA-1" },
  "hmac-md5": { algorithm: "MD5" },
  "hmac-md5-96": { algorithm: "MD5" },

  // ── IPsec/IKE transform names (strongSwan proposal syntax) ──
  modp1024: { algorithm: "ECDH/DH", keySize: 1024 },
  modp1536: { algorithm: "ECDH/DH", keySize: 1536 },
  modp2048: { algorithm: "ECDH/DH", keySize: 2048 },
  modp3072: { algorithm: "ECDH/DH", keySize: 3072 },
  modp4096: { algorithm: "ECDH/DH", keySize: 4096 },
  modp6144: { algorithm: "ECDH/DH", keySize: 6144 },
  modp8192: { algorithm: "ECDH/DH", keySize: 8192 },
  ecp192: { algorithm: "ECDH/DH", keySize: 192 },
  ecp224: { algorithm: "ECDH/DH", keySize: 224 },
  ecp256: { algorithm: "ECDH/DH", keySize: 256 },
  ecp384: { algorithm: "ECDH/DH", keySize: 384 },
  ecp521: { algorithm: "ECDH/DH", keySize: 521 },
  curve25519: { algorithm: "ECDH/DH", keySize: 256 },
  curve448: { algorithm: "ECDH/DH", keySize: 448 },
  x25519: { algorithm: "ECDH/DH", keySize: 256 },
  x448: { algorithm: "ECDH/DH", keySize: 448 },
  sha1: { algorithm: "SHA-1" },
  md5: { algorithm: "MD5" },

  // ── JOSE / JWT `alg` values (RFC 7518) ──
  rs256: { algorithm: "RSA" },
  rs384: { algorithm: "RSA" },
  rs512: { algorithm: "RSA" },
  ps256: { algorithm: "RSA" },
  ps384: { algorithm: "RSA" },
  ps512: { algorithm: "RSA" },
  rsa1_5: { algorithm: "RSA" },
  "rsa-oaep": { algorithm: "RSA" },
  "rsa-oaep-256": { algorithm: "RSA" },
  "rsa-oaep-384": { algorithm: "RSA" },
  "rsa-oaep-512": { algorithm: "RSA" },
  // ES512 is P-521, not a 512-bit curve — the one place where the token's
  // digits and the curve's bit size genuinely differ.
  es256: { algorithm: "ECDSA", keySize: 256 },
  es384: { algorithm: "ECDSA", keySize: 384 },
  es512: { algorithm: "ECDSA", keySize: 521 },
  es256k: { algorithm: "ECDSA", keySize: 256 },
  eddsa: { algorithm: "EdDSA" },
  ed25519: { algorithm: "EdDSA", keySize: 256 },
  ed448: { algorithm: "EdDSA", keySize: 448 },
  "ecdh-es": { algorithm: "ECDH/DH" },
  "ecdh-es+a128kw": { algorithm: "ECDH/DH" },
  "ecdh-es+a192kw": { algorithm: "ECDH/DH" },
  "ecdh-es+a256kw": { algorithm: "ECDH/DH" },

  // ── XML Signature / XML Encryption URI fragments ──
  "rsa-sha1": { algorithm: "RSA" },
  "rsa-sha224": { algorithm: "RSA" },
  "rsa-sha256": { algorithm: "RSA" },
  "rsa-sha384": { algorithm: "RSA" },
  "rsa-sha512": { algorithm: "RSA" },
  "rsa-ripemd160": { algorithm: "RSA" },
  "rsa-1_5": { algorithm: "RSA" },
  "rsa-oaep-mgf1p": { algorithm: "RSA" },
  "dsa-sha1": { algorithm: "DSA" },
  "dsa-sha256": { algorithm: "DSA" },
  "ecdsa-sha1": { algorithm: "ECDSA" },
  "ecdsa-sha224": { algorithm: "ECDSA" },
  "ecdsa-sha256": { algorithm: "ECDSA" },
  "ecdsa-sha384": { algorithm: "ECDSA" },
  "ecdsa-sha512": { algorithm: "ECDSA" },
};

/**
 * Tokens that mean an algorithm **only** as an XML Signature / XML Encryption
 * URI fragment, and must not be resolved in any other format.
 *
 * One shared table works for `sha1`, `md5` and `aes256-cbc` because they name
 * the same thing wherever they appear. `dh` does not. As an xmlenc fragment
 * (`http://www.w3.org/2009/xmlenc11#dh`) it is a Diffie-Hellman key agreement;
 * as a hyphen-separated segment of a strongSwan proposal it is not a transform
 * at all, and resolving it there produced a phantom `ECDH/DH` asset with no
 * key size, indistinguishable from a real `modp2048` declaration on the same
 * line. Splitting an IPsec proposal on `-` is what makes a one-or-two-character
 * token dangerous, so the fix belongs here rather than in the splitter.
 */
const XMLDSIG_ONLY_TOKENS: Record<string, TokenMapping> = {
  dh: { algorithm: "ECDH/DH" },
  "dh-es": { algorithm: "ECDH/DH" },
};

/**
 * Bit size of an SSH `diffie-hellman-groupN` MODP group. SSH's `group1` is
 * Oakley Group 2 (1024 bits), not Group 1 (768) — the one off-by-one worth
 * spelling out. A group number absent here yields no size rather than a
 * guessed one.
 */
const SSH_DH_GROUP_BITS: Record<string, number> = {
  "1": 1024,
  "14": 2048,
  "15": 3072,
  "16": 4096,
  "17": 6144,
  "18": 8192,
};

/**
 * Parametric token families. Every pattern is anchored at both ends — see the
 * module header on why a substring match here would misreport hybrid PQC key
 * exchange as quantum-vulnerable.
 */
const TOKEN_PATTERNS: Array<{ pattern: RegExp; resolve: (match: RegExpMatchArray) => TokenMapping | undefined }> = [
  // ecdsa-sha2-nistp384, ecdh-sha2-nistp521 (RFC 5656)
  { pattern: /^ecdsa-sha2-nistp(\d+)$/, resolve: (m) => ({ algorithm: "ECDSA", keySize: curveBitSize(`nistp${m[1]}`) }) },
  { pattern: /^ecdh-sha2-nistp(\d+)$/, resolve: (m) => ({ algorithm: "ECDH/DH", keySize: curveBitSize(`nistp${m[1]}`) }) },
  // diffie-hellman-group14-sha256
  {
    pattern: /^diffie-hellman-group(\d+)-sha\d+$/,
    resolve: (m) => ({ algorithm: "ECDH/DH", keySize: SSH_DH_GROUP_BITS[m[1]] }),
  },
  // SSH ciphers (aes256-ctr, aes128-gcm) and XML Encryption (aes256-cbc, aes128-gcm)
  { pattern: /^aes(128|192|256)-(ctr|cbc|gcm)$/, resolve: (m) => ({ algorithm: "AES", keySize: Number(m[1]) }) },
  // strongSwan (aes256gcm16, aes128gcm128)
  { pattern: /^aes(128|192|256)(gcm\d*|ccm\d*|ctr)?$/, resolve: (m) => ({ algorithm: "AES", keySize: Number(m[1]) }) },
  // XML Encryption key wrap (kw-aes256, kw-aes128-pad)
  { pattern: /^kw-aes(128|192|256)(-pad)?$/, resolve: (m) => ({ algorithm: "AES", keySize: Number(m[1]) }) },
  // JOSE content/key-wrap AES (A256KW, A128GCM, A256GCMKW, A128CBC-HS256)
  { pattern: /^a(128|192|256)(kw|gcm|gcmkw)$/, resolve: (m) => ({ algorithm: "AES", keySize: Number(m[1]) }) },
  { pattern: /^a(128|192|256)cbc-hs\d+$/, resolve: (m) => ({ algorithm: "AES", keySize: Number(m[1]) }) },
];

/**
 * Reduce a token to its comparable form.
 *
 * Vendor suffixes (`@openssh.com`, `@libssh.org`), OpenSSH certificate
 * variants (`-cert-v01`) and the FIDO/security-key prefix (`sk-`) all name the
 * *same* underlying algorithm as the bare token — `ssh-ed25519-cert-v01@
 * openssh.com` is an Ed25519 signature however it is packaged — so they are
 * stripped rather than enumerated. The original token is still carried
 * verbatim on the declaration, so nothing is lost from the evidence.
 */
export function normaliseToken(token: string): string {
  let normalised = token.trim().toLowerCase();
  normalised = normalised.replace(/@[a-z0-9.-]+$/, "");
  normalised = normalised.replace(/-cert-v\d+$/, "");
  normalised = normalised.replace(/^sk-/, "");
  return normalised;
}

/**
 * The canonical algorithm a token declares, or `undefined` for a token this
 * collector does not recognise. Never a guess: see the module header.
 */
export function resolveToken(token: string): TokenMapping | undefined {
  const normalised = normaliseToken(token);
  if (normalised.length === 0) return undefined;

  const exact = TOKEN_MAPPINGS[normalised];
  if (exact) return exact;

  for (const { pattern, resolve } of TOKEN_PATTERNS) {
    const match = normalised.match(pattern);
    if (match) {
      const resolved = resolve(match);
      // A pattern that matches but resolves no size still declares its
      // algorithm; one that resolves nothing at all declares nothing.
      if (resolved) return resolved;
    }
  }
  return undefined;
}

/** Resolve an XML Signature / XML Encryption URI fragment, which has a few tokens of its own on top of the shared table. */
function resolveXmldsigFragment(fragment: string): TokenMapping | undefined {
  return XMLDSIG_ONLY_TOKENS[normaliseToken(fragment)] ?? resolveToken(fragment);
}

/** Every canonical name this collector can emit. Each must resolve in `algorithms.json` — asserted in `algorithm-mapping.test.ts`. */
export const PROTOCOL_CONFIG_ALGORITHMS: readonly string[] = [
  ...new Set([
    ...Object.values(TOKEN_MAPPINGS).map((m) => m.algorithm),
    ...Object.values(XMLDSIG_ONLY_TOKENS).map((m) => m.algorithm),
    // The parametric families' algorithms, which have no literal entry above.
    "ECDSA",
    "ECDH/DH",
    "AES",
  ]),
];

// ───────────────────────── format detection ─────────────────────────

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function parseJsonObject(content: string): Record<string, unknown> | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const OIDC_ALG_FIELD = /_(signing|encryption)_alg_values_supported$/;

/**
 * Which protocol-configuration format, if any, a submitted file is.
 *
 * **Two recognition strategies, chosen per family rather than uniformly.**
 * The SSH and IPsec families have conventional, stable filenames, so they are
 * matched on the basename — the discipline `detectLockfileKind` uses, and it
 * keeps a file called `sshd_config` that happens to be a backup or a template
 * from being missed. The JOSE and SAML families have no conventional filename
 * at all (`metadata.xml`, `idp.xml`, `sp-meta.xml`, `keys.json` are all
 * common), so they are recognised by an unambiguous structural marker in the
 * content instead: a JWKS has a `keys` array of objects with `kty`, an OIDC
 * discovery document has at least one `*_alg_values_supported` field, and SAML
 * metadata has an `EntityDescriptor` element. Those markers are defined by the
 * respective specifications, so this is structural recognition rather than
 * sniffing.
 *
 * `undefined` means "this file is not a protocol configuration this collector
 * understands" — which the ingest path treats as *examined nothing*, distinct
 * from a recognised file that declares no crypto.
 */
export function detectProtocolConfigFormat(path: string, content: string): ProtocolConfigFormat | undefined {
  const name = basename(path).toLowerCase();

  if (name === "sshd_config" || name.startsWith("sshd_config.")) return "sshd-config";
  if (name === "ssh_config" || name.startsWith("ssh_config.")) return "ssh-config";
  if (name === "authorized_keys" || name === "authorized_keys2") return "authorized-keys";
  if (name === "ipsec.conf" || name === "swanctl.conf" || name.endsWith(".swanctl.conf")) return "ipsec-config";

  // `sshd_config.d/hardening.conf`, `swanctl/conf.d/site.conf` — a drop-in
  // directory names the format even when the leaf file does not.
  const lowerPath = path.toLowerCase();
  if (lowerPath.includes("sshd_config.d/")) return "sshd-config";
  if (lowerPath.includes("ssh_config.d/")) return "ssh-config";

  const json = parseJsonObject(content);
  if (json) {
    if (Array.isArray(json.keys) && json.keys.some((k) => k !== null && typeof k === "object" && "kty" in (k as object))) {
      return "jwks";
    }
    if (Object.keys(json).some((key) => OIDC_ALG_FIELD.test(key))) return "oidc-discovery";
    return undefined;
  }

  if (/<(?:[A-Za-z0-9_.-]+:)?EntityDescriptor[\s>]/.test(content)) return "saml-metadata";

  return undefined;
}

// ───────────────────────── ssh / sshd_config ─────────────────────────

/**
 * Directives whose value is a comma-separated algorithm list. Keys are
 * lowercase; OpenSSH keywords are case-insensitive.
 *
 * `PubkeyAcceptedKeyTypes` and `HostbasedKeyTypes` are the pre-8.5 spellings
 * of the two `*AcceptedAlgorithms` directives and are still what most deployed
 * configs say, so both spellings are read. The canonical directive name is
 * carried through verbatim (it is part of the asset identity), so a config
 * renamed from the old spelling to the new one correctly reads as one
 * declaration removed and one added rather than a silent rewrite.
 */
const SSH_ALGORITHM_DIRECTIVES = new Set([
  "hostkeyalgorithms",
  "pubkeyacceptedalgorithms",
  "pubkeyacceptedkeytypes",
  "hostbasedacceptedalgorithms",
  "hostbasedkeytypes",
  "casignaturealgorithms",
  "kexalgorithms",
  "ciphers",
  "macs",
]);

interface SshDirective {
  keyword: string;
  value: string;
  condition?: string;
}

/**
 * Split an ssh/sshd config into its directives, tracking the enclosing
 * `Match` (sshd) or `Host` (ssh) block.
 *
 * **Comment stripping is not cosmetic.** A stock `sshd_config` ships almost
 * entirely as commented-out defaults — `#Ciphers aes128-ctr,...`,
 * `#HostKeyAlgorithms ...` — which are documentation of what the compiled-in
 * default *would* be, not declarations. Treating them as declared would turn
 * every untouched OpenSSH install into a page of findings the administrator
 * did not configure and cannot remove by editing the file.
 */
function parseSshDirectives(content: string): SshDirective[] {
  const directives: SshDirective[] = [];
  let condition: string | undefined;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (line.length === 0) continue;

    // `Keyword value`, `Keyword=value` and `Keyword = value` are all legal.
    const separator = line.search(/[\s=]/);
    if (separator === -1) continue;
    const keyword = line.slice(0, separator);
    const value = line.slice(separator).replace(/^[\s=]+/, "").trim();
    if (value.length === 0) continue;

    const lowerKeyword = keyword.toLowerCase();
    if (lowerKeyword === "match" || lowerKeyword === "host") {
      // A new block opens; everything after it is conditional on this.
      // `Match all` / `Host *` reopen the unconditional scope.
      condition = /^(all|\*)$/i.test(value) ? undefined : `${keyword} ${value}`;
      continue;
    }

    directives.push({ keyword, value, condition });
  }

  return directives;
}

/**
 * OpenSSH list modifiers. A value beginning `+` appends to the default set and
 * `^` prepends to it — in both cases the named algorithms *are* declared. A
 * value beginning `-` **removes** algorithms from the default set: those
 * tokens are the opposite of a declaration, and reporting them would invert
 * the meaning of a hardening directive, turning `Ciphers -aes128-cbc` (an
 * administrator removing a weak cipher) into a finding that the weak cipher is
 * configured.
 */
function applyListModifier(value: string): { tokens: string; declares: boolean } {
  if (value.startsWith("-")) return { tokens: value.slice(1), declares: false };
  if (value.startsWith("+") || value.startsWith("^")) return { tokens: value.slice(1), declares: true };
  return { tokens: value, declares: true };
}

function parseSshConfig(content: string): DeclaredAlgorithm[] {
  const declarations: DeclaredAlgorithm[] = [];

  for (const directive of parseSshDirectives(content)) {
    if (!SSH_ALGORITHM_DIRECTIVES.has(directive.keyword.toLowerCase())) continue;

    const { tokens, declares } = applyListModifier(directive.value);
    if (!declares) continue;

    for (const token of tokens.split(",")) {
      const trimmed = token.trim();
      const resolved = resolveToken(trimmed);
      if (!resolved) continue;
      declarations.push({
        directive: directive.keyword,
        token: trimmed,
        algorithm: resolved.algorithm,
        keySize: resolved.keySize,
        strength: "permitted",
        condition: directive.condition,
      });
    }
  }

  return declarations;
}

// ───────────────────────── authorized_keys ─────────────────────────

/**
 * Every public-key type an `authorized_keys` line may name begins with one of
 * these — `ssh-rsa`, `ssh-ed25519`, `ssh-dss`, `ecdsa-sha2-nistp384`,
 * `sk-ssh-ed25519@openssh.com`. Fields not shaped like one are never tested
 * against the token table at all, which is what stops a *comment* field that
 * happens to read `sha1` or `md5` from being reported as the key's algorithm.
 */
const AUTHORIZED_KEY_TYPE_SHAPE = /^(ssh-|ecdsa-|sk-)/i;

/**
 * An `authorized_keys` line is `[options] <keytype> <base64> [comment]`, where
 * the options field may itself contain quoted spaces (`command="a b"`). Rather
 * than parse the options grammar, the fields shaped like a key type are tested
 * against the token table and the first that resolves wins — a quoted fragment
 * cannot collide with a key-type name.
 *
 * The base64 blob is deliberately not decoded. An RSA key's modulus length is
 * in there, but extracting it means implementing SSH wire-format parsing for
 * one number; `keySize` stays undetermined instead (G-05: undetermined is a
 * legitimate answer, a guessed default is not).
 */
function parseAuthorizedKeys(content: string): DeclaredAlgorithm[] {
  const declarations: DeclaredAlgorithm[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    for (const field of line.split(/\s+/)) {
      if (!AUTHORIZED_KEY_TYPE_SHAPE.test(field)) continue;
      const resolved = resolveToken(field);
      if (!resolved) continue;
      declarations.push({
        directive: "authorized_keys",
        token: field,
        algorithm: resolved.algorithm,
        keySize: resolved.keySize,
        // A key that is present on the box and will be accepted, not an entry
        // on a menu — the strongest thing a config file can state.
        strength: "materialised",
      });
      break;
    }
  }

  return declarations;
}

// ───────────────────────── IPsec / IKE ─────────────────────────

/**
 * strongSwan proposal keywords. `ipsec.conf` uses `ike`/`esp`/`ah`;
 * `swanctl.conf` uses `proposals`/`esp_proposals`/`ah_proposals`. Both spell
 * a proposal the same way: comma-separated alternatives, each a `-`-separated
 * list of transforms (`aes256-sha256-modp2048`), optionally terminated by `!`
 * to mean "these and nothing else".
 */
const IPSEC_PROPOSAL_KEYWORDS = new Set(["ike", "esp", "ah", "proposals", "esp_proposals", "ah_proposals", "ike_proposals"]);

function parseIpsecConfig(content: string): DeclaredAlgorithm[] {
  const declarations: DeclaredAlgorithm[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    const equals = line.indexOf("=");
    if (equals === -1) continue;

    const keyword = line.slice(0, equals).trim();
    if (!IPSEC_PROPOSAL_KEYWORDS.has(keyword.toLowerCase())) continue;

    // The `!` suffix is a strictness flag on the proposal set, not a transform.
    const value = line.slice(equals + 1).trim().replace(/!$/, "");

    for (const proposal of value.split(",")) {
      for (const transform of proposal.split("-")) {
        const trimmed = transform.trim();
        const resolved = resolveToken(trimmed);
        if (!resolved) continue;
        declarations.push({
          directive: keyword,
          token: trimmed,
          algorithm: resolved.algorithm,
          keySize: resolved.keySize,
          strength: "permitted",
        });
      }
    }
  }

  return declarations;
}

// ───────────────────────── JWKS ─────────────────────────

/**
 * A JWK's modulus length in bits, from the base64url `n` parameter. RFC 7518
 * §6.3.1.1 requires `n` to be the unsigned big-endian modulus with no leading
 * zero octets, so its byte length times eight *is* the key size — this is a
 * read, not an estimate, which is why it is worth doing here when the
 * `authorized_keys` blob above is deliberately left alone.
 */
function jwkModulusBits(n: unknown): number | undefined {
  if (typeof n !== "string" || n.length === 0) return undefined;
  try {
    const bytes = Buffer.from(n, "base64url");
    return bytes.length > 0 ? bytes.length * 8 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One declaration per published key.
 *
 * `alg` is preferred when present because it states what the key is *for*
 * (`RS256` vs `PS256` are the same key type and different signature schemes);
 * `kty`/`crv` are the fallback, since `alg` is optional in a JWK. Emitting
 * both would make one key two assets that are really the same fact.
 */
function parseJwks(content: string): DeclaredAlgorithm[] {
  const json = parseJsonObject(content);
  if (!json || !Array.isArray(json.keys)) return [];

  const declarations: DeclaredAlgorithm[] = [];

  for (const entry of json.keys) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const key = entry as Record<string, unknown>;

    const alg = typeof key.alg === "string" ? key.alg : undefined;
    const kty = typeof key.kty === "string" ? key.kty : undefined;
    const crv = typeof key.crv === "string" ? key.crv : undefined;

    if (alg) {
      const resolved = resolveToken(alg);
      if (resolved) {
        declarations.push({
          directive: "alg",
          token: alg,
          algorithm: resolved.algorithm,
          // A published RSA key states its own modulus; prefer that over the
          // `alg` token, which names a hash, not a size.
          keySize: kty === "RSA" ? (jwkModulusBits(key.n) ?? resolved.keySize) : (resolved.keySize ?? curveBitSize(crv ?? "")),
          strength: "materialised",
        });
        continue;
      }
    }

    if (kty === "RSA") {
      declarations.push({
        directive: "kty",
        token: kty,
        algorithm: "RSA",
        keySize: jwkModulusBits(key.n),
        strength: "materialised",
      });
      continue;
    }

    if ((kty === "EC" || kty === "OKP") && crv) {
      const resolved = resolveToken(crv);
      // An EC curve names ECDSA; an OKP curve names either EdDSA (Ed25519/
      // Ed448) or ECDH (X25519/X448), and the token table already knows which.
      const algorithm = kty === "EC" ? "ECDSA" : resolved?.algorithm;
      if (!algorithm) continue;
      declarations.push({
        directive: "crv",
        token: crv,
        algorithm,
        keySize: curveBitSize(crv),
        strength: "materialised",
      });
    }
  }

  return declarations;
}

// ───────────────────────── OIDC discovery ─────────────────────────

/**
 * Every `*_signing_alg_values_supported` / `*_encryption_alg_values_supported`
 * field, matched by suffix rather than enumerated: OpenID Connect Core and its
 * extensions keep adding them (`id_token_`, `userinfo_`, `request_object_`,
 * `token_endpoint_auth_`, `introspection_`, ...) and a hardcoded list would go
 * quietly stale. The field name is carried through as the directive, so a
 * reader can see which one it came from.
 */
function parseOidcDiscovery(content: string): DeclaredAlgorithm[] {
  const json = parseJsonObject(content);
  if (!json) return [];

  const declarations: DeclaredAlgorithm[] = [];

  for (const [field, value] of Object.entries(json)) {
    if (!OIDC_ALG_FIELD.test(field) || !Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry !== "string") continue;
      const resolved = resolveToken(entry);
      if (!resolved) continue;
      declarations.push({
        directive: field,
        token: entry,
        algorithm: resolved.algorithm,
        keySize: resolved.keySize,
        strength: "permitted",
      });
    }
  }

  return declarations;
}

// ───────────────────────── SAML metadata ─────────────────────────

const XMLDSIG_METHOD = /<(?:[A-Za-z0-9_.-]+:)?(SignatureMethod|DigestMethod|EncryptionMethod)\b[^>]*\bAlgorithm\s*=\s*"([^"]+)"/g;

/**
 * XML Signature / XML Encryption method elements.
 *
 * The strength split is by element, which is the most this can honestly tell
 * apart without a real XML parser: a `SignatureMethod` or `DigestMethod` names
 * the algorithm a document *was signed with*, so it is materialised; an
 * `EncryptionMethod` inside a `KeyDescriptor` advertises what the entity will
 * *accept*, so it is permitted.
 *
 * `<ds:X509Certificate>` blobs in the same document are deliberately not
 * read — a certificate is B4's surface, and parsing one here would produce a
 * `config` asset for something that already has a `certificate` identity
 * (issuer + serial) and a collector that reads it properly.
 */
function parseSamlMetadata(content: string): DeclaredAlgorithm[] {
  const declarations: DeclaredAlgorithm[] = [];

  for (const match of content.matchAll(XMLDSIG_METHOD)) {
    const element = match[1];
    const uri = match[2];
    // The algorithm is the URI's fragment (`...xmldsig-more#rsa-sha256`);
    // a URI with no fragment names nothing this table knows.
    const hash = uri.lastIndexOf("#");
    if (hash === -1) continue;
    const fragment = uri.slice(hash + 1);
    const resolved = resolveXmldsigFragment(fragment);
    if (!resolved) continue;
    declarations.push({
      directive: element,
      token: uri,
      algorithm: resolved.algorithm,
      keySize: resolved.keySize,
      strength: element === "EncryptionMethod" ? "permitted" : "materialised",
    });
  }

  return declarations;
}

// ───────────────────────── entry point ─────────────────────────

/** Every algorithm a recognised configuration file declares. An empty array from a recognised file means *examined and empty*, not *unreadable*. */
export function parseProtocolConfig(format: ProtocolConfigFormat, content: string): DeclaredAlgorithm[] {
  switch (format) {
    case "sshd-config":
    case "ssh-config":
      return parseSshConfig(content);
    case "authorized-keys":
      return parseAuthorizedKeys(content);
    case "ipsec-config":
      return parseIpsecConfig(content);
    case "jwks":
      return parseJwks(content);
    case "oidc-discovery":
      return parseOidcDiscovery(content);
    case "saml-metadata":
      return parseSamlMetadata(content);
  }
}
