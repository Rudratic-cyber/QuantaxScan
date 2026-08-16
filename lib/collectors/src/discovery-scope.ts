import type { DiscoveryRefusalReason } from "./enums";

/**
 * Stage 0 of discovery and credentialed collection.
 * docs/Claude/17-discovery-design.md §2.2(c), §2.3, §4.3.
 *
 * **A scope is the answer to "what did you actually look at?"** — and it exists
 * because the answer stopped being obvious. D8 had one: the customer named a
 * domain, and a certificate-transparency query against it either returns or
 * fails. `discovered_targets.source_domain` was a `text` column because one
 * string held the whole question.
 *
 * A credentialed cloud enumeration has no such string. "We enumerated your AWS
 * account" is four facts — provider, account, service, region — and any one of
 * them can be the thing that went wrong. Flattening them back into a sentence
 * is what makes a partial result unreportable, so the shape here keeps them
 * apart and makes the *boundary* the primary content rather than a footnote.
 *
 * ## Why these types live in `@workspace/collectors`
 *
 * They are pure data with no dependency on `@workspace/db`, and the package is
 * deliberately dependency-free so it can ship as a standalone on-prem agent
 * (CLAUDE.md, "Package boundaries"). An acquisition running inside a customer's
 * network has to describe what it could and could not reach using exactly this
 * vocabulary, whether or not it can see a database.
 *
 * ## What is deliberately not here
 *
 * **No `Acquisition` interface and no `SecretHandle`.** Those hold a provider
 * SDK and a credential, so they live server-side in
 * `artifacts/api-server/src/lib/acquisition/`. Putting them here would re-admit
 * the dependency the package boundary exists to refuse — see §4.2, which
 * chooses a peer interface over widening `Collector` for this reason.
 */

/**
 * What was searched, in a shape that can hold a question bigger than a domain.
 *
 * Discriminated so a reader never has to guess which fields are meaningful:
 * `region` on a domain scope would be a null that means "not applicable" rather
 * than "nobody looked", and the two are the distinction this codebase spends
 * the most effort keeping apart.
 *
 * Every optional field follows the rule the rest of the product follows:
 * **absent means not supplied, never a default**. A provider that does not
 * partition by region yields no `region` — not `"global"`, which would be a
 * word we invented appearing where a customer expects one they recognise.
 */
export type DiscoveryScope =
  | {
      kind: "domain";
      /** The registrable domain the customer asked us to search. Normalised by `normaliseHostname()`. */
      domain: string;
    }
  | {
      kind: "cloud_account";
      /** `aws` | `azure` | `gcp` | a name the customer's own console uses. Not an enum: providers outlive our tuple. */
      provider: string;
      /** The account, subscription or project id, exactly as the provider spells it. */
      account: string;
      /** Absent when the provider does not partition this service by region. */
      region?: string;
      /** Absent when the scope covers the whole account rather than one service. */
      service?: string;
    }
  | {
      kind: "directory";
      /** The MDM/EDR/AD directory the fleet was read from, as the customer names it. */
      directory: string;
    }
  | {
      kind: "issuer";
      /** The OIDC issuer or JWKS URL the customer named. */
      issuer: string;
    };

/**
 * A scope we can speak for: pagination exhausted, no error, nothing skipped.
 *
 * `complete` is `true` and not optional on purpose. The type could have been a
 * bare `DiscoveryScope[]` with completeness implied by membership, and that is
 * exactly the implicitness that lets a future caller push a half-read scope
 * into the list because it "mostly worked". Making the claim explicit means
 * writing `complete: true` next to it, which is a sentence somebody has to mean.
 */
export interface EnumeratedScope {
  scope: DiscoveryScope;
  /** Always `true` — see above. A scope that is not complete belongs in `refused`. */
  complete: true;
}

/**
 * A scope attempted and not completed, with a reason from the closed
 * vocabulary — **never a vendor SDK's error object** (§2.3).
 *
 * `detail` exists for a human reading one run, and is explicitly not the thing
 * a query groups by. Keep it short and keep customer identifiers out of it: it
 * ends up in a regulator-facing pack.
 */
export interface RefusedScope {
  scope: DiscoveryScope;
  reason: DiscoveryRefusalReason;
  /** Optional free text for a human. Never parsed, never grouped by, never a substitute for `reason`. */
  detail?: string;
}

/**
 * What one collection run can and cannot speak for — persisted to
 * `collection_runs.enumeration` (§4.4(b)).
 *
 * **Nullable with no default, and that is the whole design.** Absent means a
 * submission, which made no enumeration claim at all. An *empty* record would
 * say "we enumerated, and successfully enumerated nothing", which is a
 * different and much stronger statement. The same distinction `assets.key_size`
 * and A3's classification columns are nullable to preserve: a value nobody
 * supplied must not be storable as a value somebody did.
 */
export interface EnumerationRecord {
  enumerated: EnumeratedScope[];
  refused: RefusedScope[];
  /** A pagination or safety ceiling was hit. Reported, never silent — `MAX_DISCOVERED_HOSTNAMES_PER_RUN`'s rule. */
  truncated: boolean;
  /** Which stored credential this run redeemed. Null for an uncredentialed run; never the credential itself. */
  credentialId?: number;
}

/**
 * Does this record describe a run that covered everything it was asked to?
 *
 * Derived, never stored — the same discipline as `resolveSecrecyLifetime()` and
 * `certificateExpired()`. A stored "was it complete" flag can disagree with the
 * scopes beneath it; a derived one cannot.
 *
 * Note that an enumeration with **no scopes at all** is not complete. It is a
 * run that established nothing, and returning `true` for it would let a report
 * describe an empty result as full coverage — the exact failure the
 * `no_evidence` run status exists to name.
 */
export function enumerationIsComplete(record: EnumerationRecord): boolean {
  return record.enumerated.length > 0 && record.refused.length === 0 && !record.truncated;
}
