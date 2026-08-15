import { type Surface } from "./enums";

/**
 * The thirteen collector surfaces, in the order they are presented.
 *
 * This is the **single source of truth** for "what could we have looked at",
 * and it exists because there were two answers to that question in this
 * repository and they were allowed to disagree: the marketing coverage page
 * listed eight surfaces for a while (fixed in 3ee0581) while the roadmap in
 * docs/Claude/03-features.md §B listed ten. D3 — the coverage and confidence
 * meter — is the denominator of an honesty claim, so a second hardcoded copy
 * of this list is not a tidiness problem, it is a correctness one.
 *
 * It lives in `@workspace/collectors` next to `SURFACE_VALUES` for the same
 * reason the enums do: this describes the *collector contract*, and the
 * drift-guard in `surface-catalogue.test.ts` can only compare the two lists
 * if they are in the same package. Presentation (icon, prose blurb) is
 * deliberately NOT here — the UI joins it on by `id`, so this package stays
 * the dependency-free thing that can ship as a standalone on-prem agent.
 *
 * Exported as the `@workspace/collectors/surface-catalogue` subpath rather
 * than only from the package root, so a browser bundle can import it without
 * dragging in `fingerprint.ts`'s `node:crypto`.
 */

/**
 * `live` means a collector for this surface runs in production today.
 * `planned` means it does not exist — anything it would have found has
 * **never been examined**, which is the fact D3 has to state out loud.
 */
export const COLLECTOR_SURFACE_STATUS_VALUES = ["live", "planned"] as const;
export type CollectorSurfaceStatus = (typeof COLLECTOR_SURFACE_STATUS_VALUES)[number];

export interface CollectorSurfaceEntry {
  /** Stable key. Presentation and per-surface coverage data are joined on this, never on `name`. */
  id: string;
  name: string;
  status: CollectorSurfaceStatus;
  /**
   * The `Surface` enum value this collector's assets and collection runs are
   * recorded under — or `null` when the asset model has no value for it at
   * all, a *deeper* absence than "planned" which the meter reports separately.
   *
   * No entry is `null` as of 2026-08-14: `data-at-rest` and `vendor` were the
   * last two, and their enum values landed ahead of their collectors (see
   * `SURFACE_VALUES` in enums.ts for why both at once). The type stays
   * nullable because the distinction is real and a future surface can be
   * catalogued before the schema can store it — that a collector is planned
   * and that its findings are unstorable are different facts, and collapsing
   * them would make the meter overstate what this product is ready to record.
   */
  surface: Surface | null;
}

export const COLLECTOR_SURFACES = [
  { id: "source", name: "Source code", status: "live", surface: "source" },
  // `live` since B2's ingest path landed. The collector alone was not enough
  // to earn it: until `POST /projects/:id/dependencies` persisted what it
  // found, no run of it could ever be recorded, and a surface whose results
  // are unreachable has not been examined in any sense a CISO cares about.
  { id: "dependency", name: "Dependencies / SBOM", status: "live", surface: "dependency" },
  // Both `live` since their ingest paths landed — B3's `POST /projects/:id/tls`
  // and B4's `POST /projects/:id/certificates`. Same bar as `dependency`
  // above: a collector alone does not earn `live`, a route that persists what
  // it finds does.
  { id: "tls", name: "TLS & cipher suites", status: "live", surface: "tls" },
  { id: "certificate", name: "Certificates (X.509)", status: "live", surface: "certificate" },
  // `live` since B5's `POST /projects/:id/kms` persisted its first key. Same
  // bar as every entry above: the collector alone never earns it, a route
  // that writes what it finds does. Worth noting what `live` does *not*
  // claim here — the collector reads a submitted key inventory rather than
  // polling the key store with a credential, so this surface counts as
  // examined for the keys a caller sent, exactly as `dependency` counts as
  // examined for the lockfiles a caller sent.
  { id: "kms", name: "KMS & secret stores", status: "live", surface: "kms" },
  // `live` since B6's `POST /projects/:id/protocol-config` landed, on the same
  // bar, and with the same qualification: a config collector reads what a
  // submitted file *declares*, which is a weaker claim than what B3 observed
  // being negotiated on the wire.
  { id: "config", name: "Protocol config", status: "live", surface: "config" },
  // `live` since B7's ingest path landed — `POST /projects/:id/data-at-rest`.
  // Same bar as the four above: the collector is a submission mapper, and what
  // earned the status is a route that persists what it maps.
  { id: "data-at-rest", name: "Data-at-rest", status: "live", surface: "data-at-rest" },
  // `live` since the register's writes began deriving assets on this surface
  // — every edit re-derives it (`ingestOtObservations`). It is the one live
  // surface whose evidence is `manual_attestation` rather than something
  // observed, and the confidence on its observations says so: 0.3, below every
  // automated collector. A register whose fleets carry only free-text
  // descriptions still produces nothing, so `live` here means "the register
  // can record cryptography", not "the register has any".
  { id: "ot", name: "Manual OT / embedded register", status: "live", surface: "ot" },
  { id: "vendor", name: "Vendor / third-party", status: "planned", surface: "vendor" },
  { id: "binary", name: "Binaries / firmware", status: "planned", surface: "binary" },
  // Added 2026-08-15. These three were missing from the catalogue entirely
  // rather than listed as unexamined — see `SURFACE_VALUES` for why that is the
  // worse of the two errors. Each is a real part of an enterprise estate that
  // no collector reaches today.
  { id: "network-flow", name: "Network conversations", status: "planned", surface: "network-flow" },
  // `live` since EP's ingest path landed — `POST /projects/:id/endpoint`. Same
  // bar as every entry above: what earns the status is a route that persists
  // what it reads, not a collector existing. Worth naming what `live` does not
  // claim here, because this surface invites the misreading more than most: no
  // agent ships with this product yet, so the surface counts as examined for
  // the hosts whose reports a caller sent, exactly as `dependency` counts as
  // examined for the lockfiles a caller sent. The agent is the follow-up; the
  // contract and the ingest it reports to are what exist.
  { id: "endpoint", name: "Endpoint & host fleet", status: "live", surface: "endpoint" },
  { id: "identity", name: "Identity & authentication", status: "planned", surface: "identity" },
] as const satisfies readonly CollectorSurfaceEntry[];

export type CollectorSurfaceId = (typeof COLLECTOR_SURFACES)[number]["id"];

/** The surfaces a collector actually runs against today. */
export const LIVE_COLLECTOR_SURFACES: readonly CollectorSurfaceEntry[] = COLLECTOR_SURFACES.filter(
  (entry) => entry.status === "live",
);

/**
 * Which catalogue entry a stored `Surface` value belongs to, or `undefined` for
 * a value no entry claims.
 *
 * Takes `string`, not `Surface`, on purpose: the callers that need this are
 * reading `assets.surface` / `collection_runs.surface`, which are `text`
 * columns constrained by a `CHECK` rather than a Postgres `ENUM`, so what comes
 * back from the database is a `string`. Making them cast would be the kind of
 * `as` that hides a genuine unknown-surface case.
 */
export function catalogueEntryForSurface(surface: string): CollectorSurfaceEntry | undefined {
  return COLLECTOR_SURFACES.find((entry) => entry.surface === surface);
}

/** Position of a stored `Surface` value in catalogue order — for sorting coverage rows the way the coverage page reads. */
export const CATALOGUE_ORDER_BY_SURFACE: ReadonlyMap<string, number> = new Map(
  COLLECTOR_SURFACES.flatMap((entry, index) => (entry.surface === null ? [] : [[entry.surface as string, index] as const])),
);
