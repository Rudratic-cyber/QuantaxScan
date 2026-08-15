/**
 * RBAC — end to end against the real stack: real Postgres, real API server,
 * real row-level-security policies, two API keys bound to the **same
 * organisation at different roles**.
 *
 * That shape is the whole design of the file. The tenant, the data and the
 * routes are identical for both callers, so every difference below is caused by
 * the role and by nothing else. `role-gate.test.ts` proves the same rules
 * against a pglite harness; this proves them against a real PostgreSQL with the
 * policies applied by `apply-rls`, which is the configuration that ships.
 *
 * What would fail if RBAC regressed, in order of how quietly it would land:
 *
 *  1. a viewer's write succeeding — the failure the whole feature exists to
 *     prevent (`a viewer writes nothing`);
 *  2. the credential store becoming reachable by a non-admin, which is a
 *     customer's read-only key into their own cloud (same test);
 *  3. a role refusal answering 404 or 500 rather than a 403 that says which
 *     role is needed, leaving the person unable to tell a permissions problem
 *     from a typo (`explains itself`);
 *  4. authentication and authorisation collapsing into one answer, so an
 *     anonymous caller gets 403 rather than 401 (`does not break what came
 *     before`);
 *  5. a division grant reaching somebody outside the organisation
 *     (`the management surface`).
 */
import { test, expect, API_URL, viewerApiKey } from "./support/fixtures";
import { request as playwrightRequest } from "@playwright/test";

/** Direct HTTP as the read-only key. The `api` fixture is the admin one. */
async function viewerApi(): Promise<import("@playwright/test").APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { "X-API-Key": viewerApiKey() },
  });
}

test.describe("RBAC — a viewer reads", () => {
  test("sees the estate exactly as an admin does", async ({ api }) => {
    const viewer = await viewerApi();
    try {
      const [asAdmin, asViewer] = await Promise.all([api.get("/api/projects"), viewer.get("/api/projects")]);
      expect(asAdmin.status()).toBe(200);
      expect(asViewer.status()).toBe(200);

      // Reading is the whole of what the role is for, so a viewer must not be
      // shown a diminished estate — only a read-only one.
      expect(((await asViewer.json()) as unknown[]).length).toBe(((await asAdmin.json()) as unknown[]).length);

      expect((await viewer.get("/api/inventory/timeline")).status()).toBe(200);
      expect((await viewer.get("/api/inventory/readiness")).status()).toBe(200);
    } finally {
      await viewer.dispose();
    }
  });
});

test.describe("RBAC — a viewer writes nothing", () => {
  test("cannot create a project or submit a collection", async ({ api }) => {
    const viewer = await viewerApi();
    try {
      const created = await viewer.post("/api/projects", {
        data: { name: `viewer-must-not-create-${Date.now()}`, language: "python", code: "" },
      });
      expect(created.status()).toBe(403);

      // And nothing landed: a refusal that still wrote would be the worst of
      // both answers.
      const admin = await api.get("/api/projects");
      const names = ((await admin.json()) as Array<{ name: string }>).map((p) => p.name);
      expect(names.some((n) => n.startsWith("viewer-must-not-create"))).toBe(false);
    } finally {
      await viewer.dispose();
    }
  });

  test("cannot reach the credential store, not even to list it", async () => {
    const viewer = await viewerApi();
    try {
      // Metadata rather than material — but which cloud accounts a company has
      // connected is commercially sensitive on its own.
      expect((await viewer.get("/api/credentials")).status()).toBe(403);
      expect(
        (
          await viewer.post("/api/credentials", {
            data: { name: `x-${Date.now()}`, kind: "cloud_kms_readonly", secret: "should-never-be-stored" },
          })
        ).status(),
      ).toBe(403);
    } finally {
      await viewer.dispose();
    }
  });

  test("explains itself: which role the action needs, and which one they hold", async () => {
    const viewer = await viewerApi();
    try {
      const res = await viewer.post("/api/projects", {
        data: { name: "x", language: "python", code: "" },
      });
      expect(res.status()).toBe(403);
      const body = (await res.json()) as { error: string };
      // A permissions failure the person cannot read is one they cannot act
      // on, and 403-not-404 is what separates it from a typo.
      expect(body.error).toMatch(/needs the member role/i);
      expect(body.error).toMatch(/you have viewer/i);
    } finally {
      await viewer.dispose();
    }
  });
});

