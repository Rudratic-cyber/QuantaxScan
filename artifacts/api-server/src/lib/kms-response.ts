import { KMS_KEY_SPECS_CRITICAL_CAVEAT, type KmsKeyOutcome } from "@workspace/collectors";

/**
 * The poller's evidence caveat, and it is **not** the submission route's.
 *
 * `routes/projects.ts`'s `KMS_EVIDENCE_CAVEAT` opens with *"no credential for
 * your key store ever reaches this product and nothing here connects to a
 * provider"*, which is precisely true of a submission and precisely false of a
 * poll. Reusing it would have put a false sentence into every credentialed
 * response — the sort of copy that is correct on the day it is written and
 * becomes a lie when a second caller appears.
 *
 * What changes and what does not: staleness and partiality are gone, because we
 * read the provider ourselves at a known instant and report the boundary of
 * what we enumerated. The spec-table limitation is unchanged, because it is a
 * property of the mapping rather than of the acquisition — so that half is
 * concatenated from the same source, not paraphrased.
 */
export const KMS_POLL_EVIDENCE_CAVEAT =
  "This collector read your key store directly, using a read-only credential you registered, at the instant " +
  "shown on the collection run. It reports the exact scopes it enumerated and the ones it could not — a region " +
  "that refused or throttled is recorded as refused and never as empty, and a run that did not enumerate a " +
  "scope completely does not retire anything within it. What a key store reports is still a statement about " +
  "configuration: a key that exists is not evidence that anything uses it. " +
  KMS_KEY_SPECS_CRITICAL_CAVEAT;

/**
 * Flattens one KMS collector outcome into the response shape shared by the
 * submission route (B5, `POST /projects/:id/kms`) and the credentialed poller
 * (P1, `POST /projects/:id/kms/poll`).
 *
 * Every non-`observed` outcome still appears: *"we looked at 40 keys,
 * classified 31, and here is what the other 9 were"* is the answer a key
 * inventory has to give, and a response listing only the 31 would read as a
 * complete inventory of 31 keys.
 *
 * ## Why it moved out of `routes/projects.ts`
 *
 * §6.3 of the discovery design says no lane may touch `routes/projects.ts` —
 * it is 2,200 lines and nineteen handlers, and it was the second-worst conflict
 * magnet in the plan. The poller obeys that rule: its handler lives in
 * `routes/collectors/kms-poll.ts`.
 *
 * It still needs this mapper, and the two available answers were to copy it or
 * to move it. Copying loses: both routes serve the same documented
 * `KmsKeyOutcomeEntry` schema, so a second copy is not a tidiness question but
 * the *"second hardcoded copy of this list is not a tidiness problem, it is a
 * correctness one"* argument that keeps the surface catalogue a single list. A
 * response shape that drifts between two routes returning the same schema is a
 * spec violation nothing would catch — `openapi-drift.test.ts` sees paths, not
 * response fields.
 *
 * So it moved, and `routes/projects.ts` changed by two lines: this function
 * deleted, and an import added. That is the smallest edit that avoids the
 * duplicate, and it is recorded here rather than left to be discovered because
 * §6.3's rule was written to be followed literally.
 */
export function toKmsKeyResponseEntry(outcome: KmsKeyOutcome) {
  const { key } = outcome;
  const base = {
    provider: key.provider,
    keyId: key.keyId,
    keySpec: key.keySpec ?? null,
    alias: key.alias ?? null,
    keyState: key.keyState ?? null,
    // Absent, not false — the source said nothing, and `false` would claim
    // this key is not rotated.
    rotationEnabled: key.rotationEnabled ?? null,
  };

  if (outcome.kind !== "observed") {
    return {
      ...base,
      outcome: outcome.kind,
      reason: outcome.reason,
      algorithm: null,
      // A `no-algorithm` spec can still state a size (HMAC_512 is 512 bits),
      // and reporting it is free information about a key we cannot classify.
      keySize: outcome.kind === "no-algorithm" ? outcome.entry.keySize : null,
      keySizeSource: null,
      location: null,
    };
  }

  const { observation } = outcome;
  return {
    ...base,
    outcome: outcome.kind,
    reason: null,
    algorithm: observation.algorithm,
    keySize: observation.keySize ?? null,
    keySizeSource: (observation.evidence["keySizeSource"] as string | undefined) ?? null,
    location: observation.location,
  };
}
