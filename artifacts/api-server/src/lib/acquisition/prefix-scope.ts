import type { DiscoveryScope, EnumerationRecord } from "@workspace/collectors";

/**
 * §4.5 — the highest-consequence decision in credentialed collection, as a
 * pure function.
 *
 * > A credentialed run earns a prefix reobservation scope for scope `S` **if and
 * > only if** `S` appears in `enumerated`, `truncated` is `false`, and no entry
 * > in `refused` overlaps `S`. Under any other condition it falls back to a
 * > `locations` scope over exactly what it read.
 *
 * ## What is actually at stake
 *
 * A prefix scope is what lets an ingest mark an asset `gone`. Getting it wrong
 * in the permissive direction is the worst failure available in this codebase:
 * a throttled second page of `ListKeys`, silently treated as a complete
 * enumeration, retires every key it did not see, and the drift feed reports a
 * **mass remediation nobody performed**. `assets` rows are updated in place and
 * never deleted, so the data is recoverable — but the board pack generated the
 * next morning is not.
 *
 * So this function is written to be *reluctant*. Every condition it checks is a
 * reason to fall back, and the fallback (`locations`, covering exactly what was
 * read) is always safe: it reactivates what was seen and touches nothing else.
 * The cost of being wrong that way is a key that stays on the books after it
 * was genuinely deleted — a stale row somebody notices, rather than a fabricated
 * remediation nobody does.
 *
 * ## Why it lives in its own file
 *
 * Because the argument above is only as good as its test. A rule embedded in a
 * route is a rule exercised through HTTP; a pure function over a record can be
 * asked directly what it does with a truncated page, and that is the case that
 * matters.
 */

/**
 * Does a refusal overlap an enumerated scope?
 *
 * Deliberately **coarse**: any refusal touching the same provider and account
 * disqualifies every scope in that account, even one whose region enumerated
 * cleanly. That is stricter than the letter of §4.5 needs, and the asymmetry is
 * the point — an over-strict overlap check costs a stale row, an under-strict
 * one costs a fabricated remediation. When the two errors are that unequal, the
 * conservative reading is the correct one, not merely the safe one.
 *
 * The concrete case: `AccessDenied` on `ap-south-1` frequently means the
 * credential's policy does not cover it, which says nothing reassuring about
 * whether `eu-west-1`'s listing was complete either — it is the same policy.
 */
function overlaps(a: DiscoveryScope, b: DiscoveryScope): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "cloud_account":
      return b.kind === "cloud_account" && a.provider === b.provider && a.account === b.account;
    case "domain":
      return b.kind === "domain" && a.domain === b.domain;
    case "directory":
      return b.kind === "directory" && a.directory === b.directory;
    case "issuer":
      return b.kind === "issuer" && a.issuer === b.issuer;
  }
}

export interface PrefixScopeDecision {
  /** The prefixes a reobservation may retire against, or `null` when none were earned. */
  prefixes: string[] | null;
  /**
   * Why, in one sentence, for the response body. A caller that asked for a
   * complete enumeration and got a partial one should be able to read the
   * reason without inspecting the enumeration record.
   */
  reason: string;
}

/**
 * Decide the reobservation scope for a credentialed run.
 *
 * `prefixFor` turns an enumerated scope into the asset-location prefix that
 * scope's keys share. It is passed in rather than derived here because the
 * mapping is per surface — `<repo>:kms:aws:` for B5 — and this rule is not.
 */
export function earnedPrefixes(
  record: EnumerationRecord,
  prefixFor: (scope: DiscoveryScope) => string | null,
): PrefixScopeDecision {
  if (record.truncated) {
    return {
      prefixes: null,
      reason:
        "A pagination or safety ceiling was reached, so this run cannot claim to have seen every key. " +
        "Nothing was retired; only the keys actually read were reconciled.",
    };
  }
  if (record.enumerated.length === 0) {
    return {
      prefixes: null,
      reason: "No scope was fully enumerated, so this run reconciled only the keys it actually read.",
    };
  }

  const clean = record.enumerated.filter((e) => !record.refused.some((r) => overlaps(r.scope, e.scope)));
  if (clean.length === 0) {
    return {
      prefixes: null,
      reason:
        "Every enumerated scope shares an account with a scope that was refused, so none of them can be " +
        "treated as complete. Only the keys actually read were reconciled.",
    };
  }

  const prefixes = clean.flatMap((e) => {
    const prefix = prefixFor(e.scope);
    return prefix === null ? [] : [prefix];
  });

  if (prefixes.length === 0) {
    return {
      prefixes: null,
      reason: "No enumerated scope maps to an asset-location prefix, so only the keys actually read were reconciled.",
    };
  }

  return {
    prefixes,
    reason:
      `${prefixes.length} scope(s) were enumerated completely, so a key absent from this run has genuinely ` +
      `been removed from the key store and is recorded as gone.`,
  };
}
