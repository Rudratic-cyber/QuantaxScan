import { z } from "zod/v4";
import { isValidCpe23FormattedString, type Cpe23FormattedString } from "./cpe";

/**
 * Validated, discriminated `locationDetail` profiles.
 *
 * `assets.location` (and `RawObservation.location`) stays the stable, opaque
 * locator (path, host:port, cert serial, key ARN) used in the fingerprint.
 * `locationDetail` carries surface-specific structured context that can
 * legitimately change between observations of the same asset — it is not
 * part of identity.
 *
 * The `network` profile is SP 1800-38B §4.1.4.1 Table 6's seven data
 * elements [verified; SP 1800-38B §§4.1.4–4.1.4.1, pp. 25–27 (preliminary
 * draft, December 2023) —
 * https://www.nccoe.nist.gov/sites/default/files/2023-12/pqc-migration-nist-sp-1800-38b-preliminary-draft.pdf].
 * `binary` is the qx-sp1800-38b investigation's binary-evidence profile —
 * defined so the contract accommodates a future binary collector; no binary
 * collector is implemented by this change.
 *
 * `certificate` is B4's profile for a *submitted* PEM/DER artifact — see the
 * discriminator's own comment in `enums.ts` for why it is not `network`.
 */

function cpe23Schema(expectedPart: "a" | "o" | "h") {
  return z
    .string()
    .refine((v): v is Cpe23FormattedString => isValidCpe23FormattedString(v, expectedPart), {
      message: `Must be a well-formed CPE 2.3 formatted string with part="${expectedPart}"`,
    });
}

export const NetworkLocationDetailSchema = z.object({
  /** Multiple because a certificate can list several addresses and a host observation can be multihomed. */
  ipAddresses: z.array(z.string()).optional(),
  destinationPort: z.number().int().min(0).max(65535).optional(),
  hostname: z.string().optional(),
  applicationLayerProtocol: z
    .object({
      kind: z.enum(["iana-service-name", "tls-alpn", "other"]),
      value: z.string(),
    })
    .optional(),
  /** part=a. Absent unless an explicit, versioned, curated mapping identifies the actual installed product. */
  applicationSoftwareCpe: cpe23Schema("a").optional(),
  /** part=o. */
  operatingSystemCpe: cpe23Schema("o").optional(),
  /**
   * part=h. NIST's Table 6 label is "Device Vendor", but CPE identifies
   * product classes, not a bare vendor/OUI — accept a CPE only when a
   * hardware product class is actually identified.
   */
  deviceVendorCpe: cpe23Schema("h").optional(),
  /** Non-CPE identifier (e.g. an OUI like "D0-43-1E") when only the vendor, not a product class, is known. Do not convert this into a fictitious CPE. */
  deviceVendorOui: z.string().optional(),
});
export type NetworkLocationDetail = z.infer<typeof NetworkLocationDetailSchema>;

export const SourceLocationDetailSchema = z.object({
  repo: z.string().optional(),
  path: z.string(),
  language: z.string().optional(),
  /** The matched keyword/symbol on the line (e.g. "RSA"), not a line number — see the fingerprint anti-requirement. */
  symbol: z.string().optional(),
  /** Package/import identity in source (e.g. a purl), when the collector can determine one. Not a CPE — see cpe.ts. */
  purl: z.string().optional(),
});
export type SourceLocationDetail = z.infer<typeof SourceLocationDetailSchema>;

export const DependencyLocationDetailSchema = z.object({
  ecosystem: z.string(),
  package: z.string(),
  version: z.string().optional(),
  purl: z.string().optional(),
});
export type DependencyLocationDetail = z.infer<typeof DependencyLocationDetailSchema>;

export const BinaryLocationDetailSchema = z.object({
  /** Canonical path within target/image/firmware package. */
  artifactPath: z.string(),
  binaryFormat: z.enum(["elf", "pe", "macho", "jar", "unknown"]),
  architecture: z.string().optional(),
  /** Package manager identity, if known — do not call it a CPE. */
  packageIdentity: z.string().optional(),
  /** Stable logical artifact name. */
  componentName: z.string().optional(),
  /** Import/symbol/signature rule ID used in the binary fingerprint. */
  evidenceDiscriminator: z.string(),
});
export type BinaryLocationDetail = z.infer<typeof BinaryLocationDetailSchema>;

