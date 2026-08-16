import { describe, it, expect } from "vitest";
import { summariseBoardPack } from "./board-pack";
import { renderBoardPackHtml } from "./report-html";
import { buildReportInput } from "./report-input-fixture";

/**
 * E1 — the board pack. docs/Claude/07-reports.md §"E1".
 *
 * What would fail if this feature regressed, in order of how quietly it would
 * land:
 *
 *  1. **A percentage of the estate appears on page one.** The single worst
 *     failure available to this product: a number nothing we hold supports,
 *     printed where a board reads it as coverage. `estateFraction` is asserted
 *     null, with its reason, and the unexamined surfaces are asserted present.
 *  2. **An asset with no effort estimate is costed at zero.** A silent
 *     understatement that makes the total read as complete. Asserted by giving
 *     the estate an algorithm the standards data does not know and checking it
 *     lands in `assetsWithoutEffortEstimate` rather than in the total.
 *  3. **A single collection reports a flat trend.** "0% change" asserts a
 *     comparison nobody made. Asserted against one instant and two.
 *  4. **A classical-hygiene defect inflates the post-quantum headline.** G-10 at
 *     board level. Asserted by mixing MD5 in and checking the counts split.
 *  5. **An algorithm name reaches page one.** The loudest of the five to a
 *     cryptographer and the quietest to everyone else. Asserted against every
 *     algorithm the input actually contains, so it cannot rot as the vocabulary
 *     grows — and the complement is asserted too, because dropping the names
 *     everywhere would pass a naive version of this check.
 */

const MIXED_ESTATE = [
  { algorithm: "RSA", surface: "source", keySize: 2048 },
  { algorithm: "RSA", surface: "tls", location: "tls:api.example.test:443" },
  { algorithm: "ECDH", surface: "config", location: "project:1:etc/ssh/sshd_config:12" },
  { algorithm: "MD5", surface: "source" },
  { algorithm: "SHA-1", surface: "source" },
];

const ONE_RUN = [
  { collector: "source-regex", collectorVersion: "2.1.0", surface: "source", startedAt: "2026-08-15T00:00:00.000Z" },
];