test.describe("RBAC — the management surface", () => {
  test("an admin creates a division and a viewer can see it exists", async ({ api }) => {
    const slug = `payments-${Date.now()}`;
    const created = await api.post("/api/divisions", { data: { name: "Payments", slug } });
    expect(created.status()).toBe(201);

    const viewer = await viewerApi();
    try {
      const listed = await viewer.get("/api/divisions");
      expect(listed.status()).toBe(200);
      const body = (await listed.json()) as { divisions: Array<{ slug: string }>; organizationWideProjects: number };
      // Visible by name, holding none of their data. Hiding its existence
      // makes "why can't I see Payments?" unanswerable by the person asking.
      expect(body.divisions.map((d) => d.slug)).toContain(slug);
      expect(typeof body.organizationWideProjects).toBe("number");
    } finally {
      await viewer.dispose();
    }
  });

  test("a viewer cannot create a division or read the membership list", async () => {
    const viewer = await viewerApi();
    try {
      expect(
        (await viewer.post("/api/divisions", { data: { name: "Nope", slug: `nope-${Date.now()}` } })).status(),
      ).toBe(403);
      expect((await viewer.get("/api/organization/members")).status()).toBe(403);
    } finally {
      await viewer.dispose();
    }
  });

  test("a grant cannot be given to somebody outside the organisation", async ({ api }) => {
    const created = await api.post("/api/divisions", {
      data: { name: "Grants", slug: `grants-${Date.now()}` },
    });
    const divisionId = ((await created.json()) as { id: number }).id;

    const res = await api.post(`/api/divisions/${divisionId}/grants`, {
      data: { userId: "somebody-who-is-not-a-member", role: "viewer" },
    });
    // A foreign key is checked with row-level security bypassed, so the parent
    // has to be confirmed visible inside the scope — otherwise this would
    // create access to a tenant they were never admitted to.
    expect(res.status()).toBe(404);
  });

  test("dissolving a division releases its projects rather than deleting them", async ({ api }) => {
    const created = await api.post("/api/divisions", {
      data: { name: "Doomed", slug: `doomed-${Date.now()}` },
    });
    const divisionId = ((await created.json()) as { id: number }).id;

    const deleted = await api.delete(`/api/divisions/${divisionId}`);
    expect(deleted.status()).toBe(200);
    // Deleting a team's work because the team was reorganised would be a
    // data-loss bug wearing a tidy-up's clothes.
    expect((await deleted.json()) as { projectsReleased: number }).toHaveProperty("projectsReleased");
  });
});

test.describe("RBAC — does not break what came before", () => {
  test("an anonymous caller still gets 401, not 403", async ({ publicApi }) => {
    // "Who are you" and "may you" are different questions and must not
    // collapse into one answer.
    expect((await publicApi.get("/api/projects")).status()).toBe(401);
  });

  test("public routes stay public", async ({ publicApi }) => {
    expect((await publicApi.get("/api/healthz")).status()).toBe(200);
    expect((await publicApi.get("/api/demo/repos")).status()).toBe(200);
  });

  test("the admin key still does everything it did before RBAC existed", async ({ api }) => {
    // Every existing deployment and CI script writes through this credential,
    // which is why the role defaults to admin rather than viewer.
    const created = await api.post("/api/projects", {
      data: { name: `admin-still-works-${Date.now()}`, language: "python", code: "" },
    });
    expect(created.status()).toBe(201);
    expect((await api.get("/api/credentials")).status()).toBe(200);
  });
});