/**
 * B4 — facts read directly off a parsed X.509 certificate. `notBefore` /
 * `notAfter` are ISO 8601 strings (not `Date`): this is JSON that round-trips
 * through `jsonb`, and a `Date` would silently become a string on the way
 * back out anyway. `issuer` and `subject` are the RDN sequence Node's
 * `X509Certificate` already renders as a single string (newline-joined
 * components) — kept verbatim rather than parsed into fields, since nothing
 * here needs to query on an individual RDN attribute.
 */
export const CertificateLocationDetailSchema = z.object({
  issuer: z.string(),
  serialNumber: z.string(),
  notBefore: z.string(),
  notAfter: z.string(),
  subject: z.string().optional(),
  /** e.g. "sha256WithRSAEncryption" — Node's own rendering, not canonicalised against `algorithms.json`. */
  signatureAlgorithm: z.string().optional(),
  /** Content-derived, not identity — two observations of the same certificate always agree, so this is display-only. */
  fingerprintSha256: z.string().optional(),
});
export type CertificateLocationDetail = z.infer<typeof CertificateLocationDetailSchema>;

/**
 * B6 — what a protocol-configuration file *declares*. Every field is read
 * straight off the file, never inferred: `directive` and `declaredValue` are
 * the keyword and the token verbatim, so a reader can go back to the line and
 * check.
 *
 * `strength` is carried here and not only folded into the observation's
 * numeric confidence because the two claims it separates ("this endpoint would
 * accept X" vs "this specific key is X") are different in kind, and a consumer
 * that shows a number without that distinction is showing a weaker fact than
 * the data supports — or a stronger one. `condition` is the enclosing
 * `Match`/`Host` block, present only when the directive applies conditionally.
 */
export const ConfigLocationDetailSchema = z.object({
  path: z.string(),
  /** `ProtocolConfigFormat` — kept as a plain string here so the schema does not have to be regenerated when a format is added. */
  format: z.string(),
  directive: z.string(),
  /** The token as the file wrote it, e.g. `ecdsa-sha2-nistp384`, `RS256`, `http://www.w3.org/2001/04/xmldsig-more#rsa-sha256`. */
  declaredValue: z.string(),
  strength: z.enum(["materialised", "permitted"]),
  condition: z.string().optional(),
});
export type ConfigLocationDetail = z.infer<typeof ConfigLocationDetailSchema>;

/**
 * B5 — what a managed key store reports *about* a key, as opposed to the key
 * itself. Its own kind rather than `network` or `certificate` for the same
 * reason `certificate` is not `network`: none of SP 1800-38B's seven network
 * elements apply (a KMS key has no IP, port or hostname — it is reached
 * through the provider's control plane), and none of the certificate fields
 * do either.
 *
 * Every field beyond `provider`/`keyId` is optional because every field
 * beyond those is optional *in the exports this collector reads*. AWS
 * `list-keys` returns a bare `KeyId`/`KeyArn`; Azure's list operation returns
 * `kid` and `attributes` and no key type at all. An absent field means the
 * export did not state it, which is why `rotationEnabled` is `boolean |
 * undefined` and never defaults to `false` — "the provider does not rotate
 * this key" and "the export did not say" are different claims, and only one
 * of them is ours to make.
 */
