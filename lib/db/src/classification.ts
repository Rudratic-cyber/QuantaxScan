/**
 * A3 — data classification, and the secrecy lifetime (X) it produces.
 *
 * docs/Claude/03-features.md §A3. This module owns two things:
 *
 *   1. the classification vocabulary and its preset X values, and
 *   2. `resolveSecrecyLifetime()`, which turns "what was configured on the
 *      asset" + "what was configured on the project" into the single X value a
 *      report or a risk calculation may use — **together with where that value
 *      came from**.
 *
 * ## This is A4's X input
 *
 * A4 (the Mosca risk engine, `docs/Claude/03-features.md` §A4) consumes
 * `SecrecyLifetime` as its `X`. It is deliberately importable without pulling
 * in drizzle, `pg`, or `DATABASE_URL`:
 *
 * ```ts
 * import { resolveSecrecyLifetime, type SecrecyLifetime } from "@workspace/db/classification";
 * ```
 *
 * The subpath export exists for exactly that reason — importing the package
 * root (`@workspace/db`) constructs a connection pool and throws without
 * `DATABASE_URL`. **Nothing in this file may import drizzle or any schema
 * file**; the dependency runs the other way (`schema/assets.ts` and
 * `schema/projects.ts` import the tuple from here).
 *
 * ## Why nothing here is NOT NULL, and why the provenance is derived
 *
 * `assets.data_classification`, `assets.secrecy_lifetime_years` and the
 * matching pair on `projects` are all **nullable, with no database default**.
 * That is load-bearing, not laziness. A3's acceptance criterion is that the
 * default is "clearly marked as an assumption in reports" — which is only
 * possible while "a human chose Internal" and "nobody said anything" remain
 * distinguishable. A `NOT NULL DEFAULT 3` would erase that distinction on the
 * way into the database and no amount of UI copy could recover it. This mirrors
 * `assets.key_size`, which is null-when-undetermined for the same reason
 * (docs/Claude/09-open-gaps.md G-05: "Never a guessed default").
 *
 * The provenance itself is therefore *derived* rather than stored. A persisted
 * `classification_source` column would go stale the moment a project's default
 * changed: it would keep asserting "supplied" about a value that had since been
 * recomputed from somewhere else. Nullability already carries the fact; this
 * function reads it. The resolved `SecrecyLifetime` record is what reports and
 * A4 consume, so the assumption travels *in the data*, not in a caption.
 */

/**
 * The classification vocabulary, and the single source of truth for the
 * `CHECK` constraints on `assets.data_classification` and
 * `projects.data_classification`.
 *
 * A deliberate, recorded deviation from AGENTS.md's rule that shared enums
 * needing both a DB constraint and a TypeScript type live in
 * `@workspace/collectors` — the same deviation, for the same reason, as
 * `schema/auth-enums.ts`. That rule exists because those enums are part of the
 * *collector* contract, and `lib/collectors` is dependency-free so it can ship
 * as a standalone on-prem agent. A collector observes crypto; it has no idea
 * whether the data behind it is Regulated. Classification is a statement the
 * organisation makes about its own data, so putting it in the collector
 * contract would be putting a business judgement in the one artefact whose
 * whole point is that it makes none.
 *
 * The rule's mechanism is preserved exactly: one const tuple, `text` + `CHECK`
 * via `oneOf()`, never a Postgres `ENUM` type.
 */
export const DATA_CLASSIFICATION_VALUES = [
  "public",
  "internal",
  "confidential",
  "regulated",
  "indefinite",
] as const;

export type DataClassification = (typeof DATA_CLASSIFICATION_VALUES)[number];

/**
 * X in years for each preset, verbatim from the table in
 * docs/Claude/03-features.md §A3.
 *
 * A preset is a starting point, not a constraint. `secrecy_lifetime_years` is
 * stored independently of the label and there is deliberately no `CHECK` tying
 * one to the other: "Confidential, but this particular contract has to stay
 * secret for 10 years" is an ordinary thing for an organisation to say, and a
 * consistency constraint would make it unsayable.
 */
