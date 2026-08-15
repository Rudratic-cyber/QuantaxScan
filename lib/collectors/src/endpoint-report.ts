import type { DeclarationStrength } from "./protocol-config";

/**
 * EP — the **host endpoint report**: the submission contract a Windows or
 * Linux host agent reports against, and the pure decoding of what it says.
 *
 * ## What this is, and what it deliberately is not
 *
 * This is the *ingest half* of a host agent. There is no agent in this
 * repository and shipping one is deliberately out of scope: a binary that runs
 * on a customer's domain controller, reads their machine certificate stores and
 * their Schannel policy, and then authenticates outbound to a SaaS endpoint is a
 * packaging and security-review problem far larger than a collector, and it
 * cannot authenticate at all until credential handling (F4) exists. What is
 * built here is the contract and the persistence, so an agent has a defined
 * thing to report and somewhere to report it to.
 *
 * Like every other module in `@workspace/collectors` this does no I/O: it is
 * handed an already-collected report and returns what that report *says*.
 *
 * ## The one false positive this surface exists to avoid
 *
 * **A host supporting a cipher suite is not the same fact as a host using
 * one.** A stock Windows Server enables dozens of suites in
 * `HKLM\SYSTEM\CurrentControlSet\Control\Cryptography\Configuration\Local\SSL\00010002`
 * that no client will ever select. Reporting those as *in use* would put a
 * hundred phantom findings on every server in an estate.
 *
 * B6 already solved this shape for configuration files and its vocabulary is
 * reused verbatim rather than a second one being invented: every observation
 * carries {@link DeclarationStrength} — `permitted` (the host would accept
 * this if a peer asked) or `materialised` (this specific key is on the box
 * now). See `protocol-config.ts`'s header; the confidence anchors live in
 * `endpoint-collector.ts`.
 *
 * ## And the corollary: a disabled suite is never reported
 *
 * Windows keeps *two* independent registry locations that govern whether a
 * suite can be negotiated — the ordered suite list, and the per-algorithm
 * `Ciphers`/`Hashes`/`KeyExchangeAlgorithms` subkeys under
 * `HKLM\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL`. A
 * hardened server routinely has `RC4 128/128` or `Triple DES 168` set to
 * `Enabled = 0` while the suite list it was never pruned from still names
 * them. Reading only the list reports an algorithm the machine cannot
 * negotiate — a false positive created by the product, from a machine that is
 * correctly configured. So {@link EndpointTlsPolicy.disabledAlgorithms} is
 * part of the report and {@link decodeTlsPolicy} applies it, suppressing the
 * *whole* suite: an unavailable bulk cipher or MAC means the suite cannot be
 * negotiated at all, not that it is negotiated without one.
 *
 * The suppression matches on **(token, size)**, not on the algorithm alone.
 * `AES 128/128` disabled must not silence a `..._AES_256_GCM_...` suite —
 * that is a hardened machine, and reporting nothing for it would be the
 * mirror-image error (a silent false negative on a real 256-bit cipher).
 *
 * ## The token tables here are code, not curated standards data
 *
 * The same call `protocol-config.ts` makes, for the same reason.
 * `TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384` decomposes the way it does because
 * RFC 8446 §B.4 and RFC 5246 §A.5 fix the naming; `AES 128/128` is a registry
 * subkey name Microsoft fixed. Neither is a claim about the world that can go
 * stale, so neither belongs under a `retrievedAt` in
 * `docs/Claude/mappings/` — putting it there would imply the decoding could
 * expire.
 *
 * ## Whole-token matching, and the two traps it closes
 *
 * Matching is on whole `-`/`_`-separated tokens of the suite name, never a
 * substring, and the two cases that makes a difference are both real:
 *
 *  - **`SHA` means HMAC-SHA-1** (RFC 5246 §A.5) and `SHA256`/`SHA384` do not.
 *    A substring match would report every modern SHA-2 suite as carrying
 *    SHA-1 — a hygiene finding on a machine that has none.
 *  - **`TLS_AES_256_GCM_SHA384` is a TLS 1.3 suite and names no key exchange
 *    at all.** RFC 8446 removed it from the suite name because it is
 *    negotiated separately. Inferring `ECDHE` from "it is TLS 1.3 so there
 *    must be one" would be reporting a value nobody stated.
 *
 * An unrecognised token contributes nothing. That makes this collector silent
 * about ChaCha20-Poly1305, Camellia, ARIA and every post-quantum suite rather
 * than wrong about them — a gap, not a false answer, and it is stated in the
 * route's evidence caveat.
 */

