import { test, expect, type Page } from "@playwright/test";

/**
 * D7 — docs/Claude/03-features.md §D7, docs/Claude/06-cisa-dashboard.md §"Row 5".
 *
 * The claim under test is not "a chart renders". It is that the panel
 * distinguishes three things a security dashboard normally blurs together:
 *
 *   1. what was measured,
 *   2. what is projected from it, and
 *   3. what is not known at all.
 *
 * So most of these assertions are about wording, and about the *absence* of a
 * reassuring reading — the same discipline the coverage-meter journeys in
 * `ui-journey.spec.ts` apply to D3, on the time axis instead of the surface one.
 */

/**
 * The `beforeEach` stats stub in `ui-journey.spec.ts` is per-file, so this file
 * carries its own. `totalReposScanned` is included because the Dashboard's
 * platform-stats block reads it once any project is in scope, and the page
 * throws without it — the trap that spec documents at length.
 */
const dashboardStats = {
  totalReposScanned: 2,
  totalVulnerabilitiesFound: 6,
  totalLinesScanned: 4200,
  totalCommunityPosts: 0,
  totalMigrationsAssisted: 0,
  mostCommonAlgorithm: "RSA",
  recentActivity: [],
};

const NOW = "2026-08-14T09:00:00.000Z";

const FRAMING =
  "Q-Day scenarios are regulatory deadlines drawn from draft NIST guidance (IR 8547 ipd) and CNSA 2.0, not predictions about when a quantum computer will exist. Compliance dates bind before physics does.";

const SCENARIOS = [
  { name: "conservative", qDayYear: 2030, rationale: "Aligns with the NIST IR 8547 draft deprecation of 112-bit classical cryptography.", confidence: "needs-check" },
  { name: "central", qDayYear: 2035, rationale: "Aligns with the NIST IR 8547 draft 'disallowed after' date and the CNSA 2.0 end state.", confidence: "needs-check" },
  { name: "aggressive", qDayYear: 2040, rationale: "Slower-than-expected quantum hardware scaling.", confidence: "needs-check" },
];

type Counts = { conservative: number; central: number; aggressive: number };

/**
 * The projected branch, generated rather than pasted — it is one point per
 * calendar year out to the last scenario, and fifteen literal objects would
 * bury the assertions. The observed points below are written out in full,
 * because those are the measurements under test.
 */
function projectedPoints(breaches: Counts, present: number, pqc: number) {
  const points = [];
  for (let year = 2027; year <= 2040; year += 1) {
    points.push({
      kind: "projected",
      year,
      at: `${year}-01-01T00:00:00.000Z`,
      assetsKnown: present,
      assetsPresent: present,
      pqcAssets: pqc,
      hygieneAssets: present - pqc,
      unmappedAssets: 0,
      // Runway is consumed scenario by scenario: everything breaches the
      // conservative Q-Day of 2030 first, the central one next, the aggressive
      // one last. That ordering is the whole shape of the projection.
      breachedByScenario: {
        conservative: year >= 2028 ? breaches.conservative : 0,
        central: year >= 2033 ? breaches.central : 0,
        aggressive: year >= 2038 ? breaches.aggressive : 0,
      },
    });
  }
  return points;
}

const PROJECTED_ASSUMPTION =
  "Projection, not measurement. It holds the inventory exactly as it stands today and advances only the clock, so it shows when today's assets fall out of compliance if nothing is migrated and nothing new is introduced. Neither of those will be true.";

const CERTIFICATE_EXPIRY_CAVEAT =
  "Counts certificates this inventory currently holds, on their own stated notAfter. A certificate whose expiry we could not read is reported as undetermined and never as expiring safely. Retired certificates are excluded, so this is what the estate has now rather than everything it ever had — and it says nothing about certificates nobody has submitted.";

/** No certificates submitted at all — the panel must say so rather than print zeroes. */
const NO_CERTIFICATES = {
  certificates: 0,
  withKnownExpiry: 0,
  undetermined: 0,
  perScenario: SCENARIOS.map((s) => ({
    scenario: s.name,
    qDayYear: s.qDayYear,
    outlivesQDay: 0,
    expiresBeforeQDay: 0,
    undetermined: 0,
  })),
  caveat: CERTIFICATE_EXPIRY_CAVEAT,
};

