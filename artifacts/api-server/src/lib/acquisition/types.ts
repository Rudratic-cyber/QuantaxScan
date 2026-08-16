import type { SecretHandle } from "@workspace/db/credentials";
import type { CredentialKind } from "@workspace/db/schema";
import type {
  DiscoveryScope,
  EnumeratedScope,
  EnumerationRecord,
  RefusedScope,
  Surface,
} from "@workspace/collectors";

/**
 * Discovery stage 0 — the acquisition contract, with no provider behind it yet.
 * docs/Claude/17-discovery-design.md §4.2, §4.3.
 *
 * ## Why this is a peer of `Collector` and not an extension of it
 *
 * The obvious move is to widen `CollectionTarget` with a credentialed variant
 * and let collectors pull. The codebase has already voted against it twice.
 *
 * `Collector.collect(target, ctx)` is presented in `04-architecture.md` as *the*
 * seam, but the two types either side of it are a single-variant union of
 * submitted file bytes and an organisation id: **there is no host, no endpoint,
 * no credential and no connection affordance anywhere in the contract.** The
 * consequence is already visible in the tree — only the four file-shaped
 * collectors implement `Collector` at all. Six of the ten live surfaces
 * (`tls`, `kms`, `data-at-rest`, `ot`, `network-flow`, `endpoint`) quietly
 * declined, and `endpoint-collector.ts` writes down why: *"a class whose
 * `collect()` yielded nothing would satisfy the interface and mislead every
 * reader of it."*
 *
 * Widening `CollectionTarget` would also put a `SecretHandle` — or worse, a
 * provider SDK — inside `@workspace/collectors`, the package that deliberately
 * has no dependency on `@workspace/db` so it can ship as a standalone on-prem
 * agent.
 *
 * So: **acquisition produces the input, the pure mapper consumes it.** That is
 * B3's existing three-file split (`tls-collector.ts` maps, `tls-probe.ts`
 * connects, `tls-ssrf-guard.ts` guards) generalised, and B7 already states it
 * copied that split on purpose. There are two seams, not one, and pretending
 * otherwise is what produced six collectors opting out of the documented one.
 *
 * ## What acquisition must not try to express
 *
 * `DISCOVERY_MODALITY_VALUES` is a **permanent** six-value enum by captain
 * decision (2026-08-02, G-15). A submitted KMS export and a credentialed KMS
 * poll are both `configuration_information`, and there is no seventh value
 * coming. The poll-versus-submission distinction lives in exactly three places
 * and nowhere else: the run's `collector`/`collectorVersion` (`"kms-inventory"`
 * versus `"kms-poll-aws"`), the observation's `confidence`, and
 * `collection_runs.enumeration`. Do not reach for the modality enum.
 */

/**
 * What one credentialed read was asked to cover.
 *
 * `scopes` is a list rather than a single scope because the unit of *failure*
 * is a scope: one region can throttle while three succeed, and an acquisition
 * that could only be asked for one thing at a time would force the caller to
 * reassemble a partial result from N calls, which is where the boundary gets
 * lost.
 */
export interface AcquisitionRequest {
  scopes: DiscoveryScope[];
  /**
   * Ceiling on items returned across all scopes. Hitting it sets
   * `truncated`, never silently trims — `MAX_DISCOVERED_HOSTNAMES_PER_RUN`'s
   * rule, applied to somebody else's paginated API.
   *
   * §7 Q6 is open: this bounds *our* work, while a cloud enumeration also
   * bounds *the customer's bill* and their API rate limits, and no real account
   * has been measured. Until one is, err toward a low ceiling with
   * `truncated: true`, which is at least honest.
   */
  maxItems: number;
}

/**
 * What one credentialed read of one provider produced, and — the part that
 * matters — the boundary of what it can speak for.
 *
 * `input` is deliberately typed as whatever the existing pure collector already
 * takes. Nothing new: the point of this layer is that the mapper does not learn
 * that its bytes arrived over a credential rather than an upload, so its
 * behaviour cannot silently diverge between the two paths.
 */
export interface AcquisitionResult<TInput> {
  input: TInput;
  /** Scopes fully enumerated: pagination exhausted, no error. The only thing that earns a claim of coverage. */
  enumerated: EnumeratedScope[];
  /** Scopes attempted and not completed, each with a reason from the closed vocabulary. */
  refused: RefusedScope[];
  /** A ceiling was hit. Reported, never silent. */
  truncated: boolean;
}

/**
 * One provider's credentialed read of one surface.
 *
 * `credentialKind` is asserted at redemption and a mismatch is refused, so this
 * field is not documentation — it is what stops a bug handing the IdP client
 * secret to the KMS poller.
 */
export interface Acquisition<TInput> {
  /** Becomes `collection_runs.collector`, e.g. `"kms-poll-aws"`. Distinct from the submission path's `"kms-inventory"`. */
  readonly name: string;
  readonly version: string;
  readonly surface: Surface;
  readonly credentialKind: CredentialKind;

  /**
   * **Runs outside any database transaction.**
   *
   * A vendor round trip can take seconds; holding a `pg` connection open across
   * one ties up the pool for the duration and behaves badly behind a
   * transaction-mode pooler. §7 Q1 is explicitly open on whether this needs a
   * `withRedeemedCredential` variant of F4's contract or whether
   * `redeemCredential` as written is already sufficient — **and it is
   * deliberately unanswered here.** What settles it is how long a real
   * AWS/Azure enumeration takes against the deployed pool size, which is a
   * measurement the first provider lane will have and this file does not. Do
   * not add the variant on speculation; add it when a number says to.
   */
  acquire(secret: SecretHandle, request: AcquisitionRequest): Promise<AcquisitionResult<TInput>>;
}

/**
 * Turn an acquisition's boundary into the record persisted on the collection
 * run — `IngestSpec.enumeration`.
 *
 * Exists so no provider lane hand-assembles this shape. Four lanes each
 * building it by hand is four chances to omit `truncated` or to pass an empty
 * record where the field should have been absent, and the absent/empty
 * distinction is the whole reason the column is nullable with no default.
 */
export function enumerationRecordFor<TInput>(
  result: AcquisitionResult<TInput>,
  credentialId: number,
): EnumerationRecord {
  return {
    enumerated: result.enumerated,
    refused: result.refused,
    truncated: result.truncated,
    credentialId,
  };
}

/**
 * What became of the attempt, for `collection_runs.status`.
 *
 * Note the asymmetry with `DISCOVERY_RUN_STATUS_VALUES`, and that it is
 * intentional: a *discovery* run has four states because `partial` is a real
 * and reportable outcome there. `collection_runs` has three, and a partial
 * credentialed collection is `completed` **with an `enumeration` record that
 * names what it could not reach** — because the observations it did produce are
 * real coverage of the scopes it did enumerate, and filing them under `failed`
 * would delete them from the meter entirely.
 *
 * `failed` is therefore reserved for an attempt that enumerated *nothing*. That
 * run produced no coverage, and `coverage.ts` keeping it out of `completedRuns`
 * — *"an attempt that produced nothing is not coverage"* — is correct for it and
 * would be wrong for the partial case.
 */
export function collectionRunStatusFor<TInput>(result: AcquisitionResult<TInput>): "completed" | "failed" {
  return result.enumerated.length > 0 ? "completed" : "failed";
}
