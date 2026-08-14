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
 *
 * `data-at-rest` and `vendor` were added 2026-08-14 ahead of their collectors
 * (B7, B9), deliberately and as a single change. They were the only two
 * catalogue entries whose `surface` was `null` — meaning the database could
 * not have stored a finding from them even if a collector existed. Adding a
 * value here rewrites the `CHECK` on `assets.surface` and
 * `collection_runs.surface`, so it needs a migration; doing both at once, in
 * one migration, is what stops two parallel collector lanes each generating a
 * `0005_*` and colliding in `drizzle/meta/_journal.json`, which no merge can
 * resolve. Neither collector exists yet: the catalogue still reports both
 * `planned`, which is the honest state.
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
  "data-at-rest",
  "vendor",
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
 * separate concept from `Surface`: `tls` and a *live-host* certificate
 * observation share the `network` locationDetail shape, because SP 1800-38B's
 * seven network data elements (Table 6: IP, port, hostname, protocol, three
 * CPE profiles) describe facts about where something was observed on the
 * wire — they apply regardless of which surface observed them.
 *
 * `certificate` is its own kind, not folded into `network`, because B4's
 * collector reads a *submitted* PEM/DER artifact, not a live endpoint: there
 * is no IP, port or hostname to report, and `network`'s schema has nowhere
 * to put issuer/serial/notBefore/notAfter, which are facts about the
 * certificate itself rather than about a network observation of it. A future
 * live-TLS-fetch collector for certificates (out of scope here — see B4's
 * task notes) would emit `network`, the same as the TLS surface; this kind is
 * for the case where no network observation happened at all.
 *
 * `config` is B6's profile, and is likewise its own kind rather than a variant
 * of `source`. A configuration file *is* a file at a path, so `source` looks
 * like a fit — but a source observation's identity is a matched symbol on a
 * line, while a configuration observation's is a directive and the token it
 * was given, and `source`'s schema has nowhere to record whether the value was
 * a specific key or merely a permitted one. That distinction is the entire
 * evidential content of the surface, so folding it into `source` would lose
 * it. Adding this kind needs no migration: `assets.location_detail` is bare
 * `jsonb` validated at the application boundary, not a constrained column.
 *
 * `kms` is B5's, added for the same reason: a managed key store reports
 * facts *about* a key (provider, key id, spec, rotation state) through a
 * control plane, so none of `network`'s seven wire-observation elements
 * apply and none of `certificate`'s issuer/serial/validity fields do either.
 * Unlike `network`, it is not shared between surfaces — `kind === "kms"`
 * identifies the `kms` surface unambiguously, which is what lets
 * `fingerprintForObservation()` resolve it without the discriminator problem
 * documented on the `network` case there.
 *
 * **This tuple is TypeScript-only.** Unlike `SURFACE_VALUES`, no `CHECK`
 * constraint is derived from it — `assets.location_detail` is `jsonb`,
 * validated at the application boundary by `LocationDetailSchema`. Adding a
 * kind therefore needs no migration.
 *
 * `data-at-rest` is B7's profile for a *described* encrypted store. It carries
 * no path, host or artefact of its own because there is none to carry: the
 * evidence is a configuration reading or an attestation about a database,
 * bucket or backup set, and the fields that matter (which half of the key
 * hierarchy, whether the store is encrypted at all, what the caller actually
 * reported before it was canonicalised) fit none of the profiles above. Adding
 * a value here needs no migration — `assets.location_detail` is `jsonb`, with
 * the shape validated at the application boundary rather than by a `CHECK`.
 */
export const LOCATION_DETAIL_KIND_VALUES = [
  "source",
  "network",
  "dependency",
  "binary",
  "certificate",
  "config",
  "kms",
  "data-at-rest",
] as const;

export type LocationDetailKind = (typeof LOCATION_DETAIL_KIND_VALUES)[number];