const NOT_COLLECTED = [
  // The certificate-expiry refusal used to be the first entry here. It was
  // removed with G-22: B4 shipped, `notAfter` travels on the asset, and the
  // panel now computes the row instead of declining to. What remains is the
  // one refusal that is still true.
  {
    id: "asset-refresh-cycle",
    label: "Renewal cycles remaining before each deadline",
    reason:
      "Not available. Nothing records how often an asset is refreshed, so the number of renewal cycles left before a deadline — the figure that goes negative for OT estates — cannot be computed from anything held.",
  },
];

const MIGRATION_BASIS =
  "Y is zero for every asset: no collector records a migration effort estimate against an asset yet, so these verdicts are decided entirely by X against Z. A real Y can only move them earlier, never later.";

/**
 * An estate with no collection run at all. Every field here is exactly what
 * `summarisePostureTimeline` returns for empty inputs.
 */
const emptyTimeline = {
  generatedAt: NOW,
  now: NOW,
  framing: FRAMING,
  scenarios: SCENARIOS,
  estate: { projects: [], unassociatedAssets: 0, totalAssets: 0, presentAssets: 0 },
  observed: {
    sufficientForTrend: false,
    reason:
      "Nothing has been collected yet, so there is no history and no posture to plot. This is an empty inventory, not a clean one.",
    distinctCollectionInstants: 0,
    observedSpanDays: null,
    firstObservedAt: null,
    lastObservedAt: null,
    completedRuns: 0,
    failedRuns: 2,
    points: [],
  },
  projected: { assumption: PROJECTED_ASSUMPTION, basisAt: NOW, points: projectedPoints({ conservative: 0, central: 0, aggressive: 0 }, 0, 0) },
  deadlines: [],
  inputs: {
    secrecyLifetime: { bySource: {}, assumedForAssets: 0, bases: [] },
    migrationYears: { defaultValue: 0, assetsWithRecordedEffort: 0, basis: MIGRATION_BASIS },
  },
  certificateExpiry: NO_CERTIFICATES,
  notCollected: NOT_COLLECTED,
};

/** One scan. A measurement exists; a history does not. */
const singleScanTimeline = {
  ...emptyTimeline,
  estate: {
    projects: [{ id: 7, name: "payment-gateway", assets: 1, presentAssets: 1 }],
    unassociatedAssets: 0,
    totalAssets: 1,
    presentAssets: 1,
  },
  observed: {
    sufficientForTrend: false,
    reason:
      "One collection run. There is no history to draw — a line needs two measurements, and drawing one through a single point would assert a trend nobody has observed. Scan again to establish a second.",
    distinctCollectionInstants: 1,
    observedSpanDays: null,
    firstObservedAt: "2026-08-11T09:00:00.000Z",
    lastObservedAt: "2026-08-11T09:00:00.000Z",
    completedRuns: 1,
    failedRuns: 0,
    points: [
      {
        kind: "observed",
        at: "2026-08-11T09:00:00.000Z",
        assetsKnown: 1,
        assetsPresent: 1,
        pqcAssets: 1,
        hygieneAssets: 0,
        unmappedAssets: 0,
        breachedByScenario: { conservative: 0, central: 0, aggressive: 0 },
        collectionRunIds: [1],
        surfaces: ["source"],
        assetsAdded: 1,
      },
    ],
  },
  projected: { assumption: PROJECTED_ASSUMPTION, basisAt: NOW, points: projectedPoints({ conservative: 1, central: 1, aggressive: 1 }, 1, 1) },
  inputs: {
    secrecyLifetime: {
      bySource: { default: 1 },
      assumedForAssets: 1,
      bases: [
        "Assumed, not supplied: no classification was set on this asset or its project, so QuantaXscan's default of Internal (3 years) was used.",
      ],
    },
    migrationYears: { defaultValue: 0, assetsWithRecordedEffort: 0, basis: MIGRATION_BASIS },
  },
};

/**
 * Three real collection instants across two projects, one asset gone, one TLS
 * asset with no project, and two IR 8547 deadlines. Reproduced from what
 * `summarisePostureTimeline` actually returns for that estate rather than
 * hand-tuned, so the panel's arithmetic and the server's cannot disagree here
 * and still pass.
 */
