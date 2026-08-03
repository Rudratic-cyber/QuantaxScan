import { test, expect } from "@playwright/test";

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

    // The Dashboard's own chrome still renders, and the empty-state copy proves the
    // failed queries fell through to the no-data path rather than a crash or spinner.
    await expect(page.getByRole("heading", { name: "Security Intelligence" })).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByText(/No scans yet — run your first scan/i)).toBeVisible();
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
});
