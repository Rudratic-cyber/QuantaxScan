import { curveBitSize } from "./named-curves";
import type { RawObservation } from "./types";
import type {
  DataAtRestEncryptionState,
  DataAtRestEvidenceSource,
  DataAtRestLocationDetail,
  DataAtRestRole,
  DataAtRestStoreKind,
} from "./location-detail";

/**
 * B7 — the data-at-rest collector's pure half (docs/Claude/03-features.md §B7:
 * "DB TDE, backup/archive encryption — the true HNDL targets").
 *
 * ## Why this surface is the harvest-now-decrypt-later case
 *
 * Every other surface this product examines describes crypto an adversary has
 * to be *present* for: a TLS session has to be recorded while it happens, a
 * certificate has to still be presented. Data at rest is the one case where the
 * ciphertext is a file — a backup tape, a replicated volume, an object-store
 * bucket, a stolen tablespace — that can be copied today, kept, and decrypted
 * whenever Q-Day arrives. That is why `secrecyLifetimeYears` (A3's X) and the
 * Mosca verdict (A4) matter more here than anywhere else, and why the ingest
 * route for this surface is the only one that accepts a per-store data
 * classification: the caller knows what is *in* the store, and X is a statement
 * about the data, not about the cryptography.
 *
 * ## Submission, not credentials
 *
 * The caller POSTs what their database/backup configuration already reports
 * (`pg_settings`, `sys.dm_database_encryption_keys`, `V$ENCRYPTED_TABLESPACES`,
 * a bucket's `ServerSideEncryptionConfiguration`, a backup product's job
 * definition). This collector does **no** database or network I/O — same reason
 * B3 split its socket work into `artifacts/api-server/src/lib/tls-probe.ts`:
 * `@workspace/collectors` stays dependency-free so it can ship as a standalone
 * on-prem agent. Connecting to a live database would additionally need a
 * read-only-credential handling design that does not exist yet (F4 is unbuilt),
 * and inventing one inside a collector lane is how a product ends up storing
 * production database passwords by accident.
 *
 * ## Two observations per store, not one
 *
 * A TDE'd store is two separate crypto facts, and only one of them is the
 * quantum problem:
 *
 *  1. **Data encryption** — the bulk cipher over the pages/blocks/objects,
 *     almost always AES. `algorithms.json` records AES as
 *     `quantumVulnerable: false` (Grover is a quadratic speedup, not Shor), so
 *     recording it is inventory, not alarm.
 *  2. **Key protection** — how the data-encryption key is wrapped: an RSA or EC
 *     key in an HSM/KMS, or another symmetric KEK. *This* is where Shor lands.
 *     A store whose AES-256 data key is wrapped with RSA-2048 is a
 *     harvest-now-decrypt-later target no matter how strong the bulk cipher is,
 *     and a collector that recorded only the cipher would report it as clean.
 *
 * Both are recorded at the same store, at different `location` slots, with the
 * role in the fingerprint — see `fingerprint.ts`'s `data-at-rest` variant for
 * why the role is part of identity (AES-wrapped-with-AES is an ordinary key
 * hierarchy, and without the role its two observations would collide into one
 * asset).
 *
 * ## The honesty case, which matters more here than anywhere
 *
 * "Encrypted: yes" with no algorithm named is a real and extremely common
 * answer — a DBA reads `encryption = on` off a config and has no cipher to
 * report. This collector emits **no observation** for that store and reports a
 * `cipher-not-reported` gap instead. It must never become AES-256: an invented
 * cipher is indistinguishable from a measured one once it is a row, and the
 * whole point of this surface is telling a CISO which of their long-lived
 * ciphertext they actually know something about.
 */

/**
 * The vocabulary this collector reads (`DATA_AT_REST_ROLE_VALUES`,
 * `..._STORE_KIND_VALUES`, `..._ENCRYPTION_STATE_VALUES`,
 * `..._EVIDENCE_SOURCE_VALUES`) lives in `location-detail.ts`, next to the zod
 * schema that validates it at the persistence boundary — one definition, one
 * direction of dependency.
 */