describe("E1 — the board pack", () => {
  it("states the coverage gap as surfaces and never as a share of the estate", () => {
    const pack = summariseBoardPack(buildReportInput({ assets: MIXED_ESTATE, runs: ONE_RUN }));
    const coverage = pack.page1.coverage;

    expect(coverage.estateFraction).toBeNull();
    expect(coverage.estateFractionReason).toMatch(/no share of the estate is stated/i);
    expect(coverage.examinedSurfaces).toBeLessThan(coverage.totalSurfaces);
    expect(coverage.unexaminedSurfaces.length).toBe(coverage.totalSurfaces - coverage.examinedSurfaces);
    expect(coverage.statement).toMatch(/never been examined/);
    expect(
      coverage.statement,
      "the coverage sentence must refuse the clean reading explicitly, not merely omit it",
    ).toMatch(/not a statement that the remainder of the estate is clean/);

    // The gap is on page one, which is where doc 07 puts it and where the
    // budget conversation starts.
    expect(Object.keys(pack.page1)).toContain("coverage");
  });

  it("names every unexamined catalogue surface, including ones a collector exists for", () => {
    const pack = summariseBoardPack(buildReportInput({ assets: MIXED_ESTATE, runs: ONE_RUN }));
    const unexamined = pack.page1.coverage.unexaminedSurfaces;

    // `vendor` has no collector at all; `certificate` has one that was never
    // run here. Both are unexamined and the reasons differ.
    expect(unexamined.map((s) => s.id)).toContain("vendor");
    expect(unexamined.find((s) => s.id === "vendor")!.reason).toMatch(/No collector exists/);
    expect(unexamined.map((s) => s.id)).toContain("certificate");
    expect(unexamined.find((s) => s.id === "certificate")!.reason).toMatch(/has not been run/);
  });

  it("keeps an algorithm the standards data does not know out of every figure, and says so", () => {
    const pack = summariseBoardPack(
      buildReportInput({
        // Not in the standards data, so nothing supports an effort number for
        // it — and nothing supports calling it quantum-vulnerable either. It
        // must not silently contribute 0 to the total, and it must not vanish:
        // `unassessableAssets` and a coverage caveat are where it surfaces.
        // (`assetsWithoutEffortEstimate` covers the narrower case of a mapped,
        // quantum-vulnerable algorithm whose entry carries no `baseEffortHours`
        // — that field is optional in the standards schema.)
        assets: [
          { algorithm: "RSA", surface: "source" },
          { algorithm: "Kyber-Dilithium-9000", surface: "source" },
        ],
        runs: ONE_RUN,
      }),
    );
    const cost = pack.page1.cost;

    expect(cost.assetsCosted).toBe(1);
    expect(cost.assetsWithDerivedEffort).toBe(1);
    expect(cost.assetsWithoutEffortEstimate).toBe(0); // unmapped ⇒ not quantum-vulnerable ⇒ not in scope
    expect(cost.estimatedHours).toBe(4);
    expect(pack.page1.exposure.unassessableAssets).toBe(1);
    expect(pack.page1.exposure.quantumVulnerableAssets).toBe(1);
    expect(
      pack.page1.coverage.caveats.join(" "),
      "an algorithm the standards data does not know must be disclosed, not dropped",
    ).toMatch(/no entry in the standards data/);
  });

  it("prefers an effort figure recorded against the asset over the algorithm's class average", () => {
    const pack = summariseBoardPack(
      buildReportInput({
        assets: [
          { algorithm: "RSA", surface: "source", effortHours: 40 },
          { algorithm: "RSA", surface: "source" },
        ],
        runs: ONE_RUN,
      }),
    );
    const cost = pack.page1.cost;

    expect(cost.assetsWithRecordedEffort).toBe(1);
    expect(cost.assetsWithDerivedEffort).toBe(1);
    expect(cost.estimatedHours).toBe(44); // 40 recorded + RSA's 4-hour base
  });

  it("states the rate inline and marks it assumed unless one was supplied", () => {
    const assumed = summariseBoardPack(buildReportInput({ assets: MIXED_ESTATE, runs: ONE_RUN }));
    expect(assumed.page1.cost.hourlyRateAssumed).toBe(true);
    expect(assumed.page1.cost.statement).toMatch(/at 500 USD\/hr assumed/);
    expect(assumed.page1.cost.statement).toMatch(/est\. hours/);
    expect(
      assumed.page1.cost.statement,
      "the currency figure must refuse the estate reading in the same sentence",
    ).toMatch(/not of migrating the estate/);
    expect(assumed.assumptions.find((a) => a.id === "hourly-rate")!.assumed).toBe(true);

    const supplied = summariseBoardPack(
      buildReportInput({ assets: MIXED_ESTATE, runs: ONE_RUN, hourlyRate: 95, currency: "GBP" }),
    );
    expect(supplied.page1.cost.hourlyRateAssumed).toBe(false);
    expect(supplied.page1.cost.statement).toMatch(/at 95 GBP\/hr supplied/);
  });

  it("refuses to relabel the default rate as another currency", () => {
    // A currency with no rate would print the documented USD number as GBP,
    // which is a lie about an amount rather than a formatting choice.
    const pack = summariseBoardPack(buildReportInput({ assets: MIXED_ESTATE, runs: ONE_RUN, currency: "GBP" }));
    expect(pack.page1.cost.currency).toBe("USD");
  });

  it("says baseline for one collection instant and measures only from two", () => {
    const one = summariseBoardPack(buildReportInput({ assets: MIXED_ESTATE, runs: ONE_RUN }));
    expect(one.page1.trend.sufficient).toBe(false);
    expect(one.page1.trend.verdict).toBe("baseline");
    expect(one.page1.trend.basis).not.toMatch(/0%/);
    expect(one.page1.trend.basis).toMatch(/nothing to compare against/);

    const two = summariseBoardPack(
      buildReportInput({
        assets: MIXED_ESTATE,
        runs: [
          ...ONE_RUN,
          {
            collector: "source-regex",
            collectorVersion: "2.1.0",
            surface: "source",
            startedAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(two.page1.trend.sufficient).toBe(true);
    expect(two.page1.trend.verdict).toBe("measured");
    expect(two.page1.trend.distinctCollectionInstants).toBe(2);
  });

  it("does not count a failed collection as an instant to trend against", () => {
    const pack = summariseBoardPack(
      buildReportInput({
        assets: MIXED_ESTATE,
        runs: [
          ...ONE_RUN,
          {
            collector: "tls",
            collectorVersion: "1.1.0",
            surface: "tls",
            status: "failed",
            startedAt: "2026-07-01T00:00:00.000Z",
            completedAt: null,
          },
        ],
      }),
    );
    expect(pack.page1.trend.distinctCollectionInstants).toBe(1);
    expect(pack.page1.trend.verdict).toBe("baseline");
    expect(pack.page1.coverage.failedRuns).toBe(1);
    expect(pack.page1.coverage.caveats.join(" ")).toMatch(/A failed attempt is not an examination/);
  });

  it("keeps classical hygiene out of the post-quantum headline", () => {
    const pack = summariseBoardPack(buildReportInput({ assets: MIXED_ESTATE, runs: ONE_RUN }));
    const exposure = pack.page1.exposure;

    expect(exposure.assetsFound).toBe(5);
    expect(exposure.quantumVulnerableAssets).toBe(3); // RSA, RSA, ECDH
    expect(exposure.classicalHygieneAssets).toBe(2); // MD5, SHA-1
    expect(exposure.quantumVulnerableAssets + exposure.classicalHygieneAssets).toBe(exposure.assetsFound);
  });

  it("answers the Mosca question per scenario rather than with a single date", () => {
    const pack = summariseBoardPack(
      buildReportInput({
        assets: [{ algorithm: "RSA", surface: "data-at-rest", dataClassification: "regulated" }],
        runs: [
          { collector: "data-at-rest", collectorVersion: "1.0.0", surface: "data-at-rest", startedAt: "2026-08-15T00:00:00.000Z" },
        ],
      }),
    );

    expect(pack.page1.timing.scenarios).toHaveLength(3);
    for (const scenario of pack.page1.timing.scenarios) {
      // A 25-year secrecy lifetime outlives every scenario year in the set.
      expect(scenario.assetsBreached, scenario.scenario).toBe(1);
      expect(scenario.worstOvershootYears, scenario.scenario).toBeGreaterThan(0);
      expect(scenario.confidence, "a scenario year the data does not verify must not be presented as settled").toBe(
        "needs-check",
      );
    }
    expect(pack.page1.timing.framing).toMatch(/not predictions/i);
  });

  it("prints no algorithm name anywhere on page one, and does print them in the appendices", () => {
    const input = buildReportInput({ assets: MIXED_ESTATE, runs: ONE_RUN });
    const pack = summariseBoardPack(input);

    const page1 = JSON.stringify(pack.page1);
    const algorithms = [...new Set(input.assets.map((a) => a.algorithm))];
    expect(algorithms.length, "the fixture must actually contain algorithms for this to prove anything").toBeGreaterThan(1);

    for (const algorithm of algorithms) {
      expect(page1, `"${algorithm}" reached page one, which a board reader cannot evaluate`).not.toContain(algorithm);
    }

    // The complement: dropping the names everywhere would satisfy the check
    // above while destroying the pack.
    const appendices = JSON.stringify(pack.appendices);
    for (const algorithm of algorithms) {
      expect(appendices, `"${algorithm}" is missing from the appendices`).toContain(algorithm);
    }

    // And the same rule against the artifact a board member actually holds.
    // The two checks are not the same: the *printed* first page is everything
    // before the first appendix's page break, which includes the provenance
    // header — and the header is not part of `page1`. It carries no algorithm
    // name today, but it is the one place a future field (`/stats` already
    // computes a `mostCommonAlgorithm`) could put one on the printed page with
    // the JSON check still green.
    const printedPageOne = renderBoardPackHtml(pack).split('class="page-break"')[0];
    expect(printedPageOne.length, "the split must actually find a page break").toBeLessThan(
      renderBoardPackHtml(pack).length,
    );
    for (const algorithm of algorithms) {
      expect(printedPageOne, `"${algorithm}" is printed on page one`).not.toContain(algorithm);
    }
  });

  it("pins the standards data version and refuses to invent a product version", () => {
    const pack = summariseBoardPack(buildReportInput({ assets: MIXED_ESTATE, runs: ONE_RUN }));
    expect(pack.header.mappingDataVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pack.header.frameworksDataVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pack.header.productVersion).toBeNull();
    expect(pack.header.collectors).toHaveLength(1);
    expect(pack.header.collectors[0]).toMatchObject({ collector: "source-regex", collectorVersion: "2.1.0" });
  });

  it("reports an empty inventory as having no instant rather than as being current", () => {
    const pack = summariseBoardPack(buildReportInput({ assets: [], runs: [] }));
    expect(pack.header.inventoryAsOf).toBeNull();
    expect(pack.page1.exposure.headline).toMatch(/No cryptography has been recorded/);
    expect(pack.page1.exposure.headline).toMatch(/says nothing about the/);
    expect(pack.page1.coverage.estateFraction).toBeNull();
  });

  it("renders to a self-contained HTML document with the coverage callout in it", () => {
    const html = renderBoardPackHtml(summariseBoardPack(buildReportInput({ assets: MIXED_ESTATE, runs: ONE_RUN })));

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("Coverage — read this before any number below");
    // A report is evidence: it has to render from a saved file with no network.
    expect(html, "an external reference makes a saved report depend on a host still existing").not.toMatch(
      /<(script|link)\b|https?:\/\/[^"']*\.(css|js)/,
    );
    expect(html).toContain("@page");
  });

  it("escapes an attacker-controllable location rather than emitting it as markup", () => {
    const html = renderBoardPackHtml(
      summariseBoardPack(
        buildReportInput({
          assets: [{ algorithm: "RSA", surface: "source", location: 'project:1:<img src=x onerror="alert(1)">:1' }],
          runs: ONE_RUN,
        }),
      ),
    );
    expect(html).not.toContain("<img src=x");
  });
});