export const SECRECY_LIFETIME_YEARS_BY_CLASSIFICATION: Record<DataClassification, number> = {
  public: 0,
  internal: 3,
  confidential: 7,
  regulated: 25,
  indefinite: 50,
};

export interface DataClassificationPreset {
  value: DataClassification;
  /** Display label, e.g. "Confidential". */
  label: string;
  /** The preset X, in years. */
  years: number;
  /** The spec's illustrative examples, for the picker and for report copy. */
  examples: string;
}

/** Ordered least-sensitive → most-sensitive, which is the order a picker should show. */
export const DATA_CLASSIFICATION_PRESETS: readonly DataClassificationPreset[] = [
  { value: "public", label: "Public", years: 0, examples: "Marketing sites, published docs" },
  { value: "internal", label: "Internal", years: 3, examples: "Internal tooling, non-sensitive ops" },
  { value: "confidential", label: "Confidential", years: 7, examples: "Commercial contracts, financials" },
  { value: "regulated", label: "Regulated", years: 25, examples: "Health records, insurance, government" },
  { value: "indefinite", label: "Indefinite", years: 50, examples: "State secrets, genomic data, identity roots" },
];

/**
 * Where a resolved value came from.
 *
 *   `asset`   — supplied for this specific asset. The only *supplied* case.
 *   `project` — inherited from the project's configured default. A human chose
 *               it, but not for this asset, so it is still an assumption about
 *               this asset.
 *   `default` — nothing was configured anywhere and the product's fallback was
 *               used. The weakest case, and the one a report must be loudest
 *               about.
 */
export const CLASSIFICATION_SOURCE_VALUES = ["asset", "project", "default"] as const;
export type ClassificationSource = (typeof CLASSIFICATION_SOURCE_VALUES)[number];

/**
 * The terminal fallback, used only when neither the asset nor its project says
 * anything. `internal` / 3 years is the least-alarming non-zero choice: it does
 * not manufacture urgency the customer never claimed, and — unlike `public` /
 * 0 — it does not silently exempt an asset from harvest-now-decrypt-later risk
 * just because nobody got round to classifying it.
 *
 * Anything resolved from here has `source: "default"` and `assumed: true`.
 */
export const DEFAULT_DATA_CLASSIFICATION: DataClassification = "internal";
export const DEFAULT_SECRECY_LIFETIME_YEARS =
  SECRECY_LIFETIME_YEARS_BY_CLASSIFICATION[DEFAULT_DATA_CLASSIFICATION];

/**
 * The resolved X for one asset, with its provenance. **This is the type A4
 * takes as its `X` input.**
 *
 * `years` is always a number — A3's acceptance is "every asset has an X value",
 * so this never returns null and a caller never needs a fallback of its own.
 */
export interface SecrecyLifetime {
  /** X: how many years the data must remain confidential. Always present. */
  years: number;
  /** Where `years` came from. */
  source: ClassificationSource;
  /**
   * `source !== "asset"` — i.e. the value was *defaulted*, not supplied for
   * this asset. A3's acceptance requires reports to say so; this is the flag
   * they read, and it is why `source` and `assumed` are both exported rather
   * than leaving each caller to draw the line itself.
   */
  assumed: boolean;
  /** The classification label. Always present, for the same reason as `years`. */
  classification: DataClassification;
  /**
   * Where `classification` came from. Usually equal to `source`, but not
   * always: an asset may carry an explicit `secrecyLifetimeYears` override
   * without its own label, in which case the years are asset-supplied while the
   * label is still inherited.
   */
  classificationSource: ClassificationSource;
  /** One sentence, report-ready, stating the provenance in plain English. */
  basis: string;
}

/**
 * The four configured values this resolution reads. Scalars, deliberately: the
 * resolver does no database access and knows nothing about how an asset is
 * associated with a project.
 *
 * That matters here specifically. `assets` has **no foreign key to `projects`**
 * — the association is the `project:<id>:` prefix on `assets.location` (see
 * `projectRepoId()` in `schema/assets.ts`) — and plenty of surfaces
 * (`tls`, `certificate`, `kms`) have no project at all. Callers that have a
 * project pass its defaults; callers that do not omit them and fall through to
 * the product default, which is a legitimate outcome rather than an error.
 */
