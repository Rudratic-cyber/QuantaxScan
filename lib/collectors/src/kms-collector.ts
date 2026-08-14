import { curveBitSize } from "./named-curves";
import { resolveKmsKeySpec, type KmsKeySpecEntry, type KmsProvider } from "./kms-key-specs";
import type { KmsLocationDetail } from "./location-detail";
import type { RawObservation } from "./types";

/**
 * B5 — the KMS / secret-store collector (docs/Claude/03-features.md B5).
 *
 * This is the surface that finds the keys protecting everything else: a
 * customer's TLS and data-at-rest posture is downstream of what their key
 * store actually holds. It is also the surface where the temptation to guess
 * is strongest, because the four providers disagree about how much they tell
 * you — so most of this file is about *not* guessing.
 *
 * **It performs no I/O and takes no credential.** The ingest path is
 * submission-based: the caller POSTs the key inventory their own
 * `aws kms describe-key` / `az keyvault key show` / `gcloud kms keys list` /
 * `vault read transit/keys/<name>` already produced, exactly the way B4
 * accepts a submitted PEM rather than fetching one from a live host. Four
 * live-credentialed pollers would mean four cloud SDKs inside a package that
 * is deliberately dependency-free (AGENTS.md §"Package boundaries", so it can
 * ship as a standalone on-prem agent), four auth flows, and long-lived
 * read-only credentials to a customer's key store held in a system whose
 * secret-handling controls (F4) are not built. A submission route makes the
 * surface genuinely `live` and testable end to end today; a credentialed
 * poller is a strictly additive follow-up that produces the same
 * `KmsKeyDescription` values this file already maps.
 *
 * The consequence is stated in every response and belongs in any report
 * built on this data: **the export is taken at its word.** Nothing here
 * proves the submitted inventory is complete, current, or from the key store
 * the caller says it is. That is why the confidence sits below B4's.
 */

/**
 * One key as a provider described it. Every field beyond `provider` and
 * `keyId` is optional because every field beyond those is optional in the
 * exports this reads — `aws kms list-keys` returns a bare `KeyId`/`KeyArn`
 * and nothing else, and Azure's list operation returns `kid` and
 * `attributes` with no key type at all.
 *
 * `undefined` therefore means "the export did not state this", and is never
 * substituted for. `rotationEnabled` is the sharpest case: `false` is a
 * claim that the provider rotates nothing, which is not the same statement
 * as "we were not told", and defaulting one to the other would put a
 * finding on a key nobody made a claim about.
 */
export interface KmsKeyDescription {
  provider: KmsProvider;
  /** ARN, resource name, `kid`, or mount-qualified key name. The key's identity, and half of its fingerprint. */
  keyId: string;
  /** The provider-native spec string: AWS `KeySpec`, GCP `CryptoKeyVersion.algorithm`, Azure `kty`, Vault `type`. */
  keySpec?: string;
  /** Curve, where the provider states it separately from the spec — Azure's `crv`. Resolved through `named-curves.ts`. */
  curve?: string;
  /**
   * A key size the caller has and the spec does not state — Azure's Create
   * Key `key_size`, or an operator's own record. Used only when neither the
   * spec nor a curve supplies one, so a caller cannot override a documented
   * fact with a typo.
   */
  keySize?: number;
  alias?: string;
  keyState?: string;
  rotationEnabled?: boolean;
  rotationPeriodDays?: number;
  lastRotatedAt?: string;
  origin?: string;
  region?: string;
  keyStore?: string;
}

/**
 * Confidence (docs/Claude/09-open-gaps.md G-11). Above the dependency
 * collector's 0.8 `dedicated` tier: a key store states what a key *is*
 * rather than what a library *could do*, so the second inference the
 * dependency tiers agonise over ("is this primitive actually used?") does
 * not arise — a key exists and has the algorithm the provider says.
 *
 * Below B4's 0.9, and the gap is the whole submission-based design: a parsed
 * certificate is the artifact itself, present in the request and read
 * directly, whereas this is the provider's metadata *about* a key, relayed
 * by the caller. Two things could be wrong that cannot be wrong for a
 * certificate — the export could be stale, and it could be partial. Nowhere
 * near 1.0, which stays reserved for observing an algorithm in operation.
 */
export const KMS_KEY_CONFIDENCE = 0.85;

/**
 * SP 1800-38B §4.1.4's own name for management-plane data — a key store's
 * API is configuration about cryptography, not a wire observation and not an
 * endpoint agent. Deliberately not `manual_attestation`: that modality is
 * for a human asserting a fact from knowledge (B8's register, B9's
 * questionnaire), and a machine-generated `describe-key` output is not that,
 * even though a human pasted it.
 */
