/**
 * Single source of truth for every enum shared between the TypeScript
 * `RawObservation`/`Collector` contract and the Postgres `CHECK` constraints
 * in `@workspace/db`. Narrowing or widening any of these is a one-file change:
 * update the const tuple here, then update the two `CHECK` constraints in
 * `lib/db/src/schema/enums.ts` (or regenerate them from these tuples) and the
 * dependent migration. Do not duplicate these literals elsewhere.
 */

/**
 * Discovery modality, carried on every `observations` row alongside the
 * numeric `confidence`. SP 1800-38B §4.1.4 names four modalities:
 * `passive_network_observation`, `active_network_scan`, `endpoint_monitoring`,
 * `configuration_information`. Four planned collectors (source regex,
 * dependency/SBOM, manual OT register, vendor questionnaire) fit none of
 * them cleanly, so this project adds two extensions:
 * `static_artifact_analysis` and `manual_attestation`.
 *
 * Confirmed as a permanent six-value enum by captain decision, 2026-08-02
 * (see docs/Claude/09-open-gaps.md, G-15). Earlier drafts of this project
 * treated the two extensions as provisional pending a possible narrowing to
 * NIST's original four; that reservation has been resolved and all six
 * values are final.
 *
 * Source: NIST SP 1800-38B (preliminary draft, December 2023) §4.1.4, p. 25.
 * See docs/Claude/mappings/README.md and the qx-sp1800-38b investigation
 * report for the operational definition of each value.
 */
export const DISCOVERY_MODALITY_VALUES = [
  "passive_network_observation",
  "active_network_scan",
  "endpoint_monitoring",
  "configuration_information",
  "static_artifact_analysis",
  "manual_attestation",
] as const;

export type DiscoveryModality = (typeof DISCOVERY_MODALITY_VALUES)[number];

/**
 * Asset surface domain. `source`, `dependency`, `tls`, `certificate`, `kms`,
 * `config`, `ot` come from docs/Claude/04-architecture.md's fingerprint
 * table. `binary` is added per the qx-sp1800-38b investigation report so the
 * schema accommodates a future binary collector — no binary collector is
 * implemented in this change.
 */
export const SURFACE_VALUES = [
  "source",
  "dependency",
  "tls",
  "certificate",
  "kms",
  "config",
  "ot",
  "binary",
] as const;

export type Surface = (typeof SURFACE_VALUES)[number];

/**
 * Asset lifecycle status. docs/Claude/04-architecture.md §"assets — stable
 * identity, survives re-scans".
 */
export const ASSET_STATUS_VALUES = ["active", "remediated", "waived", "gone"] as const;

export type AssetStatus = (typeof ASSET_STATUS_VALUES)[number];

/**
 * Discriminator for the validated `locationDetail` shape. This is a
 * separate concept from `Surface`: several surfaces (`tls`, `certificate`)
 * share the `network` locationDetail shape, because SP 1800-38B's seven
 * network data elements apply regardless of which surface observed them.
 */
export const LOCATION_DETAIL_KIND_VALUES = ["source", "network", "dependency", "binary"] as const;

export type LocationDetailKind = (typeof LOCATION_DETAIL_KIND_VALUES)[number];
