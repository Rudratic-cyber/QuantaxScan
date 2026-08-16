/**
 * E1 and E2 — the board pack and the regulator submission, generated end to end
 * against the real stack: real PostgreSQL, real row-level security, the real
 * API server, and a real headless Chromium printing the real HTML.
 *
 * This is the file the outstanding M2 exit criterion turns on
 * (docs/Claude/02-roadmap.md): *"Board pack PDF generates end-to-end from real
 * inventory data."* Every document below is built from assets a collector
 * actually wrote in response to a request this spec made. Nothing is fixtured;
 * `page.route` does not appear here, per `support/fixtures.ts`'s one rule.
 *
 * What would fail if E1/E2 regressed, in order of how quietly it would land:
 *
 *  1. **A number implying completeness.** `estateFraction` becoming a
 *     percentage, or a cost figure that reads as the cost of migrating the
 *     estate. Asserted directly, on the real payload.
 *  2. **Provenance missing from an auditor-facing document.** An asset with no
 *     collector, version, timestamp or confidence, and no note saying so.
 *  3. **An unverified obligation presented as a compliance claim**, or a
 *     citation with no retrieval date going unremarked.
 *  4. **A pack served to an anonymous caller.** These routes are deliberately
 *     not under `/reports/...`, where `PUBLIC_ROUTES`' share-link regex would
 *     have matched them. The anonymity test is the one that proves it.
 *  5. **The PDF step silently degrading to 503.** Asserted as 200 and `%PDF-`,
 *     not as "200 or 503" — accepting the fallback would leave the M2 criterion
 *     open while the suite went green.
 *
 * **Estate-scoped by construction.** Both packs read the whole organisation,
 * the suite runs `workers: 1` against one shared database, and nineteen other
 * specs write into it. So nothing below asserts an absolute estate count; the
 * assertions are either structural invariants or filtered to
 * `project:${projectId}:`. `17-continuity.spec.ts` records what happens when
 * that discipline slips.
 */
import { test, expect } from "./support/fixtures";

type APIRequestContext = import("@playwright/test").APIRequestContext;

interface CoverageLimitations {
  statement: string;
  examinedSurfaces: number;
  totalSurfaces: number;
  unexaminedSurfaces: Array<{ id: string; name: string; catalogueStatus: string; reason: string }>;
  estateFraction: null;
  estateFractionReason: string;
  failedRuns: number;
  assetsWithoutObservation: number;
  caveats: string[];
  unmappedAlgorithms?: string[];
}

interface ReportHeader {
  generatedAt: string;
  inventoryAsOf: string | null;
  mappingDataVersion: string;
  frameworksDataVersion: string;
  asOf: string;
  scenarios: Array<{ name: string; qDayYear: number; rationale: string; confidence: string }>;
  framing: string;
  collectors: Array<{
    collector: string;
    collectorVersion: string;
    surface: string;
    completedRuns: number;
    failedRuns: number;
    lastRunAt: string | null;
    observations: number;
  }>;
  productVersion: string | null;
  coverageSummary: string;
}

interface BoardPack {
  kind: "board-pack";
  header: ReportHeader;
  page1: {
    exposure: {
      headline: string;
      assetsFound: number;
      quantumVulnerableAssets: number;
      assetsAlreadyTooLate: number;
      classicalHygieneAssets: number;
      unassessableAssets: number;
    };
    timing: {
      headline: string;
      scenarios: Array<{
        scenario: string;
        qDayYear: number;
        assetsBreached: number;
        worstOvershootYears: number | null;
        confidence: string;
      }>;
      framing: string;
    };
    cost: {
      currency: string;
      hourlyRate: number;
      hourlyRateAssumed: boolean;
      estimatedHours: number;
      estimatedCost: number;
      assetsCosted: number;
      assetsWithRecordedEffort: number;
      assetsWithDerivedEffort: number;
      assetsWithoutEffortEstimate: number;
      statement: string;
    };
    trend: { sufficient: boolean; verdict: string; distinctCollectionInstants: number; basis: string };
    coverage: CoverageLimitations;
  };
  appendices: Array<{ id: string; title: string; summary: string; rows: unknown[]; notes: string[] }>;
  assumptions: Array<{ id: string; label: string; value: string; basis: string; assumed: boolean }>;
}

