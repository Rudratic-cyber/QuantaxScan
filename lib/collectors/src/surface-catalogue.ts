import { type Surface } from "./enums";

/**
 * The ten collector surfaces, in the order they are presented.
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
   * all. Two of the ten are `null` today (`data-at-rest`, `vendor`): the
   * database could not store a finding from them even if a collector existed,
   * which is a *deeper* absence than "planned" and the meter says so.
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
  { id: "tls", name: "TLS & cipher suites", status: "planned", surface: "tls" },
  { id: "certificate", name: "Certificates (X.509)", status: "live", surface: "certificate" },
  { id: "kms", name: "KMS & secret stores", status: "planned", surface: "kms" },
  { id: "config", name: "Protocol config", status: "planned", surface: "config" },
  { id: "data-at-rest", name: "Data-at-rest", status: "planned", surface: null },
  { id: "ot", name: "Manual OT / embedded register", status: "planned", surface: "ot" },
  { id: "vendor", name: "Vendor / third-party", status: "planned", surface: null },
  { id: "binary", name: "Binaries / firmware", status: "planned", surface: "binary" },
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