// ───────────────────────── the submitted report ─────────────────────────

/**
 * Where a host's durable machine identity came from. Carried so a reader can
 * judge the identity rather than trust it — see {@link EndpointHostReport.machineId}.
 */
export const ENDPOINT_MACHINE_ID_SOURCES = ["windows-machine-guid", "linux-machine-id", "other"] as const;
export type EndpointMachineIdSource = (typeof ENDPOINT_MACHINE_ID_SOURCES)[number];

export const ENDPOINT_OS_FAMILIES = ["windows", "linux", "other"] as const;
export type EndpointOsFamily = (typeof ENDPOINT_OS_FAMILIES)[number];

/**
 * Which stack the host's TLS policy was read from. Decides only how a suite
 * name is spelled (`TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384` versus
 * `ECDHE-RSA-AES256-GCM-SHA384`), and {@link decodeCipherSuite} reads both
 * forms without being told which, so this is evidence rather than a switch.
 */
export const ENDPOINT_TLS_POLICY_PROVIDERS = ["schannel", "openssl", "gnutls", "other"] as const;
export type EndpointTlsPolicyProvider = (typeof ENDPOINT_TLS_POLICY_PROVIDERS)[number];

/**
 * The operating system and build the report was taken from.
 *
 * Carried **so a reader knows what the defaults would have been** — and
 * carried for no other purpose. Nothing in this module consults it. Windows
 * Server 2022's compiled-in suite order is not this product's to assert, and
 * deriving "TLS 1.0 is disabled because this build disables it by default"
 * would be exactly the inference `protocol-config.ts` refuses to make about an
 * absent `Ciphers` directive. If the report does not state a setting, the
 * setting is undetermined.
 */
export interface EndpointOsReport {
  family: EndpointOsFamily;
  /** e.g. `"Windows Server 2022 Datacenter"`, `"Ubuntu 24.04.1 LTS"`. */
  name?: string;
  version?: string;
  /** e.g. `"20348.2402"`, `"6.8.0-45-generic"`. */
  build?: string;
}

/**
 * One certificate in one of the host's machine stores.
 *
 * **The store's own rendering, not the DER.** A Windows machine store can hold
 * several hundred trusted roots, so an agent that shipped every certificate's
 * bytes would send megabytes per host per run; what `Get-ChildItem
 * Cert:\LocalMachine\My` and `openssl storeutl` already give you is these
 * fields. The consequence is priced honestly in the confidence: a certificate
 * here carries 0.8 (`materialised`), below B4's 0.9 for a certificate whose
 * artefact this product actually parsed — see `endpoint-collector.ts`. If you
 * want the parsed tier, `POST /projects/:id/certificates` is the route for it.
 *
 * `keySize` is taken verbatim when the store states one and stays undetermined
 * when it does not (G-05). It is never derived from the algorithm name: `ECC`
 * says nothing about which curve, and a guessed 256 would be a fabricated
 * measurement.
 */
export interface EndpointCertificateReport {
  /**
   * The store's identifier for this certificate — Windows' SHA-1 `Thumbprint`,
   * or any stable per-certificate handle the store exposes. Part of the asset
   * identity; not interpreted as cryptography (it is a store handle here, not
   * a claim that SHA-1 is in use anywhere).
   */
  thumbprint: string;
  /**
   * The store's public-key algorithm string, verbatim: `"RSA"`, `"ECC"`,
   * `"1.2.840.113549.1.1.1"`, `"id-ecPublicKey"`, `"ED25519"`. Resolved by
   * {@link canonicalCertificateKeyAlgorithm}; a string that table does not
   * carry produces **no observation at all** rather than a guess.
   */
  publicKeyAlgorithm?: string;
  /** Bits, as the store states them. Absent = the store did not say; never inferred from the algorithm name. */
  keySize?: number;
  subject?: string;
  issuer?: string;
  serialNumber?: string;
  /** ISO 8601 — jsonb round-trips a string, and a `Date` would become one anyway. */
  notBefore?: string;
  notAfter?: string;
  /**
   * Whether the host holds the private key. Tri-state on purpose: absent means
   * the agent did not report it, which is not the same claim as `false`. It is
   * evidence only — a certificate in a machine store is a specific key present
   * on this host either way, which is what makes every certificate here
   * `materialised`.
   */
  hasPrivateKey?: boolean;
}

