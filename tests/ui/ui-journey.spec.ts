import { test, expect } from "@playwright/test";
import { COLLECTOR_SURFACES } from "@workspace/collectors/surface-catalogue";

test.beforeEach(async ({ page }) => {
  // Provide clean default API route mocks so background fetches do not hang or block page renders
  await page.route("**/api/projects*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  );
  await page.route("**/api/stats*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ totalProjects: 0, totalScans: 0, totalFindings: 0 }) })
  );
  await page.route("**/api/demo/repos*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  );
  await page.route("**/api/community/posts*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  );
  await page.route("**/api/community/leaderboard*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  );
});

test.describe("UI Journey Tests", () => {
  test("home page renders main branding and CTA", async ({ page }) => {
    await page.goto("/");

    // Click backdrop or press Escape to skip intro screen overlay
    await page.mouse.click(100, 100);
    await page.keyboard.press("Escape");
    await page.locator('button:has-text("Skip intro")').waitFor({ state: "detached", timeout: 5000 }).catch(() => {});

    await expect(
      page.getByRole("heading", { name: /Know where your cryptography is/i })
    ).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Post-quantum migration starts with an inventory/i)).toBeVisible();
  });

  test("navigation reaches every page including Coverage and Security", async ({ page }) => {
    // 1. Home page
    await page.goto("/");
    await page.mouse.click(100, 100);
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL("/");

    // 2. Scan page
    await page.goto("/scan");
    await expect(page.getByRole("button", { name: /Upload Code/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /GitHub URL/i })).toBeVisible();

    // 3. Dashboard page
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Security Intelligence" })).toBeVisible();

    // 4. Community page
    await page.goto("/community");
    await expect(
      page.getByText(/Post questions, share migration stories, and learn from the community/i)
    ).toBeVisible();

    // 5. Coverage page
    await page.goto("/coverage");
    await expect(page.getByText(/What we look at — and what we don't/i)).toBeVisible();
    await expect(page.getByText(/Coverage/i).first()).toBeVisible();

    // 6. Security page
    await page.goto("/security");
    await expect(page.getByText(/We hold your crypto map/i)).toBeVisible();
    await expect(page.getByText(/Security/i).first()).toBeVisible();
  });

  test("a demo scan runs to completion and renders findings with NIST replacements", async ({ page }) => {
    // Mock demo repo list and demo scan execution specifically for this journey
    await page.route("**/api/demo/repos", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            slug: "paramiko-ssh",
            name: "paramiko/paramiko",
            description: "Python SSH library",
            language: "Python",
            stars: 9100,
            repoUrl: "https://github.com/paramiko/paramiko",
            fileCount: 4,
            riskScore: 85,
            criticalCount: 2,
            alertCount: 1,
          },
        ]),
      })
    );

    await page.route("**/api/demo/repos/paramiko-ssh/scan", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: -1,
          name: "paramiko/paramiko",
          language: "Python",
          riskScore: 85,
          totalLines: 500,
          criticalCount: 2,
          alertCount: 1,
          cleanCount: 497,
          totalEffortHours: 12,
          estimatedCost: 6000,
          executiveSummary: "Scanned paramiko repo and found RSA key generation.",
          files: [
            {
              path: "paramiko/transport.py",
              language: "python",
              lines: 100,
              criticalCount: 1,
              alertCount: 0,
              content: "key = RSA.generate(2048)",
              findings: [
                {
                  id: 1,
                  scanId: -1,
                  fileName: "paramiko/transport.py",
                  lineNumber: 36,
                  severity: "critical",
                  algorithm: "RSA-2048",
                  codeSnippet: "key = RSA.generate(2048)",
                  nistReplacement: "ML-KEM-768",
                  nistStandard: "NIST FIPS 203",
                  explanation: "RSA key generation is quantum vulnerable.",
                  effortHours: 8,
                },
              ],
            },
          ],
          findings: [
            {
              id: 1,
              scanId: -1,
              fileName: "paramiko/transport.py",
              lineNumber: 36,
              severity: "critical",
              algorithm: "RSA-2048",
              codeSnippet: "key = RSA.generate(2048)",
              nistReplacement: "ML-KEM-768",
              nistStandard: "NIST FIPS 203",
              explanation: "RSA key generation is quantum vulnerable.",
              effortHours: 8,
            },
          ],
        }),
      })
    );

    await page.goto("/demo/paramiko-ssh");

    // The scan must resolve before the findings panel exists at all — the file tree,
    // code viewer and findings panel only render once scanResult is set.
    await expect(page.getByText(/Scanned paramiko repo and found RSA key generation/i)).toBeVisible({
      timeout: 15000,
    });

    // Scan-derived summary metrics from the mocked scan response
    await expect(page.getByText("2 critical")).toBeVisible();
    await expect(page.getByText("12h to migrate")).toBeVisible();

    // The finding itself: algorithm, source line, snippet and its NIST replacement
    await expect(page.getByText("RSA-2048", { exact: true })).toBeVisible();
    await expect(page.getByText("L36", { exact: true })).toBeVisible();
    await expect(page.getByText("key = RSA.generate(2048)").first()).toBeVisible();
    await expect(page.getByText("ML-KEM-768", { exact: true })).toBeVisible();
    await expect(page.getByText("NIST FIPS 203", { exact: true })).toBeVisible();
  });

  test("the dashboard degrades gracefully when its data call returns 401", async ({ page }) => {
    // React Query retries a failed query three times with exponential backoff (1s + 2s + 4s)
    // before the error state settles, so this journey is legitimately slower than the default.
    test.setTimeout(60_000);

    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    // Override default mocks with 401 Unauthorized specifically for this degradation test
    await page.route("**/api/projects*", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Unauthorized" }),
      })
    );
    await page.route("**/api/stats*", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Unauthorized" }),
      })
    );

    await page.goto("/dashboard");

    // The Dashboard's own chrome still renders rather than crashing or hanging on a spinner.
    await expect(page.getByRole("heading", { name: "Security Intelligence" })).toBeVisible({
      timeout: 10000,
    });

    // A refused request is reported as a refusal. "No scans yet" would be a different claim
    // entirely — we did not learn that there are none, we failed to ask — and it used to send
    // the user to a scanner that cannot work either, a loop with no exit.
    await expect(
      page.getByRole("heading", { name: /Projects could not be loaded/i })
    ).toBeVisible({ timeout: 25000 });
    await expect(
      page.getByText(/The API refused the request, so we cannot tell whether you have any scans/i)
    ).toBeVisible();

    // The recovery action matches the cause: retry the call, not "run your first scan".
    await expect(page.getByRole("button", { name: /Try again/i })).toBeVisible();

    // The regression guard: the empty-state claim must not appear anywhere on an auth failure.
    await expect(page.getByText(/No scans yet/i)).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  });

  test("a report page renders a real report and handles an unknown identifier without a blank screen", async ({ page }) => {
    // 1. Real Report Rendering
    await page.route("**/api/reports/real-report-1", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "real-report-1",
          owner: "acme-corp",
          repo: "payment-gateway",
          repoUrl: "https://github.com/acme-corp/payment-gateway",
          data: {
            owner: "acme-corp",
            repo: "payment-gateway",
            repoUrl: "https://github.com/acme-corp/payment-gateway",
            totalFiles: 4,
            totalLines: 1250,
            criticalCount: 2,
            alertCount: 1,
            cleanCount: 1247,
            riskScore: 85,
            executiveSummary: "Scanned 1,250 lines of Python code and found quantum-critical vulnerabilities.",
            findings: [
              {
                fileName: "crypto_utils.py",
                lineNumber: 18,
                severity: "critical",
                algorithm: "RSA-1024",
                codeSnippet: "key = RSA.generate(1024)",
                nistReplacement: "ML-KEM-768",
                nistStandard: "NIST FIPS 203",
                explanation: "RSA-1024 is vulnerable to Shor's algorithm.",
                effortHours: 8,
              },
            ],
            fileResults: [],
          },
          createdAt: "2026-08-02T12:00:00Z",
        }),
      })
    );

    await page.goto("/report/real-report-1");
    await expect(page.getByText(/payment-gateway/i).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/RSA-1024/i).first()).toBeVisible();

    // Click finding card to expand details including NIST replacement
    await page.getByText(/RSA-1024/i).first().click();
    await expect(page.getByText(/ML-KEM-768/i).first()).toBeVisible();

    // 2. Unknown Identifier Error Handling
    await page.route("**/api/reports/unknown-id-999", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "Report not found" }),
      })
    );

    await page.goto("/report/unknown-id-999");
    await expect(page.getByText(/Report not found/i).first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator("body")).toBeVisible();
  });

  /**
   * D3 — docs/Claude/03-features.md §D3. The claim under test is not "a panel
   * renders", it is "the panel states the size of the blind spot". A coverage
   * meter that quietly drifts toward reassurance is the specific failure this
   * feature exists to prevent, so these assertions are mostly about wording and
   * about the *absence* of a comforting reading.
   */
  const coverageProject = {
    id: 7,
    name: "Coverage Subject",
    description: "",
    language: "python",
    riskScore: 62,
    lastScanAt: "2026-08-10T09:00:00.000Z",
    createdAt: "2026-08-01T09:00:00.000Z",
    totalScans: 1,
    criticalCount: 2,
    alertCount: 1,
    cleanCount: 40,
  };

  /**
   * The `beforeEach` stats stub is shaped for the empty-dashboard journeys and
   * omits `totalReposScanned`, which the Dashboard's platform-stats block reads
   * — and that block only renders once at least one project is in scope. Both
   * coverage journeys have a project, so they need the full shape or the page
   * throws before the meter is ever mounted.
   */
  const dashboardStats = {
    totalReposScanned: 1,
    totalVulnerabilitiesFound: 3,
    totalLinesScanned: 120,
    totalCommunityPosts: 0,
    totalMigrationsAssisted: 0,
    mostCommonAlgorithm: "RSA",
    recentActivity: [],
  };

  /**
   * Exactly what `summariseProjectCoverage` returns for one source scan plus a
   * dependency run that found nothing — including `examinedSurfaces: 2`, which
   * counts the empty run. Written to be reproducible by the real summariser
   * rather than hand-tuned, because the meter computes "how many were never
   * examined" two independent ways: the headline subtracts the server's
   * `examinedSurfaces` from `totalSurfaces`, while the per-surface pills come
   * from joining the client-side catalogue against `surfaces[]`. A payload
   * whose two halves disagreed would let one of those paths be wrong and still
   * pass, so this fixture keeps them consistent and the assertions check both
   * numbers (8 and 8) against it.
   */
  const coveragePayload = {
    projectId: 7,
    generatedAt: "2026-08-10T09:05:00.000Z",
    examinedSurfaces: 2,
    // From the catalogue, not restated. This fixture hardcoded 10 and went
    // stale the day three surfaces were added — and the mismatch surfaced here
    // rather than in the headline, because the pills come from the catalogue
    // join while the headline comes from the payload. That divergence is
    // exactly what this test exists to catch, so the fixture must track the
    // catalogue or the test starts failing for its own reasons.
    totalSurfaces: COLLECTOR_SURFACES.length,
    surfaces: [
      {
        surface: "source",
        surfaceId: "source",
        state: "examined",
        completedRuns: 3,
        failedRuns: 0,
        lastExaminedAt: "2026-08-10T09:00:00.000Z",
        assets: 5,
        activeAssets: 4,
      },
      {
        surface: "dependency",
        surfaceId: "dependency",
        state: "examined-nothing-found",
        completedRuns: 1,
        failedRuns: 2,
        lastExaminedAt: "2026-08-09T09:00:00.000Z",
        assets: 0,
        activeAssets: 0,
      },
    ],
    confidence: {
      basis: "latest observation per active asset",
      scored: 4,
      unscored: 0,
      excludedByAssetStatus: { gone: 1 },
      distinctValues: 1,
      min: 0.7,
      max: 0.7,
      mean: 0.7,
      buckets: [
        { label: "0.0–0.2", lower: 0, upper: 0.2, count: 0 },
        { label: "0.2–0.4", lower: 0.2, upper: 0.4, count: 0 },
        { label: "0.4–0.6", lower: 0.4, upper: 0.6, count: 0 },
        { label: "0.6–0.8", lower: 0.6, upper: 0.8, count: 4 },
        { label: "0.8–1.0", lower: 0.8, upper: 1, count: 0 },
      ],
    },
  };

  test("the dashboard coverage meter states how many surfaces were never examined", async ({ page }) => {
    // Registered after the beforeEach defaults, and Playwright matches the most
    // recently registered route first — so these win over the empty-list stubs.
    await page.route("**/api/stats*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dashboardStats) })
    );
    await page.route("**/api/projects", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([coverageProject]) })
    );
    await page.route("**/api/projects/7/findings", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    );
    await page.route("**/api/projects/7/coverage", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(coveragePayload) })
    );

    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Security Intelligence" })).toBeVisible({ timeout: 10000 });

    await expect(page.getByText(/collector surfaces examined/i)).toBeVisible({ timeout: 10000 });
    // The headline's count comes from the server's examinedSurfaces...
    const neverExamined = COLLECTOR_SURFACES.length - 2;
    await expect(
      page.getByText(`${neverExamined} of ${COLLECTOR_SURFACES.length} have never been examined`, { exact: false }),
    ).toBeVisible();
    // ...and the pills from the catalogue join. Both must say eight, or one of
    // the two paths is computing a different — and therefore wrong — number.
    await expect(page.getByText("Never examined", { exact: true })).toHaveCount(neverExamined);

    // Examined-and-found-nothing is rendered as its own state, not folded into
    // either neighbour. A clean surface is coverage; an unexamined one is not.
    await expect(page.getByText("Nothing found", { exact: true })).toHaveCount(1);
    await expect(page.getByText(/examined, nothing found/i)).toBeVisible();
    // ...and the two failed attempts on that same surface are reported without
    // being counted as coverage.
    await expect(page.getByText(/2 failed attempts, not counted as coverage/i)).toBeVisible();

    // Every planned surface is labelled, individually, rather than being summarised away.
    await expect(page.getByText("Data-at-rest")).toBeVisible();
    await expect(page.getByText(/no collector has shipped for this surface/i).first()).toBeVisible();
    // This used to assert the *deeper* absence — "the inventory model has no
    // place to record it yet" — which `CoverageMeter` renders only for a
    // catalogue entry whose `surface` is null. No entry is null any more:
    // `data-at-rest` and `vendor` were the last two and both got a `Surface`
    // value when the enum landed ahead of their collectors. The component still
    // carries that branch on purpose, because a future surface can be
    // catalogued before the schema can store it, and the two absences are
    // genuinely different facts. There is simply no data in that state today,
    // so asserting it here would be asserting a fiction.

    // The denominator is surfaces. Reading it as a fraction of the estate is
    // explicitly forbidden on the page, because we cannot size the blind spot.
    await expect(page.getByText(/not a percentage of your estate/i)).toBeVisible();
    await expect(page.getByText(/not estimable/i)).toBeVisible();

    // G-11: confidence is read and shown, and the empty top band is the point.
    await expect(page.getByText(/Nothing in this inventory is high-confidence evidence/i)).toBeVisible();
    await expect(page.getByText("0.8–1.0")).toBeVisible();
  });

  test("the coverage meter reports a failure instead of rendering a reassuring zero", async ({ page }) => {
    await page.route("**/api/stats*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dashboardStats) })
    );
    await page.route("**/api/projects", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([coverageProject]) })
    );
    await page.route("**/api/projects/7/findings", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    );
    await page.route("**/api/projects/7/coverage", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) })
    );

    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Security Intelligence" })).toBeVisible({ timeout: 10000 });

    await expect(page.getByText(/Coverage could not be read/i)).toBeVisible({ timeout: 10000 });
    // A failed read must not present itself as a measurement of any kind.
    await expect(page.getByText(/collector surfaces examined/i)).toHaveCount(0);
    await expect(page.getByText(/have never been examined/i)).toHaveCount(0);
  });

  // The fixture above deliberately has no `compliance` block — that is a report shared
  // before C1, and it must still render. This one covers the current shape: findings
  // grouped by compliance bucket, with the use table and the citation an auditor checks.
  test("a report with mapping-engine output groups by compliance bucket and cites its sources", async ({ page }) => {
    const citation = {
      document: "NIST SP 800-131A Revision 2",
      section: "SP 800-131A Rev 2 §9",
      url: "https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-131Ar2.pdf",
      retrievedAt: "2026-08-01",
    };
    await page.route("**/api/reports/compliance-report-1", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "compliance-report-1",
          owner: "acme-corp",
          repo: "legacy-signing",
          repoUrl: "https://github.com/acme-corp/legacy-signing",
          data: {
            owner: "acme-corp",
            repo: "legacy-signing",
            repoUrl: "https://github.com/acme-corp/legacy-signing",
            totalFiles: 1,
            totalLines: 40,
            criticalCount: 0,
            alertCount: 1,
            cleanCount: 39,
            riskScore: 30,
            executiveSummary: "1 finding is non-compliant now, with no migration runway (SHA-1).",
            findings: [
              {
                fileName: "sign.py",
                lineNumber: 7,
                severity: "alert",
                algorithm: "SHA-1",
                codeSnippet: "digest = hashlib.sha1(payload).digest()",
                nistReplacement: "SHA-256 or SHA3-256",
                nistStandard: "FIPS 180-4 / FIPS 202",
                explanation: "SHA-1 is classically broken for collision resistance.",
                effortHours: 0.5,
                compliance: {
                  algorithm: "SHA-1",
                  algorithmId: "sha1",
                  quantumVulnerable: false,
                  riskTrack: "classical-hygiene",
                  complianceStatus: "immediate-failure",
                  bucket: "immediate-compliance-failure",
                  bucketLabel: "Immediate compliance failure",
                  bucketDescription: "A prohibition that is already in force covers this use.",
                  countsTowardPostQuantumScore: false,
                  headline: "SHA-1 is disallowed for digital signature GENERATION under NIST SP 800-131A Revision 2.",
                  useDependent: true,
                  useConditions: [
                    { use: "digital signature GENERATION", status: "Disallowed", permitted: false, framework: "NIST SP 800-131A Revision 2" },
                    { use: "non-digital-signature applications that do not require collision resistance", status: "Acceptable", permitted: true, framework: "NIST SP 800-131A Revision 2" },
                  ],
                  obligations: [
                    {
                      framework: "SP 800-131A Rev 2",
                      frameworkName: "Transitioning the Use of Cryptographic Algorithms and Key Lengths",
                      requirement: "SHA-1 is disallowed for digital signature GENERATION under NIST SP 800-131A Revision 2.",
                      severity: "critical",
                      deadline: { type: "disallowed", label: "Disallowed", effect: "prohibition", inEffect: true, appliesTo: "digital signature GENERATION" },
                      citation,
                      confidence: "verified",
                      caveats: [],
                      source: "algorithm-deadline",
                    },
                  ],
                  detection: { multiplier: 0.5, reviewRequired: true, reason: "SP 800-131A Rev 2 §9 gives three different answers depending on how SHA-1 is used." },
                  reportingNote: "Classical hygiene finding. Track separately from PQC risk.",
                  caveats: [],
                  dataVersion: "0.4.0",
                  asOf: "2026-08-13",
                },
              },
            ],
            fileResults: [],
          },
          createdAt: "2026-08-13T12:00:00Z",
        }),
      })
    );

    await page.goto("/report/compliance-report-1");
    await expect(page.getByText(/Immediate compliance failure \(1\)/i).first()).toBeVisible({ timeout: 10000 });
    // Grouping is by bucket, not by severity, once the mapping engine has answered.
    await expect(page.getByText(/Alert Findings/i)).toHaveCount(0);
    await expect(page.getByText(/NEEDS REVIEW/i).first()).toBeVisible();

    // The card header is a button; the executive summary also mentions SHA-1.
    await page.locator("button", { hasText: "SHA-1" }).first().click();
    // Which uses are disallowed — not a blanket ban on the algorithm (G-08).
    await expect(page.getByText(/Acceptable/).first()).toBeVisible();
    await expect(page.getByText(/NIST SP 800-131A Revision 2/).first()).toBeVisible();
    await expect(page.getByText(/mappings 0\.4\.0/).first()).toBeVisible();
  });
});
