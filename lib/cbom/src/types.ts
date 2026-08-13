/**
 * Input and output types for the CycloneDX 1.7 CBOM exporter (A5).
 *
 * The output types are a **subset** of the specification — only the parts this
 * exporter emits are modelled. They exist for authoring ergonomics and are not
 * the contract: `schema/bom-1.7.schema.json` is, and `build-cbom.test.ts`
 * validates against it. A type here that drifts from the schema is a bug the
 * test will catch; a type here that *narrows* the schema is fine.
 *
 * The input types are deliberately structural rather than imported from
 * `@workspace/db`. This package stays free of the database layer so the
 * exporter can be exercised on a plain object literal, and so a CBOM can later
 * be produced from an imported document (A6) that never touched our tables.
 * The route passes real `assets` rows straight in; TypeScript's structural
 * check at that call site is what keeps the two in step.
 */

/** The spec version this exporter emits. Not derivable from the schema — see schema/README.md. */
export const CBOM_SPEC_VERSION = "1.7" as const;

// ───────────────────────────── input ─────────────────────────────

/**
 * A software component that *contains* crypto — a project, a service, a
 * dependency. CBOM's value over a bare algorithm list is this relationship, so
 * a crypto asset with no `containedIn` is exported as a free-floating
 * component with no dependency edge rather than being attached to a guess.
 */
export interface SoftwareComponentInput {
  /** Stable within one export. The route uses `project:<id>`, matching `projectRepoId()`. */
  bomRef: string;
  name: string;
  version?: string | null;
  /** Defaults to `application`. Must be a CycloneDX component type. */
  type?: SoftwareComponentType;
}

export type SoftwareComponentType = "application" | "library" | "framework" | "container" | "file";

/**
 * One row of the asset inventory. Field-for-field a structural subset of
 * `assetsTable.$inferSelect`, minus the columns a CBOM has nowhere to put.
 */
export interface CryptoAssetInput {
  /** Deterministic identity from `@workspace/collectors`; becomes the `bom-ref`. */
  fingerprint: string;
  /** `@workspace/collectors` `Surface`. Chooses the CycloneDX `assetType` — see SURFACE_ASSET_TYPE. */
  surface: string;
  /** Detector's algorithm label, e.g. `RSA`, `AES-ECB`, `ECDH/DH`. */
  algorithm: string;
  /**
   * Parameter size in bits, or `null` when the collector could not determine
   * it. **Never defaulted** — see docs/Claude/09-open-gaps.md G-05 for the
   * rule and docs/Claude/03-features.md §A5 for what this exporter does with
   * it.
   */
  keySize: number | null;
  /** Stable locator: `<repo>:<path>`, `host:port`, a cert serial, a key ARN. */
  location: string;
  /** `@workspace/collectors` `AssetStatus`. */
  status: string;
  firstSeen?: Date | string | null;
  lastSeen?: Date | string | null;
  /** `bomRef` of the software component this was found in, if known. */
  containedIn?: string | null;
}

export interface CbomInput {
  softwareComponents: SoftwareComponentInput[];
  cryptoAssets: CryptoAssetInput[];
}

export interface BuildCbomOptions {
  /**
   * `urn:uuid:…`. Injected rather than generated so a caller can make the
   * output byte-stable; the route generates a fresh one per export, which is
   * what the spec asks for.
   */
  serialNumber?: string;
  /** BOM creation time. Injected for the same reason. Defaults to `new Date()`. */
  timestamp?: Date;
  /** Version of QuantaXscan recorded in `metadata.tools`. */
  toolVersion?: string;
}

// ───────────────────────────── output ─────────────────────────────

export interface CycloneDxProperty {
  name: string;
  value?: string;
}

export interface CycloneDxOccurrence {
  location: string;
  line?: number;
  symbol?: string;
}

export interface CycloneDxAlgorithmProperties {
  primitive?: string;
  algorithmFamily?: string;
  /**
   * Key/parameter size as a string, e.g. `"2048"`. Only set when the
   * inventory actually determined it.
   */
  parameterSetIdentifier?: string;
  ellipticCurve?: string;
  mode?: string;
  padding?: string;
  cryptoFunctions?: string[];
}

export interface CycloneDxRelatedCryptoMaterialProperties {
  type?: string;
  id?: string;
  state?: string;
  /** Size **in bits**. Only set when determined. */
  size?: number;
}

export interface CycloneDxCertificateProperties {
  subjectName?: string;
  issuerName?: string;
  serialNumber?: string;
  notValidBefore?: string;
  notValidAfter?: string;
}

export interface CycloneDxProtocolProperties {
  type?: string;
  version?: string;
}

export interface CycloneDxCryptoProperties {
  assetType: "algorithm" | "certificate" | "protocol" | "related-crypto-material";
  algorithmProperties?: CycloneDxAlgorithmProperties;
  relatedCryptoMaterialProperties?: CycloneDxRelatedCryptoMaterialProperties;
  certificateProperties?: CycloneDxCertificateProperties;
  protocolProperties?: CycloneDxProtocolProperties;
  oid?: string;
}

export interface CycloneDxComponent {
  type: string;
  "bom-ref": string;
  name: string;
  version?: string;
  description?: string;
  cryptoProperties?: CycloneDxCryptoProperties;
  evidence?: { occurrences?: CycloneDxOccurrence[] };
  properties?: CycloneDxProperty[];
}

export interface CycloneDxDependency {
  ref: string;
  dependsOn?: string[];
  provides?: string[];
}

export interface CycloneDxBom {
  bomFormat: "CycloneDX";
  specVersion: typeof CBOM_SPEC_VERSION;
  serialNumber?: string;
  version: number;
  metadata: {
    timestamp: string;
    tools: { components: CycloneDxComponent[] };
    properties?: CycloneDxProperty[];
  };
  components: CycloneDxComponent[];
  dependencies: CycloneDxDependency[];
}