export interface EndpointCertificateStoreReport {
  /** e.g. `"LocalMachine\\My"`, `"LocalMachine\\Root"`, `"/etc/ssl/certs"`. Part of the asset identity: the same certificate in the personal store and in the trust anchors is two different facts about the host. */
  store: string;
  /** Present-and-empty means the store was read and holds nothing. Absent stores are simply not reported. */
  certificates: EndpointCertificateReport[];
}

/**
 * One protocol version the host's policy governs.
 *
 * `enabled` is **tri-state and absent is the common case.** Schannel's
 * `Protocols\TLS 1.0\Server\Enabled` REG_DWORD frequently does not exist at
 * all, and when it does not, the compiled-in default for that Windows build
 * applies — which this product does not claim to know. So an entry with no
 * `enabled` is *undetermined*, reported back to the caller under that name and
 * never as either "on" or "off".
 *
 * No protocol version produces an asset in any case: `docs/Claude/mappings/
 * algorithms.json` catalogues algorithms, and inventing a `TLS 1.0` entry there
 * would be a second definition of the algorithm vocabulary living outside the
 * mappings data. The posture is carried as host context instead — see
 * `EndpointLocationDetail.tlsPolicy` — so it is visible without being asserted
 * as cryptography.
 */
export interface EndpointProtocolSetting {
  /** e.g. `"TLS 1.0"`, `"TLS 1.2"`, `"SSL 3.0"` — the policy's own spelling. */
  name: string;
  /** `"server"` / `"client"` where the policy distinguishes them (Schannel does). */
  role?: string;
  /** Absent = the policy does not state it and the OS default applies, which this collector does not claim to know. */
  enabled?: boolean;
}

/**
 * One cipher suite the host's policy names.
 *
 * `enabled` is **required**, unlike {@link EndpointProtocolSetting}'s, and the
 * asymmetry is deliberate. Schannel's suite order (`SSL\00010002\Functions`),
 * OpenSSL's `CipherString` and a GnuTLS priority string are all *lists of what
 * is on*: membership is enablement, there is no per-entry flag to be absent,
 * and an agent that transcribed one of them would have nothing to put in an
 * optional field. Making it optional would make the most realistic input
 * produce nothing at all.
 */
export interface EndpointCipherSuiteSetting {
  /** IANA (`TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384`) or OpenSSL (`ECDHE-RSA-AES256-GCM-SHA384`) spelling; both are read. */
  name: string;
  enabled: boolean;
}

export interface EndpointTlsPolicy {
  provider: EndpointTlsPolicyProvider;
  /** Absent = protocol policy was not collected. Present-and-empty = collected and it governs none. */
  protocols?: EndpointProtocolSetting[];
  /** Absent = the suite list was not collected — which leaves any previously recorded suite untouched rather than retiring it. */
  cipherSuites?: EndpointCipherSuiteSetting[];
  /**
   * Algorithms the host has switched off independently of the suite list —
   * Schannel `Ciphers`/`Hashes`/`KeyExchangeAlgorithms` subkeys with
   * `Enabled = 0`, spelled exactly as the registry does (`"AES 128/128"`,
   * `"Triple DES 168"`, `"SHA"`). Any suite that needs one of these is
   * suppressed entirely; see the module header.
   */
  disabledAlgorithms?: string[];
}

/**
 * A cryptographic provider the host has loaded — a CNG KSP, a CAPI CSP, a
 * PKCS#11 module, an OpenSSL provider or engine.
 *
 * **Reported and echoed, but it produces no observation**, and the reason is
 * the discipline this whole lane is built on: a loaded provider is a
 * *capability*, not a key. "Microsoft Platform Crypto Provider is loaded" says
 * a TPM is available to applications that ask for it, not that anything on this
 * host used it, and turning a capability into an algorithm asset would put a
 * finding on every Windows machine ever built. It is carried as host context on
 * every observation this host does produce, so a reader can see the key-storage
 * posture beside the keys.
 */