export interface SecrecyLifetimeInput {
  /** `assets.data_classification`. Null/undefined = not supplied. */
  assetClassification?: DataClassification | null;
  /** `assets.secrecy_lifetime_years`. Null/undefined = not supplied. */
  assetSecrecyLifetimeYears?: number | null;
  /** `projects.data_classification`. Null/undefined = the project sets no default. */
  projectClassification?: DataClassification | null;
  /** `projects.secrecy_lifetime_years`. Null/undefined = the project sets no default. */
  projectSecrecyLifetimeYears?: number | null;
}

function presetLabel(value: DataClassification): string {
  return DATA_CLASSIFICATION_PRESETS.find((p) => p.value === value)?.label ?? value;
}

function describeBasis(
  years: number,
  source: ClassificationSource,
  classification: DataClassification,
  classificationSource: ClassificationSource,
): string {
  const label = presetLabel(classification);
  const plural = years === 1 ? "year" : "years";

  if (source === "asset" && classificationSource === "asset") {
    return `Supplied for this asset: ${label}, ${years} ${plural}.`;
  }
  if (source === "asset") {
    // `assumed` is false here — X *was* supplied — so this sentence must not
    // open with "Assumed", or a report rendering `basis` next to `assumed`
    // would contradict itself. Only the label is inherited, and it says so.
    return `Supplied for this asset: ${years} ${plural}. Its ${label} classification is inherited, not supplied.`;
  }
  if (source === "project") {
    return `Assumed, not supplied: inherited from the project default of ${label}, ${years} ${plural}.`;
  }
  return `Assumed, not supplied: no classification was set on this asset or its project, so QuantaXscan's default of ${label} (${years} ${plural}) was used.`;
}

/**
 * Resolve one asset's X and classification from the asset-level and
 * project-level settings, recording which level each came from.
 *
 * Precedence, most specific first: **asset → project → product default.** The
 * label and the years resolve independently — an asset may override the years
 * without restating the label, and a level that names only a classification
 * contributes that classification's preset years.
 *
 * Pure: no I/O, no clock, no database. That is what lets A4 call it inside a
 * risk calculation and lets both be unit-tested without a database.
 */
export function resolveSecrecyLifetime(input: SecrecyLifetimeInput): SecrecyLifetime {
  const {
    assetClassification,
    assetSecrecyLifetimeYears,
    projectClassification,
    projectSecrecyLifetimeYears,
  } = input;

  let classification: DataClassification;
  let classificationSource: ClassificationSource;
  if (assetClassification != null) {
    classification = assetClassification;
    classificationSource = "asset";
  } else if (projectClassification != null) {
    classification = projectClassification;
    classificationSource = "project";
  } else {
    classification = DEFAULT_DATA_CLASSIFICATION;
    classificationSource = "default";
  }

  // An explicit year count always beats the preset implied by a label at the
  // same level — that is what "Confidential, but 10 years" means — but a label
  // at a *more specific* level still beats an inherited year count.
  let years: number;
  let source: ClassificationSource;
  if (assetSecrecyLifetimeYears != null) {
    years = assetSecrecyLifetimeYears;
    source = "asset";
  } else if (assetClassification != null) {
    years = SECRECY_LIFETIME_YEARS_BY_CLASSIFICATION[assetClassification];
    source = "asset";
  } else if (projectSecrecyLifetimeYears != null) {
    years = projectSecrecyLifetimeYears;
    source = "project";
  } else if (projectClassification != null) {
    years = SECRECY_LIFETIME_YEARS_BY_CLASSIFICATION[projectClassification];
    source = "project";
  } else {
    years = DEFAULT_SECRECY_LIFETIME_YEARS;
    source = "default";
  }

  return {
    years,
    source,
    assumed: source !== "asset",
    classification,
    classificationSource,
    basis: describeBasis(years, source, classification, classificationSource),
  };
}

/** Narrowing guard for values arriving from outside TypeScript's reach (request bodies, `text` columns). */
export function isDataClassification(value: unknown): value is DataClassification {
  return typeof value === "string" && (DATA_CLASSIFICATION_VALUES as readonly string[]).includes(value);
}