/**
 * Confidence (docs/Claude/09-open-gaps.md G-11).
 *
 * `configuration-report` — 0.6. The caller is relaying what the engine's own
 * configuration says. That is a real reading of a real setting, but it is a
 * reading of *configuration*, not of ciphertext: nothing here proves the store
 * was written with that cipher, that the setting is not stale, or that an older
 * unencrypted backup of the same data is not sitting somewhere else. It sits
 * below the certificate collector's 0.9 (which parses the artefact itself) and
 * well below a completed handshake's 1.0, and above the dependency collector's
 * 0.5 "this package can do several things" tier, because a TDE cipher setting
 * is unambiguous about which algorithm it names.
 *
 * `attestation` — 0.4. A human typed it. Below every mechanical tier, because
 * it is the only input in the system with no artefact behind it at all.
 *
 * **A default is forced here in a way it is not for `keySize`.** G-05 lets an
 * undetermined key size stay `null` because the column is nullable;
 * `observations.confidence` is a required number, so "not stated" has to become
 * *some* value. The default is therefore the weaker of the two
 * (`attestation`), which understates the evidence rather than overstating it —
 * the opposite direction from the guessed-default failure CLAUDE.md prohibits.
 */
export const DATA_AT_REST_CONFIDENCE: Record<DataAtRestEvidenceSource, number> = {
  "configuration-report": 0.6,
  attestation: 0.4,
};

export const DEFAULT_DATA_AT_REST_EVIDENCE_SOURCE: DataAtRestEvidenceSource = "attestation";

/** One reported cryptographic setting. Every field is optional because every field is genuinely often unreported. */
export interface DataAtRestCryptoInput {
  /** As the caller's tooling reports it, e.g. `"AES-256-CBC"`, `"aes256"`, `"RSA-2048"`, `"ECDH"`. Null/absent = not reported. */
  algorithm?: string | null;
  /** The stated parameter size, when the caller supplies one separately. Wins over anything parsed out of `algorithm`. */
  keySize?: number | null;
  /** Free text: `"aws-kms"`, `"pkcs11-hsm"`, `"software-keystore"`, `"passphrase"`. Display and evidence only — never parsed into a verdict. */
  source?: string | null;
}

/** One encrypted (or not) store, exactly as the caller described it. */
export interface DataAtRestStoreInput {
  /**
   * The caller's stable identifier for this store — an instance/database name,
   * a bucket ARN, a backup job name. Part of the asset identity, so it must be
   * the same string next submission or the asset is orphaned and recreated.
   */
  storeId: string;
  /** The engine or product, e.g. `"postgresql"`, `"mssql"`, `"oracle"`, `"s3"`, `"veeam"`. Part of identity. */
  engine: string;
  storeKind?: DataAtRestStoreKind;
  encryptionState?: DataAtRestEncryptionState;
  /** The bulk cipher protecting the stored data. */
  dataEncryption?: DataAtRestCryptoInput;
  /** How the data-encryption key is wrapped. The Shor-relevant half. */
  keyProtection?: DataAtRestCryptoInput;
  evidenceSource?: DataAtRestEvidenceSource;
  /** Free text for the report, e.g. "nightly full backups, 7-year retention". */
  description?: string;
}

/** Why a store produced fewer observations than it looks like it should have. Reported, never inferred away. */
export type DataAtRestGapReason =
  /** The caller did not say whether the store is encrypted. */
  | "encryption-state-unknown"
  /** The store is encrypted but no cipher was named. The case this collector exists to keep honest. */
  | "cipher-not-reported"
  /** No key-protection setting was submitted, so nothing is known about how the data key is wrapped. */
  | "key-protection-not-reported"
  /** Something was named, but it resolves to no entry in `algorithms.json`. Reported verbatim rather than mapped to a neighbour. */
  | "algorithm-not-recognised";

export interface DataAtRestGap {
  role: DataAtRestRole;
  reason: DataAtRestGapReason;
  /** The string the caller supplied, present only for `algorithm-not-recognised`. */
  reported?: string;
}

export interface DataAtRestStoreResult {
  storeId: string;
  engine: string;
  observations: RawObservation[];
  /**
   * The `location` slots this submission is entitled to declare `gone` if it
   * did not reobserve them — see the rule in `observationsFromDataAtRestStore`.
   */
  reobservedLocations: string[];
  gaps: DataAtRestGap[];
}

/** `<repo>:atrest:<engine>:<storeId>:<role>` — a stable *slot*, deliberately without the algorithm in it. See the note in `fingerprint.ts`. */
export function dataAtRestLocation(repo: string, engine: string, storeId: string, role: DataAtRestRole): string {
  return `${repo}:atrest:${engine}:${storeId}:${role}`;
}

/**
 * Canonical algorithm name for each family token a data-at-rest configuration
 * actually reports. Every value must resolve in `algorithms.json` — asserted in
 * `algorithm-mapping.test.ts`, the same guard the certificate collector's table
 * carries.
 *
 * Deliberately narrow. A token absent from here produces an
 * `algorithm-not-recognised` gap and no observation, which is how 3DES/TDEA,
 * Blowfish, ChaCha20 and every vendor-specific name behave today: they are
 * reported back to the caller as unmapped rather than bent onto the nearest
 * entry. Widening this table means adding the algorithm to `algorithms.json`
 * first, with a citation — which is the correct order.
 */
