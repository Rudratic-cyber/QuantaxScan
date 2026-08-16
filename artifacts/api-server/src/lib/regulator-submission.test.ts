import { describe, it, expect } from "vitest";
import { summariseRegulatorSubmission } from "./regulator-submission";
import { renderRegulatorSubmissionHtml } from "./report-html";
import { contentDigest } from "./report-common";
import { buildReportInput } from "./report-input-fixture";

/**
 * E2 — the regulator / auditor inventory submission.
 * docs/Claude/07-reports.md §"E2".
 *
 * The audience is someone who will try to find holes, so the tests are written
 * as the holes they would look for, in order of how badly each would land:
 *
 *  1. **A `needs-check` obligation presented as a compliance claim.** doc 07
 *     says only `verified` mappings may appear. The split is asserted in both
 *     directions — nothing indicative in `obligations`, and nothing verified
 *     silently demoted out of it.
 *  2. **An asset with no answer to "says who?".** Provenance is asserted
 *     present for every asset, and an asset with no observation is asserted to
 *     carry an explicit note rather than nulls a reader could mistake for zero.
 *  3. **A citation with no retrieval date, unremarked.** Asserted as a counted
 *     field, so the document discloses it rather than leaving a blank.
 *  4. **A hand-set `waived` status counted as an approved exception.** Since C8
 *     the register exists, so the hole moved rather than closing: a status
 *     somebody set by hand carries no justification, signatory or expiry, and
 *     listing it beside real waivers would present four missing fields as
 *     present. Asserted as two separate lists, and asserted that an expired
 *     waiver is in neither.
 *  5. **A digest described as a signature.** Asserted false, in the field and
 *     in the words.
 */

const ESTATE = [
  { algorithm: "RSA", surface: "source", keySize: 2048 },
  { algorithm: "ECDSA", surface: "tls", location: "tls:api.example.test:443", keySize: null },
  { algorithm: "SHA-1", surface: "source" },
];

const RUNS = [
  { collector: "source-regex", collectorVersion: "2.1.0", surface: "source", startedAt: "2026-08-15T00:00:00.000Z" },
];