export interface EndpointProviderReport {
  name: string;
  /** e.g. `"cng-ksp"`, `"capi-csp"`, `"pkcs11"`, `"openssl-provider"`. Free text — display and evidence only. */
  kind?: string;
  /** Absent = the agent did not say. Never defaulted. */
  loaded?: boolean;
  version?: string;
}

/**
 * One host's report.
 *
 * **Every section is optional, and absent means "not collected".** That is not
 * tidiness — it is what keeps a partial agent run from retiring assets it never
 * looked at. An agent that read the TLS policy but not the certificate stores
 * puts the host's suite declarations in scope for reobservation and leaves its
 * certificates alone; a section that is *present and empty* says "I read this
 * and it holds nothing", which correctly retires what used to be there. See
 * `endpoint-collector.ts`'s `reobservedLocations`.
 */
export interface EndpointHostReport {
  /**
   * The host's durable machine identity, and the single most consequential
   * field in this contract — see {@link resolveHostIdentity} for the full
   * argument and the values that are rejected.
   */
  machineId: string;
  machineIdSource?: EndpointMachineIdSource;
  /** Display only. Deliberately NOT identity: hostnames get changed and, worse, reused. */
  hostname?: string;
  os?: EndpointOsReport;
  /** ISO 8601, when the agent collected this. Evidence only. */
  collectedAt?: string;
  certificateStores?: EndpointCertificateStoreReport[];
  tlsPolicy?: EndpointTlsPolicy;
  providers?: EndpointProviderReport[];
}

// ───────────────────────── host identity ─────────────────────────

/**
 * Why a host in a submission was not ingested. Every one is reported back to
 * the caller by name: a host silently missing from a result is
 * indistinguishable from a host with nothing to report, and only one of those
 * is a problem the operator can fix.
 */
export const ENDPOINT_HOST_SKIP_REASONS = [
  "placeholder-machine-id",
  "duplicate-machine-id",
  "nothing-collected",
] as const;
export type EndpointHostSkipReason = (typeof ENDPOINT_HOST_SKIP_REASONS)[number];

/**
 * Machine identities that are structurally present and carry no identity.
 *
 * The nil UUID is what a Windows host returns when `MachineGuid` has been
 * cleared, and an all-zero `/etc/machine-id` is what systemd writes into a
 * golden image precisely so first boot will regenerate one. Both are the
 * *absence* of an identity wearing the shape of one, and accepting either would
 * fingerprint every re-imaged machine in a fleet as the same host.
 */
const PLACEHOLDER_MACHINE_IDS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "00000000000000000000000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
]);

/**
 * The identity a host asset is fingerprinted under.
 *
 * **What identity survives a reboot but changes when it is genuinely a
 * different machine?** Not the hostname: a host gets renamed on a whim, and —
 * the failure that actually costs you — hostnames are *reused*, so the
 * decommissioned `web-01` and its replacement would be one asset with one
 * history and a silently rewritten crypto posture. Not an IP address, for the
 * same reason and faster. Not a hardware serial or a MAC: a virtual machine
 * has neither meaningfully, and both survive a re-image, which is exactly the
 * event that *should* mint a new host.
 *
 * What does have the right lifetime is the identifier the OS generates when it
 * is installed and never changes afterwards: Windows'
 * `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` and Linux'
 * `/etc/machine-id`. Both survive reboot, rename, re-address and re-IP; both
 * are regenerated by a re-image or a fresh install, which is when the machine
 * genuinely is a different one. That is the identity this surface uses.
 *
 * It has one well-known failure and this function catches both halves of it.
 * A cloned VM inherits its template's identifier, so two live hosts can report
 * the same one. From a single host that is undetectable — but **within one
 * submission it is not**, and two hosts reporting the same machineId are a
 * clone collision, not one host reported twice. Merging them would produce a
 * single host asset whose certificate stores and TLS policy are an interleaving
 * of two different machines: a wrong answer that reads as a confident one. So
 * *both* are skipped, not "the second one" — there is no basis for preferring
 * either, and keeping one would be picking a winner at random.
 *
 * There is no hostname fallback for a host that supplies no machineId. A
 * fallback is how this ends up keyed on hostname for the hosts where it matters
 * most, and a submission missing the field is a bug in the agent that should be
 * loud.
 */