const CANONICAL_BY_FAMILY_TOKEN: Record<string, string> = {
  AES: "AES",
  RIJNDAEL: "AES",
  RSA: "RSA",
  DSA: "DSA",
  ECDSA: "ECDSA",
  // G-24: elliptic and finite-field DH are separate entries, because their
  // stated parameter is a curve order in one and a modulus in the other.
  ECDH: "ECDH",
  ECDHE: "ECDH",
  X25519: "ECDH",
  CURVE25519: "ECDH",
  DH: "DH",
  DHE: "DH",
  EDDSA: "EdDSA",
  ED25519: "EdDSA",
  ED448: "EdDSA",
};

/** The canonical algorithm names this collector can emit. Every one must resolve in `algorithms.json` — asserted in algorithm-mapping.test.ts, the same guard the certificate collector's table carries. `AES-ECB` is added because a reported ECB mode resolves to that entry rather than to `AES`. */
export const DATA_AT_REST_ALGORITHMS: readonly string[] = [
  ...new Set([...Object.values(CANONICAL_BY_FAMILY_TOKEN), "AES-ECB"]),
];

/**
 * Split a reported algorithm string into upper-case tokens, separating a
 * trailing size that is glued to its family (`aes256` → `AES`, `256`) so both
 * spellings a config file uses reach the same result.
 */
function tokenise(reported: string): string[] {
  return reported
    .toUpperCase()
    .replace(/[\s_/.]+/g, "-")
    .split("-")
    .filter((part) => part.length > 0)
    .flatMap((part) => {
      const glued = /^([A-Z]+)(\d+)$/.exec(part);
      // X25519/ED25519/CURVE25519 are family names that happen to end in
      // digits — they are looked up whole before this split can mangle them.
      if (glued && CANONICAL_BY_FAMILY_TOKEN[part] === undefined) return [glued[1], glued[2]];
      return [part];
    });
}

export interface CanonicalDataAtRestAlgorithm {
  algorithm: string;
  /** The size *stated* in the reported string, or `undefined`. Never inferred from the family — bare `"AES"` is `undefined`, not 256 (G-05). */
  keySize?: number;
}

/**
 * Resolve a caller-reported algorithm string to a canonical name and, when the
 * string states one, a key size.
 *
 * Returns `undefined` for anything this table does not know. That is the whole
 * contract: an unrecognised cipher becomes a reported gap, never a guess.
 */
export function canonicalDataAtRestAlgorithm(reported: string): CanonicalDataAtRestAlgorithm | undefined {
  const tokens = tokenise(reported);
  const familyIndex = tokens.findIndex((token) => CANONICAL_BY_FAMILY_TOKEN[token] !== undefined);
  if (familyIndex === -1) return undefined;

  const family = tokens[familyIndex];
  let algorithm = CANONICAL_BY_FAMILY_TOKEN[family];

  // ECB is its own `algorithms.json` entry (a classical-hygiene finding, not a
  // quantum one — G-10), so a mode of operation is the one modifier that
  // changes which entry applies. Every other mode (CBC, GCM, XTS, CTR) is
  // recorded in `evidence` and changes nothing about the algorithm.
  if (algorithm === "AES" && tokens.includes("ECB")) algorithm = "AES-ECB";

  // The size is looked for *after* the family token so `TLS-AES-256-GCM-SHA384`
  // yields 256 rather than 384, and a leading product version number cannot be
  // mistaken for a key size.
  const sizeToken = tokens.slice(familyIndex + 1).find((token) => /^\d+$/.test(token));
  const curveSize = tokens.slice(familyIndex).reduce<number | undefined>(
    (found, token) => found ?? curveBitSize(token),
    undefined,
  );
  const keySize = sizeToken !== undefined ? Number(sizeToken) : curveSize;

  return keySize === undefined ? { algorithm } : { algorithm, keySize };
}

