import { algorithmProfileFor } from "./algorithm-profiles";
import {
  CBOM_SPEC_VERSION,
  type BuildCbomOptions,
  type CbomInput,
  type CryptoAssetInput,
  type CycloneDxBom,
  type CycloneDxComponent,
  type CycloneDxCryptoProperties,
  type CycloneDxDependency,
  type CycloneDxProperty,
  type SoftwareComponentInput,
} from "./types";

/**
 * A5 — CycloneDX 1.7 CBOM export.
 *
 * Pure: same input, same options, same bytes. The two sources of nondeterminism
 * a BOM normally has (serial number, timestamp) are parameters, and components
 * and dependencies are sorted by `bom-ref`, so two exports of an unchanged
 * inventory diff cleanly. That matters more than it sounds: drift detection
 * (D4) and "hand the auditor last quarter's CBOM and this quarter's" both
 * depend on it.
 */

/** Property namespace. CycloneDX asks for `<namespace>:<name>`; ours is the product. */
const NS = "quantaxscan";

/** Key size, as a string of digits, or the literal below. See `keySizeProperty`. */
export const PROP_KEY_SIZE = `${NS}:asset:keySize`;
/** The value `PROP_KEY_SIZE` carries when the inventory holds `keySize: null`. */
export const KEY_SIZE_UNDETERMINED = "undetermined";

const PROP_SURFACE = `${NS}:asset:surface`;
const PROP_STATUS = `${NS}:asset:status`;
const PROP_FINGERPRINT = `${NS}:asset:fingerprint`;
const PROP_FIRST_SEEN = `${NS}:asset:firstSeen`;
const PROP_LAST_SEEN = `${NS}:asset:lastSeen`;

/**
 * Asset surface → CycloneDX `cryptoProperties.assetType`.
 *
 * Only `source` has a collector today (B1); the rest are mapped now because
 * the point of doing CBOM second is to find out whether the asset model fits
 * the standard *before* five more collectors are written against it. It does,
 * with one honest approximation: `config` covers protocol configuration
 * (SSH, IPsec, JWT `alg`), so it maps to `protocol`.
 */
export const SURFACE_ASSET_TYPE: Readonly<Record<string, CycloneDxCryptoProperties["assetType"]>> = {
  source: "algorithm",
  dependency: "algorithm",
  binary: "algorithm",
  ot: "algorithm",
  tls: "protocol",
  config: "protocol",
  certificate: "certificate",
  kms: "related-crypto-material",
};

/** Unmapped surfaces export as algorithms rather than being dropped. */
function assetTypeFor(surface: string): CycloneDxCryptoProperties["assetType"] {
  return SURFACE_ASSET_TYPE[surface] ?? "algorithm";
}

/**
 * `keySize: null` is a fact the inventory deliberately carries — the collector
 * looked and could not determine the size (docs/Claude/09-open-gaps.md G-05).
 * Two rules follow, and neither is negotiable:
 *
 *  1. **No numeric field is emitted.** `parameterSetIdentifier` and
 *     `relatedCryptoMaterialProperties.size` are simply absent. A default here
 *     would be laundered into a security strength by A4 and then into a
 *     transition deadline in a customer-facing report.
 *  2. **The absence is stated, not implied.** A consumer cannot tell "this
 *     exporter never considered key size" from "we looked and do not know"
 *     by looking at a missing optional field, so every crypto component
 *     carries `quantaxscan:asset:keySize`, valued either with the digits or
 *     with `undetermined`.
 */
function keySizeProperty(keySize: number | null): CycloneDxProperty {
  return { name: PROP_KEY_SIZE, value: keySize == null ? KEY_SIZE_UNDETERMINED : String(keySize) };
}

/** Name the variant only as precisely as the inventory knows it: `RSA-2048`, or bare `RSA`. */
function componentName(asset: CryptoAssetInput): string {
  return asset.keySize == null ? asset.algorithm : `${asset.algorithm}-${asset.keySize}`;
}