export function resolveHostIdentity(hosts: readonly EndpointHostReport[]): Array<{
  host: EndpointHostReport;
  /** `undefined` when the host is ingestable. */
  skipped?: EndpointHostSkipReason;
}> {
  const counts = new Map<string, number>();
  for (const host of hosts) {
    const key = host.machineId.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return hosts.map((host) => {
    const key = host.machineId.trim().toLowerCase();
    if (key.length === 0 || PLACEHOLDER_MACHINE_IDS.has(key)) {
      return { host, skipped: "placeholder-machine-id" as const };
    }
    if ((counts.get(key) ?? 0) > 1) return { host, skipped: "duplicate-machine-id" as const };
    if (host.certificateStores === undefined && host.tlsPolicy === undefined && host.providers === undefined) {
      return { host, skipped: "nothing-collected" as const };
    }
    return { host };
  });
}

// ───────────────────────── cipher-suite decoding ─────────────────────────

interface SuiteTokenMapping {
  algorithm: string;
  /** Whether a following all-digits token is this token's key width (`AES_256`, `AES256`). */
  sized?: boolean;
}

/**
 * Whole suite-name token → canonical algorithm.
 *
 * Tokens deliberately absent, because `algorithms.json` has no canonical name
 * for them and inventing one here would be a second definition of the algorithm
 * vocabulary: `SHA256`/`SHA384`/`SHA512`, `CHACHA20`, `POLY1305`, `3DES`,
 * `DES`, `RC4`, `RC2`, `IDEA`, `SEED`, `CAMELLIA`, `ARIA`, `NULL`, `PSK`,
 * `SRP`, `KRB5`, and the mode/framing tokens (`WITH`, `GCM`, `CCM`, `CBC`,
 * `EDE`, `EXPORT`). They contribute nothing.
 *
 * The anonymous key exchanges (`ADH`, `AECDH`, `ANON`) are absent too, and that
 * one is a judgement rather than a gap: they *are* Diffie-Hellman, but they are
 * also unauthenticated suites no supported stack enables, and every real
 * appearance of the token is in a disabled-by-default list. Reporting them
 * would put quantum-vulnerable key agreement on a machine that cannot
 * negotiate it.
 */
const SUITE_TOKEN_MAPPINGS: Record<string, SuiteTokenMapping> = {
  // ── Key exchange (RFC 5246 §A.5, RFC 4492) ──
  ECDHE: { algorithm: "ECDH/DH" },
  ECDH: { algorithm: "ECDH/DH" },
  DHE: { algorithm: "ECDH/DH" },
  EDH: { algorithm: "ECDH/DH" },
  DH: { algorithm: "ECDH/DH" },
  // ── Authentication / key transport ──
  RSA: { algorithm: "RSA" },
  ECDSA: { algorithm: "ECDSA" },
  DSS: { algorithm: "DSA" },
  DSA: { algorithm: "DSA" },
  // ── Bulk cipher ──
  AES: { algorithm: "AES", sized: true },
  // ── MAC. `SHA` alone is HMAC-SHA-1 (RFC 5246 §A.5); `SHA256`/`SHA384` are
  //    deliberately not here, and whole-token matching is what keeps them apart.
  SHA: { algorithm: "SHA-1" },
  MD5: { algorithm: "MD5" },
};

/**
 * Split a suite name into comparable whole tokens, in either spelling.
 *
 * IANA writes the bulk cipher and its width as two tokens
 * (`..._WITH_AES_256_GCM_...`); OpenSSL joins them (`...-AES256-GCM-...`). The
 * join is undone here rather than handled twice downstream, so `AES` is a whole
 * token in both forms and its width is always the token after it. Without that,
 * an OpenSSL-spelled suite would resolve `AES` with no size at all — not a
 * false positive, but it would collapse AES-128 and AES-256 into one
 * indistinguishable asset, which is the exact confusion `fingerprint.ts` carries
 * a `token` field to prevent.
 */
export function cipherSuiteTokens(name: string): string[] {
  return name
    .trim()
    .toUpperCase()
    .split(/[-_ ]+/)
    .filter((token) => token.length > 0)
    .flatMap((token) => {
      const joined = /^(AES|RC4|RC2|DES|CAMELLIA|ARIA|SEED)(\d+)$/.exec(token);
      return joined ? [joined[1], joined[2]] : [token];
    });
}

/**
 * One algorithm a cipher suite's name states.
 *
 * Prefixed `Endpoint` because B11's `cipher-suite.ts` exports a
 * `CipherSuiteComponent` of its own, and the two are genuinely different types
 * rather than a duplicate: B11's carries a `role` because a *negotiated* suite
 * has to say which half of the handshake each algorithm served, while this one
 * decodes a suite the host merely *permits* and has no role to report. The two
 * lanes were written in parallel and collided on the name at merge; unifying
 * them would have given one surface a field it cannot populate honestly.
 */
export interface EndpointCipherSuiteComponent {
  /** The token(s) that produced it, normalised — `ECDHE`, `RSA`, `AES_256`, `SHA`. Part of the asset identity. */
  token: string;
  algorithm: string;
  /** Stated by the name, never assumed. A suite naming no width leaves this undetermined (G-05). */
  keySize?: number;
}

/**
 * Every algorithm a cipher suite's *name* states.
 *
 * Deduplicated by (algorithm, size): `TLS_ECDHE_RSA_...` names one key
 * agreement and one signature algorithm, not four assets. A name this table
 * recognises nothing in returns an empty array, which is how a ChaCha20 or a
 * post-quantum suite passes through silently rather than wrongly.
 */
export function decodeCipherSuite(name: string): EndpointCipherSuiteComponent[] {
  const tokens = cipherSuiteTokens(name);
  const components: EndpointCipherSuiteComponent[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const mapping = SUITE_TOKEN_MAPPINGS[token];
    if (!mapping) continue;

    const next = tokens[index + 1];
    const keySize = mapping.sized === true && next !== undefined && /^\d+$/.test(next) ? Number(next) : undefined;

    const key = `${mapping.algorithm}|${keySize ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    components.push({
      token: keySize === undefined ? token : `${token}_${keySize}`,
      algorithm: mapping.algorithm,
      keySize,
    });
  }

  return components;
}

// ───────────────────────── disabled-algorithm suppression ─────────────────────────

interface DisabledAlgorithmMapping {
  /** Whole suite-name tokens this registry entry makes unavailable. */
  suiteTokens: readonly string[];
  /** The width the entry names, where it names one. */
  keySize?: number;
}

/**
 * Schannel `Ciphers` / `Hashes` / `KeyExchangeAlgorithms` subkey names →
 * what a suite has to contain for the entry to make it unnegotiable.
 *
 * Matched exactly (case-insensitively) rather than parsed, because the names are
 * a fixed vocabulary and a parser would happily invent a match for a string it
 * half-understood. **A name not in this table suppresses nothing and is
 * reported back to the caller** as `unrecognisedDisabledAlgorithms` — this is
 * the one place where failing to understand the input risks a false positive
 * rather than an omission, so it is surfaced instead of swallowed.
 */
const SCHANNEL_DISABLED_ALGORITHMS: Record<string, DisabledAlgorithmMapping> = {
  "aes 128/128": { suiteTokens: ["AES"], keySize: 128 },
  "aes 192/192": { suiteTokens: ["AES"], keySize: 192 },
  "aes 256/256": { suiteTokens: ["AES"], keySize: 256 },
  "triple des 168": { suiteTokens: ["3DES", "DES", "CBC3"] },
  "des 56/56": { suiteTokens: ["DES"] },
  "rc4 128/128": { suiteTokens: ["RC4"] },
  "rc4 64/128": { suiteTokens: ["RC4"] },
  "rc4 56/128": { suiteTokens: ["RC4"] },
  "rc4 40/128": { suiteTokens: ["RC4"] },
  "rc2 128/128": { suiteTokens: ["RC2"] },
  "rc2 56/128": { suiteTokens: ["RC2"] },
  "rc2 40/128": { suiteTokens: ["RC2"] },
  null: { suiteTokens: ["NULL"] },
  md5: { suiteTokens: ["MD5"] },
  sha: { suiteTokens: ["SHA"] },
  sha256: { suiteTokens: ["SHA256"] },
  sha384: { suiteTokens: ["SHA384"] },
  sha512: { suiteTokens: ["SHA512"] },
  "diffie-hellman": { suiteTokens: ["DH", "DHE", "EDH"] },
  ecdh: { suiteTokens: ["ECDH", "ECDHE"] },
  // Schannel's name for RSA key transport under `KeyExchangeAlgorithms`.
  pkcs: { suiteTokens: ["RSA"] },
};

/**
 * Whether one disabled-algorithm entry makes this suite unnegotiable.
 *
 * The size rule is the whole subtlety. An entry that names a width only
 * suppresses a suite that names the *same* width — `AES 128/128` must leave
 * `TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384` alone, because a machine that
 * disabled AES-128 and kept AES-256 has hardened itself and reporting nothing
 * for it would erase a real 256-bit cipher from the estate. Where the suite
 * states no width for the token (`Triple DES 168` against
 * `..._3DES_EDE_CBC_...`) there is nothing to disagree with and the entry
 * applies.
 */
function suiteIsDisabledBy(tokens: readonly string[], mapping: DisabledAlgorithmMapping): boolean {
  for (const [index, token] of tokens.entries()) {
    if (!mapping.suiteTokens.includes(token)) continue;
    if (mapping.keySize === undefined) return true;
    const next = tokens[index + 1];
    const suiteSize = next !== undefined && /^\d+$/.test(next) ? Number(next) : undefined;
    if (suiteSize === undefined || suiteSize === mapping.keySize) return true;
  }
  return false;
}

/** What a host's TLS policy actually declares, once the disabled-algorithm entries have been applied. */
export interface DecodedTlsPolicy {
  provider: EndpointTlsPolicyProvider;
  /** One entry per (suite, algorithm) that survives. */
  declarations: Array<{ suite: string; component: EndpointCipherSuiteComponent }>;
  /** Suites named as enabled but suppressed by a `disabledAlgorithms` entry, with the entry that did it — reported so the suppression is auditable rather than invisible. */
  suppressedSuites: Array<{ suite: string; disabledBy: string }>;
  /** Suite names that decoded to no algorithm this product catalogues (ChaCha20, Camellia, a PQC suite). Reported as a known silence, not as a clean result. */
  undecodedSuites: string[];
  /** `disabledAlgorithms` entries this collector does not recognise, and therefore could not act on. The one input whose misreading risks a false positive. */
  unrecognisedDisabledAlgorithms: string[];
  enabledProtocols: string[];
  disabledProtocols: string[];
  /** Protocols the policy names but does not state an `enabled` value for — the OS default applies and this product does not claim to know it. */
  undeterminedProtocols: string[];
}

/**
 * Decode a host's TLS policy: what it permits, what it forbids, and what this
 * collector could not read.
 *
 * A suite with `enabled: false` never reaches the declarations, and neither
 * does one any `disabledAlgorithms` entry covers. Both exclusions are reported
 * rather than merely applied — a suppression nobody can see is
 * indistinguishable from a collector that simply missed the suite.
 */
export function decodeTlsPolicy(policy: EndpointTlsPolicy): DecodedTlsPolicy {
  const unrecognisedDisabledAlgorithms: string[] = [];
  const disabled: Array<{ name: string; mapping: DisabledAlgorithmMapping }> = [];

  for (const name of policy.disabledAlgorithms ?? []) {
    const mapping = SCHANNEL_DISABLED_ALGORITHMS[name.trim().toLowerCase()];
    if (mapping) disabled.push({ name, mapping });
    else unrecognisedDisabledAlgorithms.push(name);
  }

  const declarations: DecodedTlsPolicy["declarations"] = [];
  const suppressedSuites: DecodedTlsPolicy["suppressedSuites"] = [];
  const undecodedSuites: string[] = [];

  for (const suite of policy.cipherSuites ?? []) {
    // Not enabled is not a declaration. This is the difference between "the
    // registry lists this suite" and "the host will negotiate it".
    if (!suite.enabled) continue;

    const tokens = cipherSuiteTokens(suite.name);
    const blocking = disabled.find((entry) => suiteIsDisabledBy(tokens, entry.mapping));
    if (blocking) {
      suppressedSuites.push({ suite: suite.name, disabledBy: blocking.name });
      continue;
    }

    const components = decodeCipherSuite(suite.name);
    if (components.length === 0) {
      undecodedSuites.push(suite.name);
      continue;
    }
    for (const component of components) declarations.push({ suite: suite.name, component });
  }

  const enabledProtocols: string[] = [];
  const disabledProtocols: string[] = [];
  const undeterminedProtocols: string[] = [];
  for (const protocol of policy.protocols ?? []) {
    const label = protocol.role === undefined ? protocol.name : `${protocol.name} (${protocol.role})`;
    if (protocol.enabled === true) enabledProtocols.push(label);
    else if (protocol.enabled === false) disabledProtocols.push(label);
    else undeterminedProtocols.push(label);
  }

  return {
    provider: policy.provider,
    declarations,
    suppressedSuites,
    undecodedSuites,
    unrecognisedDisabledAlgorithms,
    enabledProtocols,
    disabledProtocols,
    undeterminedProtocols,
  };
}

// ───────────────────────── certificate key algorithms ─────────────────────────

interface CertificateKeyMapping {
  algorithm: string;
  /** Only where the algorithm identifier itself fixes the size — an Ed25519 key is 256 bits by definition. Never a per-family default. */
  keySize?: number;
}

/**
 * A certificate store's public-key algorithm string → canonical algorithm.
 *
 * Keys are lowercased. Three vocabularies overlap here because three tools
 * spell the same fact differently — Windows' CryptoAPI friendly names (`RSA`,
 * `ECC`, `DSA`), OpenSSL's (`rsaEncryption`, `id-ecPublicKey`, `ED25519`), and
 * the bare OIDs any of them may fall back to when there is no friendly name.
 *
 * **`ECC` resolves to `ECDSA` and to no key size.** Windows' friendly name says
 * only that the key is elliptic-curve; it names no curve, so a P-256 key and a
 * P-521 key are the same string. The size comes from the store's own `keySize`
 * or it stays undetermined — deriving 256 from "ECC" would be inventing a
 * measurement, which is exactly what G-05 makes `assets.key_size` nullable to
 * prevent.
 *
 * A string absent from this table produces **no observation**. That includes
 * every ML-DSA and SLH-DSA OID: a post-quantum certificate is silently not
 * reported rather than misclassified as something classical, which is the same
 * trade `protocol-config.ts` makes for hybrid key exchange.
 */
const CERTIFICATE_KEY_ALGORITHM_MAPPINGS: Record<string, CertificateKeyMapping> = {
  rsa: { algorithm: "RSA" },
  rsaencryption: { algorithm: "RSA" },
  "rsassa-pss": { algorithm: "RSA" },
  "1.2.840.113549.1.1.1": { algorithm: "RSA" },
  "1.2.840.113549.1.1.10": { algorithm: "RSA" },
  ecc: { algorithm: "ECDSA" },
  ec: { algorithm: "ECDSA" },
  ecdsa: { algorithm: "ECDSA" },
  "id-ecpublickey": { algorithm: "ECDSA" },
  "1.2.840.10045.2.1": { algorithm: "ECDSA" },
  dsa: { algorithm: "DSA" },
  "1.2.840.10040.4.1": { algorithm: "DSA" },
  ed25519: { algorithm: "EdDSA", keySize: 256 },
  "1.3.101.112": { algorithm: "EdDSA", keySize: 256 },
  ed448: { algorithm: "EdDSA", keySize: 448 },
  "1.3.101.113": { algorithm: "EdDSA", keySize: 448 },
};

/**
 * The canonical algorithm a store's public-key string names, or `undefined`
 * for one this collector does not recognise. Never a guess — see the table's
 * own comment.
 */
export function canonicalCertificateKeyAlgorithm(raw: string): CertificateKeyMapping | undefined {
  return CERTIFICATE_KEY_ALGORITHM_MAPPINGS[raw.trim().toLowerCase()];
}

/** Every canonical name this surface can emit. Each must resolve in `algorithms.json` — asserted in `algorithm-mapping.test.ts`. */
export const ENDPOINT_ALGORITHMS: readonly string[] = [
  ...new Set([
    ...Object.values(SUITE_TOKEN_MAPPINGS).map((m) => m.algorithm),
    ...Object.values(CERTIFICATE_KEY_ALGORITHM_MAPPINGS).map((m) => m.algorithm),
  ]),
];

/** Re-exported so the observation layer and the API can name the tier without importing B6's module for a type. */
export type { DeclarationStrength };