describe("E2 — the regulator submission", () => {
  it("gives every asset a collector, a version, a timestamp and a confidence", () => {
    const submission = summariseRegulatorSubmission(buildReportInput({ assets: ESTATE, runs: RUNS }));

    expect(submission.inventory.length).toBe(3);
    for (const asset of submission.inventory) {
      expect(asset.provenance.collector, asset.fingerprint).toBe("source-regex");
      expect(asset.provenance.collectorVersion, asset.fingerprint).toBe("2.1.0");
      expect(asset.provenance.observedAt, asset.fingerprint).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(asset.provenance.confidence, asset.fingerprint).toBeGreaterThan(0);
      expect(asset.provenance.discoveryModality, asset.fingerprint).toBe("static_artifact_analysis");
      expect(asset.provenance.observations, asset.fingerprint).toBeGreaterThan(0);
      expect(asset.provenance.note, asset.fingerprint).toBeNull();
    }
  });

  it("says out loud when an asset has no observation behind it", () => {
    const submission = summariseRegulatorSubmission(
      buildReportInput({ assets: [{ algorithm: "RSA", surface: "source", observation: null }], runs: RUNS }),
    );
    const asset = submission.inventory[0];

    expect(asset.provenance.collector).toBeNull();
    expect(asset.provenance.confidence).toBeNull();
    expect(asset.provenance.observations).toBe(0);
    expect(asset.provenance.note).toMatch(/No observation record backs this asset/);
    expect(submission.coverageLimitations.assetsWithoutObservation).toBe(1);
    expect(submission.coverageLimitations.caveats.join(" ")).toMatch(/carry no observation record/);
  });

  it("keeps unverified obligations out of the claims and labels them where they do appear", () => {
    const input = buildReportInput({ assets: ESTATE, runs: RUNS });
    const submission = summariseRegulatorSubmission(input);

    // Exhaustive, not just filtered: every obligation the engine resolved for
    // an asset lands in exactly one of the two lists. A split that silently
    // dropped the third state would pass a per-list check and lose evidence.
    const resolved = new Map(input.assets.map((a) => [a.fingerprint, a.compliance?.obligations.length ?? 0]));
    for (const asset of submission.inventory) {
      expect(asset.obligations.length + asset.indicativeObligations.length, asset.algorithm).toBe(
        resolved.get(asset.fingerprint),
      );
    }

    for (const asset of submission.inventory) {
      for (const obligation of asset.obligations) {
        expect(obligation.confidence, `${asset.algorithm}: ${obligation.requirement}`).toBe("verified");
      }
      for (const obligation of asset.indicativeObligations) {
        expect(obligation.confidence, `${asset.algorithm}: ${obligation.requirement}`).not.toBe("verified");
      }
      // The two lists must be disjoint, not overlapping views of one list.
      const verifiedIds = asset.obligations.map((o) => `${o.framework}:${o.requirement}`);
      for (const obligation of asset.indicativeObligations) {
        expect(verifiedIds).not.toContain(`${obligation.framework}:${obligation.requirement}`);
      }
    }

    expect(submission.complianceClaimSummary.indicativeLabel).toMatch(/pending verification/i);
    expect(submission.complianceClaimSummary.verifiedObligations).toBeGreaterThan(0);
    expect(submission.complianceClaimSummary.verifiedObligations).toBe(
      submission.inventory.reduce((n, a) => n + a.obligations.length, 0),
    );
  });

  it("carries a citation with a retrieval date on every claim, and counts the ones without", () => {
    const submission = summariseRegulatorSubmission(buildReportInput({ assets: ESTATE, runs: RUNS }));

    let seen = 0;
    for (const asset of submission.inventory) {
      for (const obligation of [...asset.obligations, ...asset.indicativeObligations]) {
        seen += 1;
        expect(obligation.citation.url, obligation.requirement).toMatch(/^https?:\/\//);
        expect(obligation.citation.document, obligation.requirement).not.toBe("");
        expect(obligation.citationRetrievalDateMissing).toBe(obligation.citation.retrievedAt === null);
      }
    }
    expect(seen, "the fixture must actually resolve obligations for this to prove anything").toBeGreaterThan(0);
    expect(submission.complianceClaimSummary.obligationsMissingRetrievalDate).toBe(
      submission.inventory.reduce(
        (n, a) =>
          n +
          [...a.obligations, ...a.indicativeObligations].filter((o) => o.citationRetrievalDateMissing).length,
        0,
      ),
    );
  });

  it("pins the standards data version the obligations were resolved against", () => {
    const submission = summariseRegulatorSubmission(buildReportInput({ assets: ESTATE, runs: RUNS }));
    expect(submission.header.mappingDataVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(submission.header.asOf).toBe(submission.header.generatedAt);
  });

  it("states the coverage limitations before any inventory count", () => {
    const submission = summariseRegulatorSubmission(buildReportInput({ assets: ESTATE, runs: RUNS }));
    const keys = Object.keys(submission);

    expect(keys.indexOf("coverageLimitations")).toBeLessThan(keys.indexOf("inventory"));
    expect(keys.indexOf("coverageLimitations")).toBeLessThan(keys.indexOf("complianceClaimSummary"));
    expect(submission.coverageLimitations.estateFraction).toBeNull();
    expect(submission.coverageLimitations.unexaminedSurfaces.length).toBeGreaterThan(0);
  });

  it("does not count a hand-set waived status as an approved exception", () => {
    const submission = summariseRegulatorSubmission(
      buildReportInput({
        assets: [
          { algorithm: "RSA", surface: "source", status: "waived" },
          { algorithm: "ECDSA", surface: "source" },
        ],
        runs: RUNS,
      }),
    );

    expect(submission.exceptions.registerAvailable).toBe(true);
    expect(submission.exceptions.statement).toMatch(/operates a waiver register/);
    // A status somebody set by hand is not an approved exception, and the two
    // must not share a list — merging them presents four missing fields as
    // present.
    expect(submission.exceptions.waivers).toHaveLength(0);
    expect(submission.exceptions.statusWaivedWithoutRegisterEntry).toHaveLength(1);
    expect(submission.exceptions.statusWaivedWithoutRegisterEntry[0].algorithm).toBe("RSA");
  });

  it("reports a register entry with its justification, signatory and expiry", () => {
    const submission = summariseRegulatorSubmission(
      buildReportInput({
        now: new Date("2026-08-16T09:00:00.000Z"),
        assets: [
          {
            algorithm: "RSA",
            surface: "source",
            waiver: {
              justification: "Vendor appliance; replacement contracted for Q1.",
              signedOffBy: "ciso@example.test",
              signedOffByUserId: "u_ciso",
              signedOffAt: "2026-08-10T00:00:00.000Z",
              expiresAt: "2026-12-01T00:00:00.000Z",
            },
          },
          { algorithm: "ECDSA", surface: "source" },
        ],
        runs: RUNS,
      }),
    );

    expect(submission.exceptions.waivers).toHaveLength(1);
    expect(submission.exceptions.waivers[0].justification).toMatch(/Vendor appliance/);
    expect(submission.exceptions.waivers[0].signedOffBy).toBe("ciso@example.test");
    expect(submission.exceptions.waivers[0].attribution).toBe("authenticated");
    expect(submission.exceptions.waivers[0].expiresAt).toContain("2026-12-01");

    // The waived asset is still in the inventory. A waiver annotates; it never
    // filters — an estate that looks smaller because somebody accepted a risk
    // is the one thing this document may not do.
    expect(submission.inventory).toHaveLength(2);
  });

  it("does not present an expired waiver as an exception in force", () => {
    const submission = summariseRegulatorSubmission(
      buildReportInput({
        now: new Date("2026-08-16T09:00:00.000Z"),
        assets: [
          {
            algorithm: "RSA",
            surface: "source",
            status: "waived",
            waiver: {
              justification: "Expired last month and never renewed.",
              signedOffBy: "ciso@example.test",
              signedOffAt: "2026-06-01T00:00:00.000Z",
              expiresAt: "2026-07-15T00:00:00.000Z",
            },
          },
        ],
        runs: RUNS,
      }),
    );

    // Passed to the summariser unfiltered, so this asserts the expiry rule
    // itself rather than a `where expires_at > now()` somebody wrote twice.
    expect(submission.exceptions.waivers).toHaveLength(0);
    expect(submission.exceptions.statusWaivedWithoutRegisterEntry).toHaveLength(1);
  });

  it("says an asserted signatory is asserted, because a printed page cannot show the difference", () => {
    const submission = summariseRegulatorSubmission(
      buildReportInput({
        now: new Date("2026-08-16T09:00:00.000Z"),
        assets: [
          {
            algorithm: "RSA",
            surface: "source",
            waiver: {
              justification: "Signed off through the shared key.",
              signedOffBy: "somebody@example.test",
              signedOffByUserId: null,
              signedOffAt: "2026-08-10T00:00:00.000Z",
              expiresAt: "2026-12-01T00:00:00.000Z",
            },
          },
        ],
        runs: RUNS,
      }),
    );

    expect(submission.exceptions.waivers[0].attribution).toBe("asserted");
    expect(renderRegulatorSubmissionHtml(submission)).toContain("asserted, not authenticated");
  });

  it("calls a digest a digest, not a signature", () => {
    const submission = summariseRegulatorSubmission(buildReportInput({ assets: ESTATE, runs: RUNS }));
    expect(submission.integrity.signed).toBe(false);
    expect(submission.integrity.digestAlgorithm).toBe("SHA-256");
    expect(submission.integrity.statement).toMatch(/is not a signature/);
    expect(submission.integrity.statement).toMatch(/nothing about origin/);
  });

  it("produces the same digest for the same document and a different one for a changed asset", () => {
    const now = new Date("2026-08-16T09:00:00.000Z");
    const a = summariseRegulatorSubmission(buildReportInput({ now, assets: ESTATE, runs: RUNS }));
    const b = summariseRegulatorSubmission(buildReportInput({ now, assets: ESTATE, runs: RUNS }));

    // Fingerprints are allocated per fixture asset, so the two runs differ by
    // identity alone; the inventory below is what must move the digest.
    const stripIdentity = (submission: typeof a) => ({
      ...submission,
      inventory: submission.inventory.map((asset) => ({ ...asset, fingerprint: "", location: "" })),
      exceptions: { ...submission.exceptions, waivers: [], statusWaivedWithoutRegisterEntry: [] },
    });

    expect(contentDigest(stripIdentity(a))).toBe(contentDigest(stripIdentity(b)));

    const c = summariseRegulatorSubmission(
      buildReportInput({ now, assets: [...ESTATE, { algorithm: "DSA", surface: "source" }], runs: RUNS }),
    );
    expect(contentDigest(stripIdentity(c))).not.toBe(contentDigest(stripIdentity(a)));
  });

  it("orders the inventory deterministically, so an unchanged estate produces an identical document", () => {
    const submission = summariseRegulatorSubmission(buildReportInput({ assets: ESTATE, runs: RUNS }));
    const fingerprints = submission.inventory.map((a) => a.fingerprint);
    expect(fingerprints).toEqual([...fingerprints].sort());
  });

  it("records an undetermined key size as undetermined rather than defaulting it", () => {
    const submission = summariseRegulatorSubmission(buildReportInput({ assets: ESTATE, runs: RUNS }));
    const undetermined = submission.inventory.find((a) => a.keySize === null);

    expect(undetermined, "the fixture must contain one for this to prove anything").toBeDefined();
    expect(undetermined!.keySizeNote).toMatch(/could not determine a key size/);
    expect(undetermined!.keySizeNote).toMatch(/not.*defaulted/i);
  });

  it("keeps removed assets out of the inventory while leaving the exclusion checkable", () => {
    const submission = summariseRegulatorSubmission(
      buildReportInput({ assets: ESTATE, runs: RUNS, goneAssets: 2 }),
    );

    expect(submission.scope.assetsIncluded).toBe(3);
    expect(submission.scope.assetsExcluded).toBe(2);
    expect(submission.scope.statusCounts["gone"]).toBe(2);
    expect(submission.exceptions.removedAssets).toBe(2);
    expect(submission.inventory.every((a) => a.status !== "gone")).toBe(true);
    expect(submission.scope.exclusionBasis).toMatch(/must not list cryptography that has been removed/);
  });

  it("names the limits of its own detection in the methodology", () => {
    const submission = summariseRegulatorSubmission(buildReportInput({ assets: ESTATE, runs: RUNS }));
    const limitations = submission.methodology.limitations.join(" ");

    expect(limitations).toMatch(/pattern-based/);
    expect(limitations).toMatch(/false positives/);
    expect(limitations).toMatch(/submission-based rather than credentialed/);
    expect(limitations).toMatch(/resolved at read time/);
    expect(submission.methodology.collectors).toHaveLength(1);
    expect(submission.methodology.discoveryModalities[0]).toMatchObject({ modality: "static_artifact_analysis" });
  });

  it("renders every claim with its citation and marks the indicative ones in the rendering too", () => {
    const submission = summariseRegulatorSubmission(buildReportInput({ assets: ESTATE, runs: RUNS }));
    const html = renderRegulatorSubmissionHtml({
      ...submission,
      integrity: { ...submission.integrity, digest: contentDigest(submission) },
    });

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("Coverage limitations");
    expect(html).toContain("Exceptions and waivers");
    expect(html).toContain("Methodology");
    expect(html).toContain("Says who");
    expect(html).toContain("is not a signature");
    for (const asset of submission.inventory) {
      expect(html).toContain(asset.fingerprint);
      for (const obligation of asset.obligations) {
        expect(html).toContain(obligation.citation.url);
      }
      if (asset.indicativeObligations.length > 0) {
        expect(html).toContain(submission.complianceClaimSummary.indicativeLabel);
      }
    }
    expect(html, "an external reference makes a saved submission depend on a host still existing").not.toMatch(
      /<(script|link)\b/,
    );
  });
});