interface RegulatorObligation {
  framework: string;
  requirement: string;
  confidence: string;
  draftStatus: string | null;
  citation: { document: string; section: string | null; url: string; retrievedAt: string | null };
  citationRetrievalDateMissing: boolean;
}

interface RegulatorAsset {
  fingerprint: string;
  surface: string;
  algorithm: string;
  keySize: number | null;
  keySizeNote: string | null;
  location: string;
  status: string;
  provenance: {
    collector: string | null;
    collectorVersion: string | null;
    observedAt: string | null;
    confidence: number | null;
    discoveryModality: string | null;
    observations: number;
    note: string | null;
  };
  classification: { secrecyLifetimeYears: number; source: string; assumed: boolean };
  mosca: { x: number; y: number; applicable: boolean; breachedScenarios: string[] };
  obligations: RegulatorObligation[];
  indicativeObligations: RegulatorObligation[];
  standardsDataEntry: boolean;
}

interface RegulatorSubmission {
  kind: "regulator-submission";
  header: ReportHeader;
  coverageLimitations: CoverageLimitations;
  scope: {
    assetsIncluded: number;
    statusCounts: Record<string, number>;
    assetsExcluded: number;
    exclusionBasis: string;
  };
  complianceClaimSummary: {
    verifiedObligations: number;
    indicativeObligations: number;
    obligationsMissingRetrievalDate: number;
    indicativeLabel: string;
  };
  inventory: RegulatorAsset[];
  exceptions: {
    registerAvailable: boolean;
    statement: string;
    waivers: Array<{ justification: string; signedOffBy: string; attribution: string; expiresAt: string }>;
    statusWaivedWithoutRegisterEntry: unknown[];
    removedAssets: number;
  };
  methodology: { collectors: unknown[]; discoveryModalities: unknown[]; confidenceBasis: string; limitations: string[] };
  integrity: { digestAlgorithm: string; digest: string; signed: boolean; statement: string };
}