const populatedTimeline = {
  generatedAt: NOW,
  now: NOW,
  framing: FRAMING,
  scenarios: SCENARIOS,
  estate: {
    projects: [
      { id: 7, name: "payment-gateway", assets: 4, presentAssets: 3 },
      { id: 12, name: "ot-historian", assets: 2, presentAssets: 2 },
    ],
    unassociatedAssets: 1,
    totalAssets: 7,
    presentAssets: 6,
  },
  observed: {
    sufficientForTrend: true,
    reason:
      "3 collection instants span 182 days. Each point is one examination of the estate; the line steps between them because nothing was measured in between.",
    distinctCollectionInstants: 3,
    observedSpanDays: 182,
    firstObservedAt: "2026-02-10T09:00:00.000Z",
    lastObservedAt: "2026-08-11T09:00:00.000Z",
    completedRuns: 4,
    failedRuns: 1,
    points: [
      {
        kind: "observed",
        at: "2026-02-10T09:00:00.000Z",
        assetsKnown: 3, assetsPresent: 3, pqcAssets: 3, hygieneAssets: 0, unmappedAssets: 0,
        breachedByScenario: { conservative: 0, central: 0, aggressive: 0 },
        collectionRunIds: [1], surfaces: ["source"], assetsAdded: 3,
      },
      {
        kind: "observed",
        at: "2026-05-12T09:00:00.000Z",
        assetsKnown: 6, assetsPresent: 6, pqcAssets: 5, hygieneAssets: 1, unmappedAssets: 0,
        breachedByScenario: { conservative: 2, central: 2, aggressive: 2 },
        collectionRunIds: [2, 3], surfaces: ["dependency", "source"], assetsAdded: 3,
      },
      {
        kind: "observed",
        at: "2026-08-11T09:00:00.000Z",
        assetsKnown: 7, assetsPresent: 6, pqcAssets: 5, hygieneAssets: 1, unmappedAssets: 0,
        breachedByScenario: { conservative: 2, central: 2, aggressive: 2 },
        collectionRunIds: [4], surfaces: ["source"], assetsAdded: 1,
      },
    ],
  },
  projected: { assumption: PROJECTED_ASSUMPTION, basisAt: NOW, points: projectedPoints({ conservative: 5, central: 5, aggressive: 5 }, 6, 5) },
  deadlines: [
    {
      id: "NIST-IR-8547|deprecated|2031-01-01T00:00:00.000Z||112 bits",
      type: "deprecated", label: "Deprecated", effect: "caution",
      effectiveFrom: "2031-01-01T00:00:00.000Z", year: 2031, inEffect: false,
      appliesTo: null, securityStrength: "112 bits",
      framework: "NIST-IR-8547",
      frameworkName: "Transition to Post-Quantum Cryptography Standards",
      requirement: "RSA at 112 bits of security strength is deprecated after 2030 under NIST IR 8547.",
      citation: { document: "NIST IR 8547 ipd", section: "Table 2", url: "https://nvlpubs.nist.gov/nistpubs/ir/2024/NIST.IR.8547.ipd.pdf" },
      confidence: "verified", draftStatus: "INITIAL PUBLIC DRAFT",
      algorithms: ["ECDH/DH", "ECDSA", "RSA"], assets: 5, caveats: [],
    },
    {
      id: "NIST-IR-8547|disallowed|2036-01-01T00:00:00.000Z||>= 128 bits",
      type: "disallowed", label: "Disallowed", effect: "prohibition",
      effectiveFrom: "2036-01-01T00:00:00.000Z", year: 2036, inEffect: false,
      appliesTo: null, securityStrength: ">= 128 bits",
      framework: "NIST-IR-8547",
      frameworkName: "Transition to Post-Quantum Cryptography Standards",
      requirement: "RSA at >= 128 bits of security strength is disallowed after 2035 under NIST IR 8547.",
      citation: { document: "NIST IR 8547 ipd", section: "Table 2", url: "https://nvlpubs.nist.gov/nistpubs/ir/2024/NIST.IR.8547.ipd.pdf" },
      confidence: "verified", draftStatus: "INITIAL PUBLIC DRAFT",
      algorithms: ["ECDH/DH", "ECDSA", "RSA"], assets: 5, caveats: [],
    },
  ],
  inputs: {
    secrecyLifetime: {
      bySource: { default: 4, project: 2 },
      assumedForAssets: 6,
      bases: [
        "Assumed, not supplied: inherited from the project default of Regulated, 25 years.",
        "Assumed, not supplied: no classification was set on this asset or its project, so QuantaXscan's default of Internal (3 years) was used.",
      ],
    },
    migrationYears: { defaultValue: 0, assetsWithRecordedEffort: 0, basis: MIGRATION_BASIS },
  },
  certificateExpiry: NO_CERTIFICATES,
  notCollected: NOT_COLLECTED,
};

