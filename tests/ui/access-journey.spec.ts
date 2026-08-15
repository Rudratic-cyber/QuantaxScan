import { test, expect, type Page } from "@playwright/test";

/**
 * RBAC's management page — the journeys that matter are about *wording*, not
 * layout, so this is a UI suite rather than an e2e one: it drives the real
 * page against fixed payloads, which is what lets it assert the sentences.
 * The behaviour behind those payloads is proven against the real stack in
 * `tests/e2e/19-rbac.spec.ts`.
 *
 * Three claims this page has to make correctly, each of which a plausible
 * implementation gets wrong:
 *
 *  1. **A role is what somebody may do**, not a word. "viewer" tells the
 *     person choosing it nothing; "Reads everything in scope. Changes nothing."
 *     tells them exactly the thing they need.
 *  2. **Dissolving a division widens access.** Its projects are not deleted —
 *     they become visible to the whole organisation. A confirmation that says
 *     "are you sure?" hides that; this one names it.
 *  3. **A 403 is not an empty page.** A non-admin reaching this page must see
 *     the refusal, not a table with no rows, which reads as an organisation
 *     with no members.
 */

const DIVISIONS = {
  divisions: [
    { id: 1, name: "Payments", slug: "payments", description: null, createdAt: "2026-08-15T00:00:00Z", projects: 3 },
    { id: 2, name: "Retail", slug: "retail", description: null, createdAt: "2026-08-15T00:00:00Z", projects: 0 },
  ],
  organizationWideProjects: 4,
};

const MEMBERS = {
  members: [
    { userId: "u_admin", role: "admin", createdAt: "2026-08-01T00:00:00Z", divisionGrants: [] },
    {
      userId: "u_analyst",
      role: "viewer",
      createdAt: "2026-08-02T00:00:00Z",
      divisionGrants: [{ divisionId: 1, role: "member" }],
    },
  ],
  roles: ["viewer", "member", "admin", "owner"],
};

async function openAccess(page: Page, over: { members?: unknown; membersStatus?: number } = {}) {
  await page.route("**/api/divisions", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DIVISIONS) })
      : route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: 3 }) }),
  );
  await page.route("**/api/organization/members", (route) =>
    route.fulfill({
      status: over.membersStatus ?? 200,
      contentType: "application/json",
      body: JSON.stringify(over.members ?? MEMBERS),
    }),
  );
  await page.goto("/access");
  await expect(page.getByRole("heading", { name: "Access" })).toBeVisible({ timeout: 10000 });
}

test.describe("RBAC — the Access page", () => {
  test("says what each role may do, not just what it is called", async ({ page }) => {
    await openAccess(page);

    await expect(page.getByTestId("members-table")).toBeVisible();
    await expect(page.getByTestId("member-row")).toHaveCount(2);

    // The sentence is the point. "viewer" is a label; this is the fact.
    await expect(page.getByText("Reads everything in scope. Changes nothing.")).toBeVisible();
    await expect(page.getByText("Manages members, credentials and divisions.")).toBeVisible();
  });

  test("shows a division grant as raising access, and names the division", async ({ page }) => {
    await openAccess(page);

    // The analyst is an org viewer with `member` on Payments — the exact case
    // the "a grant only raises" rule exists for, rendered so a reader can see
    // both halves at once.
    await expect(page.getByTestId("members-table")).toContainText("Payments");
    await expect(page.getByTestId("members-table")).toContainText("member");
    // Somebody with no grants is organisation-wide, said in words rather than
    // shown as an empty cell.
    await expect(page.getByText("Organisation-wide")).toBeVisible();
  });

  test("lists divisions with how many projects each holds", async ({ page }) => {
    await openAccess(page);

    await expect(page.getByTestId("division-row")).toHaveCount(2);
    await expect(page.getByTestId("divisions-list")).toContainText("payments · 3 projects");
    // Singular/plural matters when a count of one is common.
    await expect(page.getByTestId("divisions-list")).toContainText("retail · 0 projects");
  });

  test("names the consequence when dissolving a division, rather than asking 'are you sure?'", async ({ page }) => {
    await openAccess(page);

    let prompt = "";
    page.on("dialog", (dialog) => {
      prompt = dialog.message();
      void dialog.dismiss();
    });

    await page.getByRole("button", { name: "Dissolve Payments" }).click();
    await expect.poll(() => prompt).not.toBe("");

    // Dissolving widens access — the projects survive and become visible to
    // the whole organisation. A confirmation that hides that is the bug.
    expect(prompt).toContain("will not be deleted");
    expect(prompt).toContain("visible to everyone in the organisation");
    expect(prompt).toContain("3 projects");
  });

  test("refuses a handle that would not survive being put in a URL", async ({ page }) => {
    await openAccess(page);

    await page.getByLabel("Name").fill("Retail Ops");
    await page.getByLabel("Handle").fill("Retail Ops");
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page.getByTestId("division-form-error")).toContainText("lower-case");
    // Refused in the browser, so the round trip never happens for a mistake
    // the page can see.
    await expect(page.getByTestId("division-form-error")).toContainText("appears in URLs");
  });

  test("shows a refusal, not an empty organisation, when the role does not reach the page", async ({ page }) => {
    await openAccess(page, { membersStatus: 403, members: { error: "This action needs the admin role." } });

    // An empty members table would read as "this organisation has nobody in
    // it", which is a different and false statement.
    await expect(page.getByTestId("access-refused")).toBeVisible();
    await expect(page.getByTestId("access-refused")).toContainText("needs the admin role");
    await expect(page.getByTestId("access-refused")).toContainText("not a missing page");
    await expect(page.getByTestId("members-table")).toHaveCount(0);
  });

  test("explains an estate with no divisions rather than showing an empty list", async ({ page }) => {
    await page.route("**/api/divisions", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ divisions: [], organizationWideProjects: 7 }),
      }),
    );
    await page.route("**/api/organization/members", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MEMBERS) }),
    );
    await page.goto("/access");

    await expect(page.getByTestId("no-divisions")).toBeVisible();
    // No divisions is not "no access control" — it is "everything is
    // organisation-wide", which the page says out loud.
    await expect(page.getByTestId("no-divisions")).toContainText("visible to everyone in the tenant");
  });
});
