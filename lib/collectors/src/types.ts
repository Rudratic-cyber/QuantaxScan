import type { DiscoveryModality, Surface } from "./enums";
import type { LocationDetail } from "./location-detail";

/**
 * Every collector emits this — the normalised currency of the system.
 * docs/Claude/04-architecture.md §2 "VULNERABILITY_PATTERNS → collector interface".
 *
 * Fields added by the qx-sp1800-38b investigation report beyond the
 * original architecture sketch: `keySize` (G-05), `discoveryModality`
 * (G-15), and the validated discriminated `locationDetail` (replacing
 * `Record<string, unknown>`).
 */
export interface RawObservation {
  /** Canonical name, matched against docs/Claude/mappings/algorithms.json. */
  algorithm: string;
  /**
   * The stated key/curve parameter size (e.g. RSA-2048 → 2048, P-384 → 384),
   * NOT a derived security-strength category — that keying is the consuming
   * mapping engine's job (out of scope here). `undefined` when the
   * collector cannot determine it; never a guessed default. At the
   * persistence boundary this becomes `keySize: null` on the `observations`
   * row (also carried up to `assets.keySize` when it is the newest
   * observation) — see docs/Claude/09-open-gaps.md G-05.
   */
  keySize?: number;
  /** Stable, opaque locator: path, host:port, cert serial, key ARN. Feeds the asset fingerprint. */
  location: string;
  /** Surface-specific structured context. May legitimately change between observations of the same asset — not part of identity. */
  locationDetail?: LocationDetail;
  /** How this observation was obtained. SP 1800-38B §4.1.4 plus two product extensions — see enums.ts. */
  discoveryModality: DiscoveryModality;
  /** 0..1. Regex ≈ 0.7, a completed TLS handshake ≈ 1.0. Not decoration — see docs/Claude/09-open-gaps.md G-11. */
  confidence: number;
  /** Line number, snippet, handshake detail, binary rule match, etc. */
  evidence: Record<string, unknown>;
}

export interface CollectorCapabilities {
  /** Nominal confidence this collector's observations carry, before any per-observation adjustment. */
  confidence: number;
  canDetermineKeySize: boolean;
}

/** What a collector is asked to scan. One variant exists today: `source`. */
export type CollectionTarget = {
  kind: "source";
  repo: string;
  files: Array<{ path: string; content: string; language: string }>;
};

export interface CollectorContext {
  organizationId: number;
}

export interface Collector {
  readonly name: string;
  readonly version: string;
  readonly surface: Surface;
  readonly capabilities: CollectorCapabilities;

  collect(target: CollectionTarget, ctx: CollectorContext): AsyncIterable<RawObservation>;
}