function toIsoString(value: Date | string | null | undefined): string | undefined {
  if (value == null) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function cryptoPropertiesFor(asset: CryptoAssetInput): CycloneDxCryptoProperties {
  const assetType = assetTypeFor(asset.surface);
  const { family, primitive, mode } = algorithmProfileFor(asset.algorithm);

  switch (assetType) {
    case "algorithm":
      return {
        assetType,
        algorithmProperties: {
          ...(primitive ? { primitive } : {}),
          ...(family ? { algorithmFamily: family } : {}),
          ...(mode ? { mode } : {}),
          // The one place a determined key size becomes a schema field. Never
          // written when null — see keySizeProperty's note 1.
          ...(asset.keySize == null ? {} : { parameterSetIdentifier: String(asset.keySize) }),
        },
      };
    case "related-crypto-material":
      return {
        assetType,
        relatedCryptoMaterialProperties: {
          // `key` rather than a more specific member: the inventory records
          // that a key exists at a KMS location, not whether it is the private
          // half of a pair.
          //
          // `algorithmRef` (a link to a separate algorithm component) is the
          // richer modelling and is deliberately not emitted: it would require
          // minting an algorithm component the inventory has no observation
          // for. Revisit with B4/B5, which will actually observe both halves.
          type: "key",
          id: asset.location,
          ...(asset.keySize == null ? {} : { size: asset.keySize }),
        },
      };
    case "certificate":
      // Key size on a certificate belongs to its subject public key, which is
      // a separate related-crypto-material asset B4 will produce. Until then
      // it stays in the property above and out of certificateProperties,
      // which has no size field to misuse anyway.
      return { assetType, certificateProperties: { serialNumber: asset.location } };
    case "protocol":
      return { assetType, protocolProperties: {} };
  }
}

function cryptoComponent(asset: CryptoAssetInput): CycloneDxComponent {
  const firstSeen = toIsoString(asset.firstSeen);
  const lastSeen = toIsoString(asset.lastSeen);

  return {
    type: "cryptographic-asset",
    "bom-ref": cryptoBomRef(asset.fingerprint),
    name: componentName(asset),
    cryptoProperties: cryptoPropertiesFor(asset),
    // `location` is the collector's stable locator, which is precisely what an
    // occurrence is for. Line numbers deliberately are not part of asset
    // identity (see @workspace/collectors fingerprint.ts) and so are not here.
    evidence: { occurrences: [{ location: asset.location }] },
    properties: [
      keySizeProperty(asset.keySize),
      { name: PROP_SURFACE, value: asset.surface },
      { name: PROP_STATUS, value: asset.status },
      { name: PROP_FINGERPRINT, value: asset.fingerprint },
      ...(firstSeen ? [{ name: PROP_FIRST_SEEN, value: firstSeen }] : []),
      ...(lastSeen ? [{ name: PROP_LAST_SEEN, value: lastSeen }] : []),
    ],
  };
}

/** Stable, collision-free, and not a `urn:cdx:` BOM-Link. */
export function cryptoBomRef(fingerprint: string): string {
  return `crypto:${fingerprint}`;
}

function softwareComponent(input: SoftwareComponentInput): CycloneDxComponent {
  return {
    type: input.type ?? "application",
    "bom-ref": input.bomRef,
    name: input.name,
    ...(input.version ? { version: input.version } : {}),
  };
}

function byBomRef(a: { "bom-ref": string }, b: { "bom-ref": string }): number {
  return a["bom-ref"] < b["bom-ref"] ? -1 : a["bom-ref"] > b["bom-ref"] ? 1 : 0;
}

export function buildCbom(input: CbomInput, options: BuildCbomOptions = {}): CycloneDxBom {
  const timestamp = options.timestamp ?? new Date();

  const softwareRefs = new Set(input.softwareComponents.map((c) => c.bomRef));
  const components = [
    ...input.softwareComponents.map(softwareComponent),
    ...input.cryptoAssets.map(cryptoComponent),
  ].sort(byBomRef);

  // The relationship half of "algorithms, keys and certificates *and their
  // relationships to software components*". A software component `dependsOn`
  // the crypto assets found inside it. `provides` is deliberately not used:
  // it means "implements this specification", which is true of a crypto
  // library, not of an application that merely calls RSA.
  //
  // An asset whose `containedIn` names a component absent from this export
  // gets no edge rather than a dangling ref — a `dependsOn` pointing at a
  // missing `bom-ref` still passes JSON-Schema validation (refLinkType is
  // just a string) and would corrupt any consumer walking the graph.
  const dependsOn = new Map<string, string[]>(input.softwareComponents.map((c) => [c.bomRef, []]));
  for (const asset of input.cryptoAssets) {
    const parent = asset.containedIn;
    if (parent != null && softwareRefs.has(parent)) {
      dependsOn.get(parent)!.push(cryptoBomRef(asset.fingerprint));
    }
  }

  const dependencies: CycloneDxDependency[] = [
    ...[...dependsOn.entries()].map(([ref, refs]) => ({ ref, dependsOn: [...new Set(refs)].sort() })),
    // "Components that do not have their own dependencies must be declared as
    // empty elements within the graph" — a crypto asset is always a leaf.
    ...input.cryptoAssets.map((asset) => ({ ref: cryptoBomRef(asset.fingerprint), dependsOn: [] })),
  ].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

  return {
    bomFormat: "CycloneDX",
    specVersion: CBOM_SPEC_VERSION,
    ...(options.serialNumber ? { serialNumber: options.serialNumber } : {}),
    version: 1,
    metadata: {
      timestamp: timestamp.toISOString(),
      tools: {
        components: [
          {
            type: "application",
            "bom-ref": "tool:quantaxscan",
            name: "QuantaXscan",
            ...(options.toolVersion ? { version: options.toolVersion } : {}),
          },
        ],
      },
    },
    components,
    dependencies,
  };
}