/**
 * Turn one described store into its observations, the slots this submission is
 * entitled to reconcile, and the gaps it left.
 *
 * ## The reobservation rule, which is the sharp edge here
 *
 * A slot goes into `reobservedLocations` **only when the submission made a
 * statement that would have produced an observation had the crypto still been
 * there.** Concretely:
 *
 *  - `not-encrypted` → the data-encryption slot *is* in scope. That is a
 *    positive statement of absence, and a previously recorded cipher at that
 *    slot correctly becomes `gone`.
 *  - `encrypted` with an algorithm that resolved → in scope. A store whose key
 *    protection moves off RSA leaves the RSA asset `gone` at the same slot and
 *    creates a new one, which is what a migration actually is. (A key-*size*
 *    change is not that: `keySize` is not part of the identity, so AES-128 to
 *    AES-256 is one asset re-measured — see `fingerprint.ts`.)
 *  - `encrypted` with **no cipher reported, or an unrecognised one** → **not**
 *    in scope. This is the case the collector's header comment calls real and
 *    common, and putting it in scope would mark the previously recorded cipher
 *    `gone` because a field was left blank — a silent false remediation, with no
 *    remediation anywhere near it. Read the `ReobservationScope` comment in
 *    `asset-ingest.ts`: a target that was not observed says nothing about
 *    itself.
 *  - `unknown` → nothing about this store is in scope at all.
 *
 * The same three-way split applies to the key-protection slot, with
 * `not-encrypted` implying no key protection either (there is no data key to
 * wrap).
 */
export function observationsFromDataAtRestStore(repo: string, store: DataAtRestStoreInput): DataAtRestStoreResult {
  const encryptionState: DataAtRestEncryptionState = store.encryptionState ?? "unknown";
  const evidenceSource = store.evidenceSource ?? DEFAULT_DATA_AT_REST_EVIDENCE_SOURCE;
  const confidence = DATA_AT_REST_CONFIDENCE[evidenceSource];
  const discoveryModality = evidenceSource === "configuration-report" ? "configuration_information" : "manual_attestation";
  const storeKind: DataAtRestStoreKind = store.storeKind ?? "other";

  const observations: RawObservation[] = [];
  const reobservedLocations: string[] = [];
  const gaps: DataAtRestGap[] = [];

  const record = (role: DataAtRestRole, input: DataAtRestCryptoInput | undefined): void => {
    const reported = input?.algorithm ?? null;
    if (reported === null || reported.trim().length === 0) {
      gaps.push({ role, reason: role === "data-encryption" ? "cipher-not-reported" : "key-protection-not-reported" });
      return;
    }

    const canonical = canonicalDataAtRestAlgorithm(reported);
    if (canonical === undefined) {
      gaps.push({ role, reason: "algorithm-not-recognised", reported });
      return;
    }

    const location = dataAtRestLocation(repo, store.engine, store.storeId, role);
    const locationDetail: DataAtRestLocationDetail = {
      engine: store.engine,
      storeId: store.storeId,
      storeKind,
      role,
      encryptionState,
      reportedAlgorithm: reported,
      keySource: input?.source ?? undefined,
      description: store.description,
      evidenceSource,
    };

    observations.push({
      algorithm: canonical.algorithm,
      // The caller's explicit size wins; otherwise the size *stated* in the
      // reported string. Undetermined stays undetermined (G-05).
      keySize: input?.keySize ?? canonical.keySize,
      location,
      locationDetail: { kind: "data-at-rest", dataAtRest: locationDetail },
      discoveryModality,
      confidence,
      evidence: {
        engine: store.engine,
        storeId: store.storeId,
        storeKind,
        role,
        encryptionState,
        reportedAlgorithm: reported,
        keySource: input?.source ?? null,
        evidenceSource,
        description: store.description ?? null,
        note:
          role === "key-protection"
            ? "How this store's data-encryption key is wrapped. This, not the bulk cipher, is where Shor applies."
            : "The bulk cipher over stored data. Reported as configuration, not verified against the ciphertext itself.",
      },
    });
    reobservedLocations.push(location);
  };

  if (encryptionState === "unknown") {
    gaps.push({ role: "data-encryption", reason: "encryption-state-unknown" });
    gaps.push({ role: "key-protection", reason: "encryption-state-unknown" });
    return { storeId: store.storeId, engine: store.engine, observations, reobservedLocations, gaps };
  }

  if (encryptionState === "not-encrypted") {
    // A positive statement of absence about both slots: there is no cipher and
    // therefore no data key to wrap. Both slots are in scope so a store that
    // has had its encryption turned off stops reading as encrypted.
    reobservedLocations.push(
      dataAtRestLocation(repo, store.engine, store.storeId, "data-encryption"),
      dataAtRestLocation(repo, store.engine, store.storeId, "key-protection"),
    );
    return { storeId: store.storeId, engine: store.engine, observations, reobservedLocations, gaps };
  }

  record("data-encryption", store.dataEncryption);
  record("key-protection", store.keyProtection);

  return { storeId: store.storeId, engine: store.engine, observations, reobservedLocations, gaps };
}

/** Every store in a submission, in submission order. */
export function collectDataAtRestObservations(repo: string, stores: DataAtRestStoreInput[]): DataAtRestStoreResult[] {
  return stores.map((store) => observationsFromDataAtRestStore(repo, store));
}
