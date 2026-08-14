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

export const LocationDetailSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source"), source: SourceLocationDetailSchema }),
  z.object({ kind: z.literal("network"), network: NetworkLocationDetailSchema }),
  z.object({ kind: z.literal("dependency"), dependency: DependencyLocationDetailSchema }),
  z.object({ kind: z.literal("binary"), binary: BinaryLocationDetailSchema }),
  z.object({ kind: z.literal("certificate"), certificate: CertificateLocationDetailSchema }),
]);
export type LocationDetail = z.infer<typeof LocationDetailSchema>;