export const KmsLocationDetailSchema = z.object({
  /** One of `KMS_PROVIDER_VALUES` — kept as a plain string here so this schema does not import the collector's vocabulary. */
  provider: z.string(),
  /** ARN, resource name, `kid` URL or mount-qualified key name — whatever the provider calls a key's identity. Part of the fingerprint. */
  keyId: z.string(),
  /** The provider-native spec string as submitted (`RSA_4096`, `aes256-gcm96`, `RSA-HSM`, …). Absent when the export carried none. */
  keySpec: z.string().optional(),
  /** Curve name where the provider states it separately from the spec (Azure `crv`). Resolved through `named-curves.ts`, never a second bit-size table. */
  curve: z.string().optional(),
  /** Human-facing alias/name, when the export has one. Display only — never identity, since an alias can be repointed at a different key. */
  alias: z.string().optional(),
  /** The provider's own lifecycle word (`Enabled`, `PendingDeletion`, `DESTROYED`, …), verbatim. Deliberately not mapped onto `assets.status`: a KMS key scheduled for deletion has not been remediated. */
  keyState: z.string().optional(),
  /** Whether the provider reports automatic rotation as on. Absent = the export did not say. Never defaulted. */
  rotationEnabled: z.boolean().optional(),
  rotationPeriodDays: z.number().int().positive().optional(),
  /** ISO 8601, for the same round-trips-through-jsonb reason `CertificateLocationDetailSchema` uses strings. */
  lastRotatedAt: z.string().optional(),
  /** Where the key material lives, in the provider's terms (`AWS_KMS`, `EXTERNAL`, `AWS_CLOUDHSM`, …). */
  origin: z.string().optional(),
  region: z.string().optional(),
  /** The containing vault / key ring / mount path. Not part of identity — `keyId` already carries it for every provider that qualifies its ids. */
  keyStore: z.string().optional(),
});
export type KmsLocationDetail = z.infer<typeof KmsLocationDetailSchema>;

/**
 * B7 — the vocabulary and profile for a *described* encrypted store. Defined
 * here rather than in `data-at-rest-collector.ts` so the const tuples and the
 * zod schema that validates them are one definition with one direction of
 * dependency (the collector imports these; nothing here imports the collector).
 */

/**
 * Which half of a store's key hierarchy an observation describes. Part of the
 * asset identity — see `fingerprint.ts`'s `data-at-rest` variant for why a
 * store's bulk cipher and its key-wrapping algorithm must not be able to
 * collide into one asset when they happen to be the same algorithm.
 */
export const DATA_AT_REST_ROLE_VALUES = ["data-encryption", "key-protection"] as const;
export type DataAtRestRole = (typeof DATA_AT_REST_ROLE_VALUES)[number];

/**
 * What kind of thing the store is. Presentation and grouping only, and
 * deliberately *not* part of the asset identity: a caller reclassifying a
 * "volume" as an "archive" has corrected a label, not created a second store.
 */
export const DATA_AT_REST_STORE_KIND_VALUES = [
  "database",
  "backup",
  "archive",
  "volume",
  "object-store",
  "other",
] as const;
export type DataAtRestStoreKind = (typeof DATA_AT_REST_STORE_KIND_VALUES)[number];

/**
 * Whether the store is encrypted at all, as *stated by the caller*.
 *
 * `unknown` is a first-class value, not a synonym for `not-encrypted`: one
 * means "nobody has checked", the other means "we checked and there is none".
 * Only the second is a statement the collector may reconcile against — see the
 * reobservation rule in `observationsFromDataAtRestStore`.
 */
export const DATA_AT_REST_ENCRYPTION_STATE_VALUES = ["encrypted", "not-encrypted", "unknown"] as const;
export type DataAtRestEncryptionState = (typeof DATA_AT_REST_ENCRYPTION_STATE_VALUES)[number];

/**
 * How the caller came by what they submitted. Drives both the discovery
 * modality and the confidence, and NIST SP 1800-38B's two relevant modalities
 * (`configuration_information`, `manual_attestation`) exist for exactly this
 * distinction — see `DISCOVERY_MODALITY_VALUES` in `enums.ts`.
 */
export const DATA_AT_REST_EVIDENCE_SOURCE_VALUES = ["configuration-report", "attestation"] as const;
export type DataAtRestEvidenceSource = (typeof DATA_AT_REST_EVIDENCE_SOURCE_VALUES)[number];

