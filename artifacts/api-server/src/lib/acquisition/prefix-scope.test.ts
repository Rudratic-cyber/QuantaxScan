import { describe, it, expect } from "vitest";
import type { DiscoveryScope, EnumerationRecord } from "@workspace/collectors";
import { earnedPrefixes } from "./prefix-scope";

/**
 * §4.5 — the rule that decides whether a credentialed run may retire an asset.
 *
 * **This is the highest-consequence pure function in the credentialed path**,
 * and the failure it prevents is the worst one available in this codebase: a
 * throttled second page of `ListKeys`, silently treated as a complete
 * enumeration, retires every key it did not see and the drift feed reports a
 * mass remediation nobody performed. `assets` rows are updated in place rather
 * than deleted, so the data survives — the board pack generated the next
 * morning does not.
 *
 * Every test below is therefore written from the direction of *refusal*: the
 * question is never "does a clean run earn a prefix" (one test), it is "does
 * each way a run can be dirty take the prefix away" (the rest).
 */

const REPO = "project:1";

/** `<repo>:kms:aws:arn:aws:kms:<region>:<account>:` — region- and account-granular, per §4.5's second corollary. */
const prefixFor = (scope: DiscoveryScope): string | null =>
  scope.kind === "cloud_account" && scope.region !== undefined
    ? `${REPO}:kms:aws:arn:aws:kms:${scope.region}:${scope.account}:`
    : null;

const scope = (region: string, account = "111122223333"): DiscoveryScope => ({
  kind: "cloud_account",
  provider: "aws",
  account,
  region,
  service: "kms",
});

const record = (partial: Partial<EnumerationRecord>): EnumerationRecord => ({
  enumerated: [],
  refused: [],
  truncated: false,
  ...partial,
});

describe("earning a prefix reobservation scope (§4.5)", () => {
  it("grants one for a scope enumerated completely, with nothing refused and nothing truncated", () => {
    const decision = earnedPrefixes(record({ enumerated: [{ scope: scope("eu-west-1"), complete: true }] }), prefixFor);

    expect(decision.prefixes).toEqual(["project:1:kms:aws:arn:aws:kms:eu-west-1:111122223333:"]);
    expect(decision.reason).toMatch(/enumerated completely/);
  });

  it("keeps the prefix region-granular, so enumerating one region cannot retire another's keys", () => {
    const decision = earnedPrefixes(
      record({
        enumerated: [
          { scope: scope("eu-west-1"), complete: true },
          { scope: scope("us-east-1"), complete: true },
        ],
      }),
      prefixFor,
    );

    // Two prefixes, not one account-wide prefix. The whole point of §4.5's
    // second corollary: "enumerated the AWS account" does not license retiring
    // keys in a region that was never called.
    expect(decision.prefixes).toEqual([
      "project:1:kms:aws:arn:aws:kms:eu-west-1:111122223333:",
      "project:1:kms:aws:arn:aws:kms:us-east-1:111122223333:",
    ]);
  });

  it("REFUSES when the run was truncated, even though a scope reports as enumerated", () => {
    // The exact failure the rule exists for. A ceiling was hit, so the run has
    // not seen every key — and a scope marked complete before the ceiling was
    // reached must not rescue it.
    const decision = earnedPrefixes(
      record({ enumerated: [{ scope: scope("eu-west-1"), complete: true }], truncated: true }),
      prefixFor,
    );

    expect(decision.prefixes).toBeNull();
    expect(decision.reason).toMatch(/ceiling/);
  });

  it("REFUSES when a refusal shares an account with the enumerated scope, even in a different region", () => {
    // Deliberately stricter than §4.5's letter. An AccessDenied in one region
    // usually means the credential's policy does not cover it — which says
    // nothing reassuring about whether the other region's listing was complete
    // either, since it is the same policy.
    const decision = earnedPrefixes(
      record({
        enumerated: [{ scope: scope("eu-west-1"), complete: true }],
        refused: [{ scope: scope("ap-south-1"), reason: "access-denied" }],
      }),
      prefixFor,
    );

    expect(decision.prefixes).toBeNull();
    expect(decision.reason).toMatch(/refused/);
  });

  it("still grants one when the refusal belongs to a different account entirely", () => {
    // The strictness above is about a shared credential and a shared policy.
    // A different account is a different credential's problem, and letting it
    // veto here would make the rule refuse everything the moment a customer
    // polls two accounts.
    const decision = earnedPrefixes(
      record({
        enumerated: [{ scope: scope("eu-west-1", "111122223333"), complete: true }],
        refused: [{ scope: scope("eu-west-1", "999988887777"), reason: "access-denied" }],
      }),
      prefixFor,
    );

    expect(decision.prefixes).toEqual(["project:1:kms:aws:arn:aws:kms:eu-west-1:111122223333:"]);
  });

  it("REFUSES when nothing was enumerated, however many keys were read", () => {
    const decision = earnedPrefixes(
      record({ refused: [{ scope: scope("eu-west-1"), reason: "throttled" }] }),
      prefixFor,
    );

    expect(decision.prefixes).toBeNull();
    expect(decision.reason).toMatch(/No scope was fully enumerated/);
  });

  it("REFUSES when an enumerated scope maps to no prefix, rather than retiring against a guess", () => {
    // A scope shape this surface has no location family for. Falling back to a
    // broader prefix would be the permissive error; returning none is the safe
    // one, and the difference is a stale row versus a fabricated remediation.
    const decision = earnedPrefixes(
      record({ enumerated: [{ scope: { kind: "domain", domain: "acme.test" }, complete: true }] }),
      prefixFor,
    );

    expect(decision.prefixes).toBeNull();
  });

  it("gives a reason a client can print without inspecting the enumeration record", () => {
    // The same argument as B3's `evidenceCaveat` and D8's: a caveat a client
    // has to reconstruct is a caveat missing from the one report that matters.
    for (const decision of [
      earnedPrefixes(record({ truncated: true }), prefixFor),
      earnedPrefixes(record({}), prefixFor),
      earnedPrefixes(record({ enumerated: [{ scope: scope("eu-west-1"), complete: true }] }), prefixFor),
    ]) {
      expect(decision.reason.length).toBeGreaterThan(20);
      expect(decision.reason).toMatch(/\.$/);
    }
  });
});