const KMS_DISCOVERY_MODALITY = "configuration_information" as const;

/** Where a reported key size came from, carried on the observation's evidence so a reader never has to guess which of four sources won. */
export type KeySizeSource = "key-spec" | "curve" | "submitted" | "not-supplied";

/**
 * What this collector concluded about one submitted key. Four outcomes, and
 * the distinctions between them are the point of the type:
 *
 *  - `observed` — the spec resolved to a catalogued algorithm; an
 *    observation exists and will become an asset.
 *  - `no-algorithm` — the spec is one we know, and its primitive is one
 *    `algorithms.json` does not catalogue (HMAC, ChaCha20-Poly1305, SM2,
 *    every post-quantum parameter set, Azure's `kty: oct`). The key is real
 *    and counted; there is simply nothing for this product to report about
 *    it. **This is a successful examination**, and treating it as a failure
 *    would understate coverage for a key store that is entirely symmetric.
 *  - `unrecognised-spec` — the provider stated a spec our table does not
 *    have. That is our data being behind the provider, and it is the one
 *    outcome that should prompt a `kms-key-specs.json` update.
 *  - `no-spec` — the export named a key and said nothing about it, which is
 *    exactly what `aws kms list-keys` and Azure's list operation return. The
 *    key is known to exist and nothing about its cryptography is known.
 *
 * Collapsing the last three into one "skipped" bucket would hide the only
 * one that is actionable, so the route reports them separately.
 */
export type KmsKeyOutcome =
  | { kind: "observed"; key: KmsKeyDescription; entry: KmsKeySpecEntry; observation: RawObservation }
  | { kind: "no-algorithm"; key: KmsKeyDescription; entry: KmsKeySpecEntry; reason: string }
  | { kind: "unrecognised-spec"; key: KmsKeyDescription; reason: string }
  | { kind: "no-spec"; key: KmsKeyDescription; reason: string };

const UNRECOGNISED_SPEC_REASON =
  "This key store reported a key spec that is not in kms-key-specs.json. The key is recorded as present " +
  "and un-classified rather than mapped to the nearest similar spec — a wrong algorithm is worse than none. " +
  "Adding the spec to that file (with a citation) is what classifies it.";

const NO_SPEC_REASON =
  "The submitted entry named a key but stated no key spec. `aws kms list-keys` and Azure Key Vault's list " +
  "operation both return identifiers only, so this is the expected shape of a list-without-describe export: " +
  "the key is known to exist and nothing about its cryptography is known. Re-submit with the describe/get " +
  "output to classify it.";

/**
 * The stable, opaque locator. `<repo>:kms:<provider>:<keyId>` — the same
 * pair `fingerprint.ts`'s `kms` variant hashes, so the two cannot disagree
 * about which key a row is. Not the alias: an alias is repointable at a
 * different key, which would make it a locator that silently changes what it
 * locates.
 */
export function kmsKeyLocation(repo: string, provider: string, keyId: string): string {
  return `${repo}:kms:${provider}:${keyId}`;
}

/** The `<repo>:kms:<provider>:` family a submission for one provider covers. Not used as a reobservation scope — see `asset-ingest.ts` for why. */
export function kmsLocationPrefix(repo: string, provider: string): string {
  return `${repo}:kms:${provider}:`;
}

/**
 * Key size, and where it came from. The precedence is deliberate:
 *
 *  1. the spec's documented size — `RSA_4096` is 4096 bits by definition,
 *     and a caller cannot be more right about that than AWS's own guide;
 *  2. the curve the provider named separately (Azure `crv: P-384`),
 *     resolved through `named-curves.ts` rather than a second bit-size
 *     table, so one curve name means one size on every surface;
 *  3. a size the caller supplied, for the real case where the provider
 *     states none — an Azure JsonWebKey has no `key_size` member at all;
 *  4. null.
 *
 * Nothing in this chain invents a value. Step 4 is the honest end state for
 * an Azure RSA key described only by `kty`, and `assets.key_size` is
 * nullable with no default precisely so it can be recorded (G-05).
 */
function resolveKeySize(
  entry: KmsKeySpecEntry,
  key: KmsKeyDescription,
): { keySize: number | undefined; source: KeySizeSource } {
  if (entry.keySize !== null) return { keySize: entry.keySize, source: "key-spec" };
  if (key.curve !== undefined) {
    const fromCurve = curveBitSize(key.curve);
    if (fromCurve !== undefined) return { keySize: fromCurve, source: "curve" };
  }
  if (key.keySize !== undefined) return { keySize: key.keySize, source: "submitted" };
  return { keySize: undefined, source: "not-supplied" };
}