const unique = (label: string): string => `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** RSA and ECDH are quantum-vulnerable; MD5 is a classical defect and must not be counted as one. */
const SOURCE = [
  "from Crypto.PublicKey import RSA",
  "from cryptography.hazmat.primitives.asymmetric import ec",
  "import hashlib",
  "",
  "key = RSA.generate(2048)",
  "shared = ec.ECDH()",
  "digest = hashlib.md5(payload).hexdigest()",
].join("\n");

/** Creates a project and puts real assets in the inventory by running a real scan. */
async function seedInventory(api: APIRequestContext, label: string): Promise<number> {
  const created = await api.post("/api/projects", {
    data: { name: unique(label), language: "python", code: SOURCE },
  });
  expect(created.status()).toBe(201);
  const projectId = ((await created.json()) as { id: number }).id;

  const scan = await api.post("/api/scans", {
    data: { projectId, mode: "scan-only", code: SOURCE, language: "python" },
  });
  expect(scan.status()).toBe(201);
  return projectId;
}

async function boardPack(api: APIRequestContext): Promise<BoardPack> {
  const response = await api.get("/api/report-packs/board");
  expect(response.status()).toBe(200);
  return (await response.json()) as BoardPack;
}

async function regulatorSubmission(api: APIRequestContext): Promise<RegulatorSubmission> {
  const response = await api.get("/api/report-packs/regulator");
  expect(response.status()).toBe(200);
  return (await response.json()) as RegulatorSubmission;
}

test.describe("E1 — the board pack", () => {
  test("is generated from assets a collector actually wrote, not from anything this test supplied", async ({ api }) => {
    const projectId = await seedInventory(api, "e1-board");

    const inventory = (await (await api.get("/api/inventory/assets")).json()) as {
      assets: Array<{ location: string; algorithm: string }>;
    };
    const mine = inventory.assets.filter((a) => a.location.startsWith(`project:${projectId}:`));
    expect(mine.length, "the scan must have produced assets for the pack to describe").toBeGreaterThan(0);

    const pack = await boardPack(api);
    expect(pack.kind).toBe("board-pack");
    // Estate-wide by construction, so this is `>=` rather than an equality: the
    // suite shares one database and other specs seed into it.
    expect(pack.page1.exposure.assetsFound).toBeGreaterThanOrEqual(mine.length);
    expect(pack.header.inventoryAsOf).not.toBeNull();
    expect(pack.header.collectors.length).toBeGreaterThan(0);
    expect(pack.header.collectors.every((c) => c.collectorVersion !== "")).toBe(true);
    expect(pack.header.mappingDataVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("never states a share of the estate, and puts the surfaces it never looked at on page one", async ({ api }) => {
    await seedInventory(api, "e1-coverage");
    const coverage = (await boardPack(api)).page1.coverage;

    expect(coverage.estateFraction).toBeNull();
    expect(coverage.estateFractionReason).toMatch(/no share of the estate is stated/i);
    expect(coverage.examinedSurfaces).toBeLessThan(coverage.totalSurfaces);
    expect(coverage.unexaminedSurfaces.length).toBeGreaterThan(0);
    expect(coverage.statement).toMatch(/not a statement that the remainder of the estate is clean/);
    // Never a percentage anywhere in the coverage block — the one number that
    // would be read as completeness.
    expect(JSON.stringify(coverage)).not.toMatch(/\d+%/);
  });

  test("quotes the cost with its rate and hours inline, and refuses the estate reading", async ({ api }) => {
    await seedInventory(api, "e1-cost");
    const cost = (await boardPack(api)).page1.cost;

    expect(cost.hourlyRateAssumed).toBe(true);
    expect(cost.statement).toContain(`${cost.hourlyRate} ${cost.currency}/hr`);
    expect(cost.statement).toContain(`${cost.estimatedHours} est. hours`);
    expect(cost.statement).toMatch(/not of migrating the estate/);
    expect(cost.estimatedHours).toBeGreaterThan(0);
    expect(cost.estimatedCost).toBe(Math.round(cost.estimatedHours * cost.hourlyRate));
    // Arithmetic a reader can check: the total covers exactly the assets it says it does.
    expect(cost.assetsCosted).toBe(cost.assetsWithRecordedEffort + cost.assetsWithDerivedEffort);
  });

  test("reports a trend only when there is something to compare against", async ({ api }) => {
    await seedInventory(api, "e1-trend");
    const trend = (await boardPack(api)).page1.trend;

    // The count is estate-wide and other specs contribute runs, so the
    // assertion is the *rule* rather than a literal: baseline below two
    // distinct instants, measured at or above, and never "0% change".
    expect(trend.sufficient).toBe(trend.distinctCollectionInstants >= 2);
    expect(trend.verdict).toBe(trend.sufficient ? "measured" : "baseline");
    expect(trend.basis).not.toMatch(/0%/);
    if (!trend.sufficient) expect(trend.basis).toMatch(/nothing to compare against/);
  });

  test("splits post-quantum exposure from classical hygiene, and answers every scenario", async ({ api }) => {
    await seedInventory(api, "e1-tracks");
    const page1 = (await boardPack(api)).page1;

    // The scan seeded MD5 alongside RSA and ECDH, so both tracks are non-empty.
    expect(page1.exposure.quantumVulnerableAssets).toBeGreaterThan(0);
    expect(page1.exposure.classicalHygieneAssets).toBeGreaterThan(0);
    expect(page1.exposure.quantumVulnerableAssets + page1.exposure.classicalHygieneAssets).toBeLessThanOrEqual(
      page1.exposure.assetsFound,
    );

    expect(page1.timing.scenarios).toHaveLength(3);
    for (const scenario of page1.timing.scenarios) {
      expect(scenario.assetsBreached, scenario.scenario).toBeLessThanOrEqual(page1.exposure.quantumVulnerableAssets);
      expect(scenario.confidence, scenario.scenario).toBe("needs-check");
    }
    expect(page1.timing.framing).toMatch(/not predictions/i);
  });

  test("names no algorithm on page one and names them all in the appendices", async ({ api }) => {
    const projectId = await seedInventory(api, "e1-page-one");

    const inventory = (await (await api.get("/api/inventory/assets")).json()) as {
      assets: Array<{ location: string; algorithm: string }>;
    };
    const mine = [
      ...new Set(inventory.assets.filter((a) => a.location.startsWith(`project:${projectId}:`)).map((a) => a.algorithm)),
    ];
    expect(mine.length).toBeGreaterThan(1);

    const pack = await boardPack(api);
    const page1 = JSON.stringify(pack.page1);
    const appendices = JSON.stringify(pack.appendices);

    for (const algorithm of mine) {
      expect(page1, `"${algorithm}" reached page one`).not.toContain(algorithm);
      expect(appendices, `"${algorithm}" is missing from the appendices`).toContain(algorithm);
    }
  });

  test("renders to a self-contained HTML page", async ({ api }) => {
    await seedInventory(api, "e1-html");
    const response = await api.get("/api/report-packs/board.html");

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/html");
    const html = await response.text();
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("Coverage — read this before any number below");
    expect(html, "a saved report must not depend on a host still existing").not.toMatch(/<(script|link)\b/);
  });

  test("prints a real PDF — the M2 exit criterion", async ({ api }) => {
    await seedInventory(api, "e1-pdf");
    const response = await api.get("/api/report-packs/board.pdf");

    // 200, not "200 or 503". Accepting the documented HTML fallback here would
    // leave the criterion open while this suite went green.
    expect(response.status(), "the board pack must actually print").toBe(200);
    expect(response.headers()["content-type"]).toContain("application/pdf");
    expect(response.headers()["content-disposition"]).toContain("attachment");

    const body = await response.body();
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(body.length, "a PDF this small is an error page, not a document").toBeGreaterThan(5_000);
    // A PDF that never terminated is a truncated stream, not a report.
    expect(body.subarray(-1024).toString("latin1")).toContain("%%EOF");
  });

  test("an anonymous caller reaches none of it", async ({ publicApi }) => {
    for (const path of ["/api/report-packs/board", "/api/report-packs/board.html", "/api/report-packs/board.pdf"]) {
      expect((await publicApi.get(path)).status(), path).toBe(401);
    }
  });
});

test.describe("E2 — the regulator submission", () => {
  test("gives every asset an answer to \"says who?\"", async ({ api }) => {
    const projectId = await seedInventory(api, "e2-provenance");
    const submission = await regulatorSubmission(api);

    expect(submission.kind).toBe("regulator-submission");
    const mine = submission.inventory.filter((a) => a.location.startsWith(`project:${projectId}:`));
    expect(mine.length).toBeGreaterThan(0);

    for (const asset of mine) {
      expect(asset.provenance.collector, asset.location).not.toBeNull();
      expect(asset.provenance.collectorVersion, asset.location).not.toBeNull();
      expect(asset.provenance.observedAt, asset.location).not.toBeNull();
      expect(asset.provenance.confidence, asset.location).toBeGreaterThan(0);
      expect(asset.provenance.discoveryModality, asset.location).not.toBeNull();
      expect(asset.provenance.observations, asset.location).toBeGreaterThan(0);
    }

    // Estate-wide, the invariant is weaker but still absolute: either the
    // provenance is there, or a note says why it is not.
    for (const asset of submission.inventory) {
      expect(asset.provenance.collector !== null || asset.provenance.note !== null, asset.fingerprint).toBe(true);
    }
  });

  test("carries a citation on every claim and keeps unverified obligations out of them", async ({ api }) => {
    await seedInventory(api, "e2-citations");
    const submission = await regulatorSubmission(api);

    let claims = 0;
    for (const asset of submission.inventory) {
      for (const obligation of asset.obligations) {
        claims += 1;
        expect(obligation.confidence, obligation.requirement).toBe("verified");
        expect(obligation.citation.url, obligation.requirement).toMatch(/^https?:\/\//);
        expect(obligation.citationRetrievalDateMissing).toBe(obligation.citation.retrievedAt === null);
      }
      for (const obligation of asset.indicativeObligations) {
        expect(obligation.confidence, obligation.requirement).not.toBe("verified");
      }
    }
    expect(claims, "the submission must actually make claims for this to prove anything").toBeGreaterThan(0);
    expect(submission.complianceClaimSummary.verifiedObligations).toBe(claims);
    expect(submission.complianceClaimSummary.indicativeLabel).toMatch(/pending verification/i);
  });

  test("pins the standards data version and states the coverage limits before the inventory", async ({ api }) => {
    await seedInventory(api, "e2-pinning");
    const submission = await regulatorSubmission(api);

    expect(submission.header.mappingDataVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(submission.header.asOf).toBe(submission.header.generatedAt);
    expect(Object.keys(submission).indexOf("coverageLimitations")).toBeLessThan(
      Object.keys(submission).indexOf("inventory"),
    );
    expect(submission.coverageLimitations.estateFraction).toBeNull();
    expect(submission.coverageLimitations.unexaminedSurfaces.length).toBeGreaterThan(0);
    expect(submission.scope.exclusionBasis).toMatch(/must not list cryptography that has been removed/);
    expect(submission.inventory.every((a) => a.status !== "gone")).toBe(true);
  });

  test("reports the waiver register it actually operates, and calls its digest a digest", async ({ api }) => {
    await seedInventory(api, "e2-integrity");
    const submission = await regulatorSubmission(api);

    // This asserted `false` until C8 shipped, and nothing failed when that
    // became untrue — a regulator-facing document asserting the absence of a
    // feature the product operates is invisible to every other suite.
    expect(submission.exceptions.registerAvailable).toBe(true);
    expect(submission.exceptions.statement).toMatch(/operates a waiver register/);
    expect(submission.exceptions.statement).toMatch(/A waiver suppresses nothing in this document/);

    expect(submission.integrity.signed).toBe(false);
    expect(submission.integrity.digestAlgorithm).toBe("SHA-256");
    expect(submission.integrity.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(submission.integrity.statement).toMatch(/is not a signature/);

    expect(submission.methodology.limitations.join(" ")).toMatch(/pattern-based/);
    expect(submission.methodology.collectors.length).toBeGreaterThan(0);
  });

  test("renders and prints", async ({ api }) => {
    await seedInventory(api, "e2-render");

    const html = await api.get("/api/report-packs/regulator.html");
    expect(html.status()).toBe(200);
    const markup = await html.text();
    expect(markup).toContain("Coverage limitations");
    expect(markup).toContain("Exceptions and waivers");
    expect(markup).toContain("is not a signature");

    const pdf = await api.get("/api/report-packs/regulator.pdf");
    expect(pdf.status()).toBe(200);
    const body = await pdf.body();
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(body.subarray(-1024).toString("latin1")).toContain("%%EOF");
  });

  test("an anonymous caller reaches none of it", async ({ publicApi }) => {
    for (const path of [
      "/api/report-packs/regulator",
      "/api/report-packs/regulator.html",
      "/api/report-packs/regulator.pdf",
    ]) {
      expect((await publicApi.get(path)).status(), path).toBe(401);
    }
  });

  test("is not reachable through the public share-link route", async ({ publicApi }) => {
    // `GET /reports/:id` is public by design, matched by `/^\/reports\/[^/]+$/`.
    // A pack mounted under `/reports/...` would have been served anonymously.
    // This asserts the near-miss stays a near-miss.
    for (const path of ["/api/reports/board", "/api/reports/regulator", "/api/reports/board.pdf"]) {
      const response = await publicApi.get(path);
      expect(response.status(), path).toBe(404);
      const body = await response.text();
      expect(body, `${path} must not leak a pack through the share-link route`).not.toContain("board-pack");
      expect(body).not.toContain("regulator-submission");
    }
  });
});