export const DataAtRestLocationDetailSchema = z.object({
  engine: z.string(),
  storeId: z.string(),
  storeKind: z.enum(DATA_AT_REST_STORE_KIND_VALUES),
  role: z.enum(DATA_AT_REST_ROLE_VALUES),
  encryptionState: z.enum(DATA_AT_REST_ENCRYPTION_STATE_VALUES),
  /**
   * The caller's own string, kept verbatim alongside the canonical
   * `assets.algorithm` derived from it. Without this a report can say "AES" but
   * never "you told us AES-256-XTS", and there is no way to audit the
   * canonicalisation after the fact.
   */
  reportedAlgorithm: z.string(),
  /** Free text: `"aws-kms"`, `"pkcs11-hsm"`, `"software-keystore"`. Display and evidence only — never parsed into a verdict. */
  keySource: z.string().optional(),
  description: z.string().optional(),
  evidenceSource: z.enum(DATA_AT_REST_EVIDENCE_SOURCE_VALUES),
});
export type DataAtRestLocationDetail = z.infer<typeof DataAtRestLocationDetailSchema>;

/**
 * B8 — a manually registered OT/embedded device fleet. The register is a form,
 * not a scanner, so there is no path, host, artefact or control plane to
 * describe: the locator is the register row itself, and what matters alongside
 * it is the fleet's identity as the customer wrote it down.
 *
 * `deviceCount` is carried because one row can stand for thousands of devices,
 * and a reader of the inventory needs to know that this asset is not one box.
 * It is display context, never identity — recounting a fleet must not mint a
 * new asset.
 */
export const OtLocationDetailSchema = z.object({
  /** The `ot_fleets` row id, as a string. Stable for the life of the register entry, and the fingerprint's identity. */
  fleetId: z.string(),
  /** What the customer calls this fleet. Renaming it must not orphan the asset, so this is not in the fingerprint. */
  name: z.string(),
  vendor: z.string().optional(),
  model: z.string().optional(),
  site: z.string().optional(),
  /** Null in the register means nobody has counted; absent here means the same. Never defaulted to 1. */
  deviceCount: z.number().int().nonnegative().optional(),
  /** The customer's free-text description, kept verbatim beside the structured algorithm it was recorded with. */
  cryptoInUse: z.string().optional(),
});
export type OtLocationDetail = z.infer<typeof OtLocationDetailSchema>;

/**
 * B11 — a *conversation* between two endpoints, and what the customer's own
 * flow/session record said protected it.
 *
 * **The two endpoint profiles are `NetworkLocationDetailSchema` itself, reused
 * verbatim.** SP 1800-38B §4.1.4.1 Table 6's seven data elements describe where
 * on the wire something was observed, and a conversation has two such places —
 * so this kind embeds the existing profile twice rather than inventing a second
 * network schema with the same fields under different names. What it adds is
 * only what Table 6 has no concept of: which end is which, the transport, which
 * part of the session's cryptography this observation is, and the record the
 * evidence came from.
 *
 * It is its own kind rather than a variant of `network` for the same reason
 * `certificate` is: `fingerprintForObservation()` reads the discriminator to
 * decide a surface, and `network` is already shared between `tls` and a future
 * live-fetch certificate collector. A conversation's identity (destination
 * endpoint + port + role) is not shaped like `tls`'s (`host + port`), and
 * resolving `kind === "network"` to two different surfaces by inspecting its
 * fields is exactly the ambiguity that comment warns against.
 */

/**
 * Which kind of record a submission came from. Presentation, evidence and
 * caveat only — deliberately **not** part of any identity, since the same
 * conversation legitimately appears in both a VPC flow log and a load-balancer
 * access log and must not become two assets.
 */
export const NETWORK_FLOW_RECORD_FORMAT_VALUES = [
  "vpc-flow-log",
  "load-balancer-access-log",
  "service-mesh-telemetry",
  "firewall-session-log",
  "other",
] as const;
export type NetworkFlowRecordFormat = (typeof NETWORK_FLOW_RECORD_FORMAT_VALUES)[number];