async function openTimeline(page: Page, timeline: unknown, projects: unknown[]) {
  await page.route("**/api/stats*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dashboardStats) }),
  );
  await page.route("**/api/projects", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(projects) }),
  );
  await page.route("**/api/projects/*/findings", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  // The Overview tab mounts first and its D3 meter dereferences `confidence`
  // unconditionally, so a hollow `{}` here blanks the whole page before the tab
  // bar ever renders. A well-formed empty meter keeps this file's failures
  // about D7.
  await page.route("**/api/projects/*/coverage", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        projectId: 7,
        generatedAt: NOW,
        examinedSurfaces: 1,
        totalSurfaces: 10,
        surfaces: [],
        confidence: {
          basis: "latest observation per active asset",
          scored: 0, unscored: 0, excludedByAssetStatus: {}, distinctValues: 0,
          min: null, max: null, mean: null,
          buckets: [
            { label: "0.0–0.2", lower: 0, upper: 0.2, count: 0 },
            { label: "0.2–0.4", lower: 0.2, upper: 0.4, count: 0 },
            { label: "0.4–0.6", lower: 0.4, upper: 0.6, count: 0 },
            { label: "0.6–0.8", lower: 0.6, upper: 0.8, count: 0 },
            { label: "0.8–1.0", lower: 0.8, upper: 1, count: 0 },
          ],
        },
      }),
    }),
  );
  await page.route("**/api/inventory/timeline", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(timeline) }),
  );

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Security Intelligence" })).toBeVisible({ timeout: 10000 });
  // The tab bar is wrapped in an entrance animation that re-runs whenever the
  // project list resolves, which detaches the button mid-click. Let the page's
  // own fetches settle first so there is only one render left to animate.
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Timeline" }).click();
}