function locationDetailFor(key: KmsKeyDescription): KmsLocationDetail {
  // Built field by field rather than spread: `exactOptionalPropertyTypes` is
  // on, and an explicit `undefined` is not the same as an absent key once it
  // reaches `jsonb`.
  const detail: KmsLocationDetail = { provider: key.provider, keyId: key.keyId };
  if (key.keySpec !== undefined) detail.keySpec = key.keySpec;
  if (key.curve !== undefined) detail.curve = key.curve;
  if (key.alias !== undefined) detail.alias = key.alias;
  if (key.keyState !== undefined) detail.keyState = key.keyState;
  if (key.rotationEnabled !== undefined) detail.rotationEnabled = key.rotationEnabled;
  if (key.rotationPeriodDays !== undefined) detail.rotationPeriodDays = key.rotationPeriodDays;
  if (key.lastRotatedAt !== undefined) detail.lastRotatedAt = key.lastRotatedAt;
  if (key.origin !== undefined) detail.origin = key.origin;
  if (key.region !== undefined) detail.region = key.region;
  if (key.keyStore !== undefined) detail.keyStore = key.keyStore;
  return detail;
}

/**
 * Classify every submitted key — the full result, including the keys that
 * produced no observation. Callers that only want observations use
 * `collectKmsObservations`; the route uses this, because "we looked at 40
 * keys, classified 31, and here is what the other 9 were" is the answer a
 * KMS inventory has to give.
 *
 * Synchronous, like every other collector here: mapping in-memory
 * descriptions has no genuine asynchrony.
 */
export function classifyKmsKeys(repo: string, keys: readonly KmsKeyDescription[]): KmsKeyOutcome[] {
  return keys.map((key): KmsKeyOutcome => {
    if (key.keySpec === undefined || key.keySpec.trim() === "") {
      return { kind: "no-spec", key, reason: NO_SPEC_REASON };
    }

    const entry = resolveKmsKeySpec(key.provider, key.keySpec);
    if (entry === undefined) {
      return { kind: "unrecognised-spec", key, reason: UNRECOGNISED_SPEC_REASON };
    }
    if (entry.algorithm === null) {
      return {
        kind: "no-algorithm",
        key,
        entry,
        // The table's own words, not a summary of them — the reason a
        // customer sees is the reason the curated data records.
        reason: entry.noAlgorithmReason ?? UNRECOGNISED_SPEC_REASON,
      };
    }

    const { keySize, source } = resolveKeySize(entry, key);
    const location = kmsKeyLocation(repo, key.provider, key.keyId);

    const observation: RawObservation = {
      algorithm: entry.algorithm,
      // Undetermined stays undetermined all the way to `assets.key_size` —
      // the ingest layer turns this `undefined` into SQL NULL and never a
      // default. G-05.
      ...(keySize === undefined ? {} : { keySize }),
      location,
      locationDetail: { kind: "kms", kms: locationDetailFor(key) },
      discoveryModality: KMS_DISCOVERY_MODALITY,
      confidence: KMS_KEY_CONFIDENCE,
      evidence: {
        provider: key.provider,
        keyId: key.keyId,
        keySpec: key.keySpec,
        keySpecQuote: entry.quote,
        keySpecStatus: entry.status,
        /** Which of the four sources supplied the size — `not-supplied` when none did, which is a fact worth recording rather than an absence. */
        keySizeSource: source,
        ...(key.curve === undefined ? {} : { curve: key.curve }),
        ...(key.alias === undefined ? {} : { alias: key.alias }),
        ...(key.keyState === undefined ? {} : { keyState: key.keyState }),
        // Present only when the export stated it. An absent key here reads
        // as "not stated" in the evidence blob, which is the truth; a
        // `false` would read as "rotation is off".
        ...(key.rotationEnabled === undefined ? {} : { rotationEnabled: key.rotationEnabled }),
        ...(key.rotationPeriodDays === undefined ? {} : { rotationPeriodDays: key.rotationPeriodDays }),
        ...(key.lastRotatedAt === undefined ? {} : { lastRotatedAt: key.lastRotatedAt }),
        ...(key.origin === undefined ? {} : { origin: key.origin }),
        ...(key.region === undefined ? {} : { region: key.region }),
        ...(key.keyStore === undefined ? {} : { keyStore: key.keyStore }),
      },
    };

    return { kind: "observed", key, entry, observation };
  });
}

/** The observations alone — one per key whose spec resolved to a catalogued algorithm. */
export function collectKmsObservations(repo: string, keys: readonly KmsKeyDescription[]): RawObservation[] {
  return classifyKmsKeys(repo, keys).flatMap((outcome) => (outcome.kind === "observed" ? [outcome.observation] : []));
}