/**
 * Transport protocol, part of the conversation's identity: the same host pair
 * on the same port number over TCP and over UDP are two different conversations
 * (443/tcp is HTTPS, 443/udp is QUIC, protected by different machinery).
 */
export const NETWORK_FLOW_TRANSPORT_VALUES = ["tcp", "udp", "other"] as const;
export type NetworkFlowTransport = (typeof NETWORK_FLOW_TRANSPORT_VALUES)[number];

/**
 * Whether this product knows what protected the conversation.
 *
 * `undetermined` is a first-class value and never a synonym for "unencrypted".
 * One means the evidence did not say; the other would be a claim, and no flow
 * record this collector reads is capable of making it. There is deliberately no
 * `not-encrypted` value: a flow log that omits a cipher field omits it for every
 * row, encrypted or not.
 */
export const NETWORK_FLOW_CRYPTO_STATE_VALUES = ["observed", "undetermined"] as const;
export type NetworkFlowCryptoState = (typeof NETWORK_FLOW_CRYPTO_STATE_VALUES)[number];

export const NetworkFlowLocationDetailSchema = z.object({
  /** SP 1800-38B Table 6's elements for the far end — the service being dialled. Carries `destinationPort`. */
  destination: NetworkLocationDetailSchema,
  /**
   * The same elements for the near end. `destinationPort` is deliberately never
   * set here: Table 6 defines no source-port element, and the source port is
   * the one field on a flow record that changes on every connection — see
   * `network-flow-collector.ts`'s identity section.
   */
  source: NetworkLocationDetailSchema,
  /**
   * The string each end's identity resolved to — workload name, else hostname,
   * else address (`endpointIdentity()`). Carried explicitly rather than
   * re-derived from the two profiles above, for two reasons: Table 6 has no
   * element for a service/workload name, so a mesh peer's real identity has
   * nowhere else to live; and this is the exact value the asset fingerprint was
   * computed from, so storing it makes the identity auditable instead of
   * reconstructible.
   */
  destinationIdentity: z.string(),
  sourceIdentity: z.string(),
  transport: z.enum(NETWORK_FLOW_TRANSPORT_VALUES),
  /** `CipherSuiteRole` — kept as a plain string so this schema does not have to change when a role is added. */
  role: z.string(),
  cryptoState: z.enum(NETWORK_FLOW_CRYPTO_STATE_VALUES),
  recordFormat: z.enum(NETWORK_FLOW_RECORD_FORMAT_VALUES),
  /** The suite name verbatim, beside the canonical algorithm derived from it — so the decomposition can be audited after the fact. */
  reportedCipherSuite: z.string(),
  /** e.g. `"TLSv1.2"`. Absent when the record named a cipher but no version. A version alone is never an observation — it is not an algorithm. */
  reportedTlsVersion: z.string().optional(),
  /** The single token in the suite name this observation was read from (`ECDHE`, `RSA`, `AES`). Evidence for the whole-token parse. */
  reportedComponentToken: z.string(),
});
export type NetworkFlowLocationDetail = z.infer<typeof NetworkFlowLocationDetailSchema>;

/**
 * EP — one crypto fact read off a Windows or Linux host, plus enough of the
 * host around it that a reader knows whose fact it is.
 *
 * Its own kind rather than `config` or `network`, for the reason `kms` is not
 * `certificate`: none of SP 1800-38B's seven wire-observation elements apply (a
 * host's certificate store has no IP or port), and `config`'s schema has
 * nowhere to put a machine identity, an OS build, or the loaded providers —
 * which are the fields that make an endpoint finding actionable rather than
 * merely true. `config` describes a file; this describes a machine.
 *
 * **The host block is repeated on every observation on purpose.** There is no
 * `endpoint_hosts` table (see `endpoint-collector.ts`'s header for why that was
 * left out of this change), so `GET /projects/:id/endpoint` reconstructs the
 * fleet from the assets. Duplicating `hostname`/`os`/`providers` across a
 * host's assets is the cost of that; the alternative — a host inventory that
 * exists only in a response nobody kept — is worse.
 *
 * Nothing here is part of the asset identity except `machineId`, `component`
 * and `observedToken`. `hostname`, `os` and `providers` all legitimately change
 * on the same machine, which is the definition of context rather than identity.
 */