test.describe("D7 — the estate posture timeline", () => {
  test("states that there is no history rather than drawing an empty one", async ({ page }) => {
    await openTimeline(page, emptyTimeline, []);

    await expect(page.getByTestId("timeline-no-history")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("No history to draw.")).toBeVisible();
    // The server's sentence, printed verbatim. "Empty, not clean" is the whole
    // distinction — a zeroed chart would say the opposite.
    await expect(page.getByText(/This is an empty inventory, not a clean one/i)).toBeVisible();

    // The regression guard. None of the reassuring readings may appear: no
    // breach counts, no scrubber, no chart at all.
    await expect(page.getByText(/assets breach/i)).toHaveCount(0);
    await expect(page.getByTestId("timeline-frame")).toHaveCount(0);
    await expect(page.getByRole("slider")).toHaveCount(0);
    await expect(page.locator("svg[role='img']")).toHaveCount(0);

    // A failed attempt is reported, and reported as not being coverage.
    await expect(page.getByText(/2 collection attempts failed, and a failed attempt is not an examination/i)).toBeVisible();

    // The mandated framing travels with the scenarios wherever they are shown.
    await expect(page.getByText(/not predictions about when a quantum computer will exist/i)).toBeVisible();
  });

  test("refuses to draw a trend through a single measurement, but still shows the measurement", async ({ page }) => {
    await openTimeline(page, singleScanTimeline, []);

    await expect(page.getByTestId("timeline-no-trend")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("No trend — there is not enough history yet.")).toBeVisible();
    await expect(page.getByText(/a line needs two measurements/i)).toBeVisible();

    // No observed line is drawn. This is the assertion that stops a future
    // change from quietly joining one point to itself, or to the projection,
    // and calling the result a trend.
    await expect(page.getByTestId("observed-series")).toHaveCount(0);

    // The measurement itself is not hidden — it is real, and suppressing it
    // would be its own kind of dishonesty.
    const frame = page.getByTestId("timeline-frame");
    await expect(frame).toBeVisible();
    await expect(frame.getByText("Observed", { exact: true })).toBeVisible();
    await expect(frame.getByText("11 Aug 2026")).toBeVisible();

    // And X's provenance is stated next to the verdict it produced.
    await expect(page.getByText(/X assumed rather than supplied for/i)).toBeVisible();
    await expect(page.getByText(/QuantaXscan's default of Internal \(3 years\) was used/i)).toBeVisible();
  });

  test("plots three real collection instants, scrubs into the projection, and dates every obligation", async ({ page }) => {
    await openTimeline(page, populatedTimeline, [
      { id: 7, name: "payment-gateway", language: "python", riskScore: 62, totalScans: 3, criticalCount: 2, alertCount: 1, cleanCount: 40, createdAt: "2026-02-01T09:00:00.000Z", lastScanAt: "2026-08-11T09:00:00.000Z" },
    ]);

    // ── the observed half ──
    await expect(page.getByTestId("timeline-frame")).toBeVisible({ timeout: 10000 });
    // With three instants a line is drawn — one per scenario, never blended.
    await expect(page.getByTestId("observed-series")).toHaveCount(3);
    await expect(page.getByTestId("timeline-no-trend")).toHaveCount(0);

    // The scrubber opens on the newest *measurement*, not on the projection.
    const frame = page.getByTestId("timeline-frame");
    await expect(frame.getByText("Observed", { exact: true })).toBeVisible();
    await expect(frame.getByText("11 Aug 2026")).toBeVisible();
    await expect(frame.getByText(/6 assets in inventory · 5 quantum-vulnerable · 1 classical hygiene/)).toBeVisible();
    await expect(frame.getByText(/1 collection run on source/)).toBeVisible();

    // All three scenarios, each with its own count and its own Q-Day.
    await expect(page.getByText(/conservative · Q-Day 2030/i)).toBeVisible();
    await expect(page.getByText(/central · Q-Day 2035/i)).toBeVisible();
    await expect(page.getByText(/aggressive · Q-Day 2040/i)).toBeVisible();
    await expect(frame.getByText("of 6 assets breach")).toHaveCount(3);

    // ── scrub backwards to an earlier measurement ──
    const scrub = page.getByRole("slider");
    await expect(scrub).toBeVisible();
    // The handle's position is a frame index, which announces as a meaningless
    // number. `aria-valuetext` is what a screen-reader user actually hears, so
    // it has to carry the instant and the per-scenario counts, not "15 of 17".
    await expect(scrub).toHaveAttribute(
      "aria-valuetext",
      /^Observed 11 Aug 2026: 6 assets, 2 breaching under conservative, .* under aggressive$/,
    );
    await scrub.focus();
    await page.keyboard.press("Home");
    await expect(frame.getByText("10 Feb 2026")).toBeVisible();
    await expect(frame.getByText(/3 assets in inventory/)).toBeVisible();
    await expect(frame.getByText(/3 assets entered the inventory here/)).toBeVisible();
    // Still a measurement, at every step. Keyboard scrubbing is the whole
    // interaction for anyone not using a mouse.
    await expect(frame.getByText("Observed", { exact: true })).toBeVisible();

    // ── scrub forward into the projection ──
    await page.keyboard.press("End");
    await expect(frame.getByText("Projected", { exact: true })).toBeVisible();
    await expect(frame.getByText("1 Jan 2040")).toBeVisible();
    // A projected frame must restate its assumption, every time, in the frame
    // itself — not once in a footnote the reader has already scrolled past.
    await expect(frame.getByText(/Projection, not measurement/i)).toBeVisible();
    await expect(frame.getByText(/advances only the clock/i)).toBeVisible();
    await expect(frame.getByText("Observed", { exact: true })).toHaveCount(0);

    // ── deadlines, resolved by the mapping engine ──
    // Scoped to the list: each year is deliberately drawn twice, once as an
    // axis rule on the chart and once as a row here.
    const rows = page.getByTestId("deadline-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("2031");
    await expect(rows.nth(0)).toContainText("Deprecated");
    await expect(rows.nth(1)).toContainText("2036");
    await expect(rows.nth(1)).toContainText("Disallowed");
    // Both rows cover five assets, and name which algorithms produced them.
    await expect(rows.nth(1)).toContainText("ECDH/DH, ECDSA, RSA");
    // A draft is labelled as a draft wherever its dates are quoted.
    await expect(rows.nth(0)).toContainText("INITIAL PUBLIC DRAFT");
    await expect(rows.nth(0)).toContainText("NIST-IR-8547");
    // Two rules can land on the same year and differ only in key strength.
    await expect(rows.nth(0)).toContainText("keyed on 112 bits");
    await expect(rows.nth(1)).toContainText("keyed on >= 128 bits");
    // Every claim drills to a source an auditor can open.
    await expect(rows.nth(0).getByRole("link", { name: "source" })).toHaveAttribute(
      "href",
      /nvlpubs\.nist\.gov/,
    );

    // ── the estate roll-up, across projects rather than one repo ──
    await expect(page.getByText("payment-gateway").first()).toBeVisible();
    await expect(page.getByText("ot-historian")).toBeVisible();
    await expect(page.getByText(/3 present · 1 historical/)).toBeVisible();
    // Assets with no project are counted, not dropped.
    await expect(page.getByText("Not associated with a project")).toBeVisible();

    // ── the inputs behind the verdicts ──
    await expect(page.getByText(/X assumed rather than supplied for/i)).toBeVisible();
    await expect(page.getByText(/inherited from the project default of Regulated, 25 years/i)).toBeVisible();
    await expect(page.getByText(/no collector records a migration effort estimate/i)).toBeVisible();

    // ── and what it will not compute ──
    // Certificate expiry is no longer on this list — it is computed (G-22).
    // What remains is the refusal that is still true.
    await expect(page.getByText("Renewal cycles remaining before each deadline")).toBeVisible();
    await expect(page.getByText(/no certificate collector has shipped/i)).toHaveCount(0);
  });

  test("counts certificates against each Q-Day scenario, and names the ones it could not date (G-22)", async ({
    page,
  }) => {
    // Four certificates: two datable, two not. The panel must show all three
    // populations — an undetermined certificate folded into "expires first"
    // would be the reassuring answer, and the wrong one.
    const withCertificates = {
      ...populatedTimeline,
      certificateExpiry: {
        certificates: 4,
        withKnownExpiry: 2,
        undetermined: 2,
        perScenario: SCENARIOS.map((s, i) => ({
          scenario: s.name,
          qDayYear: s.qDayYear,
          outlivesQDay: i === 0 ? 2 : 1,
          expiresBeforeQDay: i === 0 ? 0 : 1,
          undetermined: 2,
        })),
        caveat: CERTIFICATE_EXPIRY_CAVEAT,
      },
    };

    await openTimeline(page, withCertificates, []);

    await expect(page.getByText("Certificates against Q-Day")).toBeVisible();

    // One row per scenario, never a single blended number: the answer depends
    // entirely on which Q-Day year the reader accepts.
    const scenarios = page.getByTestId("certificate-expiry-scenarios").locator("li");
    await expect(scenarios).toHaveCount(SCENARIOS.length);
    for (const scenario of SCENARIOS) {
      await expect(page.getByTestId("certificate-expiry-scenarios")).toContainText(scenario.name);
      await expect(page.getByTestId("certificate-expiry-scenarios")).toContainText(String(scenario.qDayYear));
    }

    // The bucket that makes the panel honest, in words rather than a footnote.
    await expect(page.getByTestId("certificate-expiry-undetermined")).toContainText(
      "2 with an expiry we could not read",
    );

    // And the caveat is on the page, not in a tooltip.
    await expect(page.getByText(/never as expiring safely/i)).toBeVisible();
  });

  test("says an empty certificate inventory is empty rather than printing a reassuring zero (G-22)", async ({
    page,
  }) => {
    // An estate that *has* been collected from and holds no certificates —
    // which is the real case, since a wholly empty estate renders a
    // configuration panel instead of this one.
    await openTimeline(page, populatedTimeline, []);

    // Zero certificates outliving Q-Day, when zero certificates have been
    // submitted, is a true number that reads as a clean estate. The panel has
    // to say which it is.
    await expect(page.getByTestId("certificate-expiry-empty")).toContainText(
      "not a statement that the estate has none",
    );
    await expect(page.getByTestId("certificate-expiry-scenarios")).toHaveCount(0);
  });

  test("reports a failed read instead of an empty timeline", async ({ page }) => {
    await page.route("**/api/stats*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dashboardStats) }),
    );
    await page.route("**/api/projects", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );
    await page.route("**/api/inventory/timeline", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }),
    );

    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Security Intelligence" })).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: "Timeline" }).click();

    await expect(page.getByText(/Timeline could not be read/i)).toBeVisible({ timeout: 10000 });
    // "We could not ask" and "there is nothing there" are different answers,
    // and a failed read must not be rendered as the second one.
    await expect(page.getByText(/No history to draw/i)).toHaveCount(0);
    await expect(page.getByRole("slider")).toHaveCount(0);
    await expect(page.getByText(/assets breach/i)).toHaveCount(0);
  });
});