export const EndpointLocationDetailSchema = z.object({
  /** The OS-install identity (`MachineGuid` / `/etc/machine-id`). Part of the fingerprint — see `endpoint-report.ts`'s `resolveHostIdentity`. */
  machineId: z.string(),
  machineIdSource: z.string().optional(),
  /** Display only. A rename must not orphan the host's assets, so this is deliberately not identity. */
  hostname: z.string().optional(),
  os: z
    .object({
      family: z.string(),
      name: z.string().optional(),
      version: z.string().optional(),
      build: z.string().optional(),
    })
    .optional(),
  /** The slot on the host this fact was read from — `certificate-store:LocalMachine\\My`, `tls-cipher-suites`. Part of both the location and the fingerprint. */
  component: z.string(),
  /** The suite name or certificate thumbprint verbatim, as the host wrote it. Part of the fingerprint. */
  observedToken: z.string(),
  /** B6's vocabulary, reused rather than duplicated: `permitted` is a menu, `materialised` is a key that exists on this box. */
  strength: z.enum(["materialised", "permitted"]),
  /** Present when the component is a certificate store. */
  certificate: z
    .object({
      store: z.string(),
      thumbprint: z.string(),
      /** The store's own string, kept beside the canonical algorithm derived from it so the canonicalisation is auditable. */
      reportedAlgorithm: z.string(),
      subject: z.string().optional(),
      issuer: z.string().optional(),
      serialNumber: z.string().optional(),
      notBefore: z.string().optional(),
      notAfter: z.string().optional(),
      /** Absent = the agent did not report it. Not the same claim as `false`. */
      hasPrivateKey: z.boolean().optional(),
    })
    .optional(),
  /**
   * The host's protocol posture, carried as context because no protocol version
   * resolves in `algorithms.json` and inventing an entry for one would put the
   * algorithm vocabulary in two places. `undetermined` is its own list: a
   * Schannel `Enabled` value that does not exist means the build default
   * applies, which this product does not claim to know.
   */
  tlsPolicy: z
    .object({
      provider: z.string(),
      enabledProtocols: z.array(z.string()),
      disabledProtocols: z.array(z.string()),
      undeterminedProtocols: z.array(z.string()),
    })
    .optional(),
  /** Loaded cryptographic providers. Context only — a capability is not a key; see `EndpointProviderReport`. */
  providers: z
    .array(z.object({ name: z.string(), kind: z.string().optional(), loaded: z.boolean().optional(), version: z.string().optional() }))
    .optional(),
  /** ISO 8601, when the agent read the host. Evidence only. */
  collectedAt: z.string().optional(),
});
export type EndpointLocationDetail = z.infer<typeof EndpointLocationDetailSchema>;

export const LocationDetailSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source"), source: SourceLocationDetailSchema }),
  z.object({ kind: z.literal("network"), network: NetworkLocationDetailSchema }),
  z.object({ kind: z.literal("dependency"), dependency: DependencyLocationDetailSchema }),
  z.object({ kind: z.literal("binary"), binary: BinaryLocationDetailSchema }),
  z.object({ kind: z.literal("certificate"), certificate: CertificateLocationDetailSchema }),
  z.object({ kind: z.literal("ot"), ot: OtLocationDetailSchema }),
  z.object({ kind: z.literal("config"), config: ConfigLocationDetailSchema }),
  z.object({ kind: z.literal("kms"), kms: KmsLocationDetailSchema }),
  z.object({ kind: z.literal("data-at-rest"), dataAtRest: DataAtRestLocationDetailSchema }),
  z.object({ kind: z.literal("network-flow"), networkFlow: NetworkFlowLocationDetailSchema }),
  z.object({ kind: z.literal("endpoint"), endpoint: EndpointLocationDetailSchema }),
]);
export type LocationDetail = z.infer<typeof LocationDetailSchema>;
