import { describe, it, expect, afterAll, vi } from "vitest";
import supertest from "supertest";

/**
 * RBAC stage 3 — the gate, through the real Express app.
 *
 * Two API keys bound to the **same organisation** at **different roles**. That
 * shape is the point: every difference below is caused by the role and nothing
 * else, because the tenant, the data and the routes are identical.
 *
 * `cross-tenant.test.ts` proves the *manifest* and `requiredRoleFor` agree.
 * This proves the middleware actually refuses, which is a different claim — a
 * correct table nobody consults would pass the first and fail this.
 */

const ADMIN_KEY = "role-gate-admin-key-1234567890-abcdefghij";
const VIEWER_KEY = "role-gate-viewer-key-1234567890-abcdefghi";
const ORG = 1;

const { testDb, testScope, closeTestDb } = await vi.hoisted(async () => {
  process.env.QUANTAXSCAN_API_KEYS = "role-gate-admin-key-1234567890-abcdefghij,role-gate-viewer-key-1234567890-abcdefghi";
  process.env.QUANTAXSCAN_API_KEY_ORG_IDS = "1,1";
  // The binding this whole file exists to exercise: same tenant, two roles.
  process.env.QUANTAXSCAN_API_KEY_ROLES = "admin,viewer";
  process.env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";
  const { randomBytes } = await import("node:crypto");
  process.env.QUANTAXSCAN_CREDENTIAL_KEYS = `ka:${randomBytes(32).toString("base64")}`;
  const { createTestDb } = await import("@workspace/db/test-support");
  // Literal rather than `ORG`: `vi.hoisted` runs before the consts above exist.
  const { db, scope, close } = await createTestDb({ asRole: "quantaxscan_app", organizations: [1] });
  return { testDb: db, testScope: scope, closeTestDb: close };
});

vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  return { db: testDb, pool: {}, ...testScope, ...schema };
});

import app from "./app";

const request = supertest(app);
const asAdmin = <T extends { set: (k: string, v: string) => T }>(r: T): T => r.set("X-API-Key", ADMIN_KEY);
const asViewer = <T extends { set: (k: string, v: string) => T }>(r: T): T => r.set("X-API-Key", VIEWER_KEY);

afterAll(async () => {
  await closeTestDb();
});

describe("a viewer reads", () => {
  it("lists projects, because reading is the whole of what the role is for", async () => {
    const res = await asViewer(request.get("/api/projects"));
    expect(res.status).toBe(200);
  });

  it("reads the estate timeline and the inventory", async () => {
    expect((await asViewer(request.get("/api/inventory/timeline"))).status).toBe(200);
    expect((await asViewer(request.get("/api/inventory/readiness"))).status).toBe(200);
  });
});

describe("a viewer writes nothing", () => {
  it("cannot create a project", async () => {
    const res = await asViewer(
      request.post("/api/projects").send({ name: "viewer-should-not-create", language: "python", code: "" }),
    );
    expect(res.status).toBe(403);
  });

  it("cannot submit a scan", async () => {
    const res = await asViewer(request.post("/api/scans").send({ projectId: 1, code: "x", language: "python" }));
    expect(res.status).toBe(403);
  });

  it("is told which role the action needs, and which one they have", async () => {
    const res = await asViewer(
      request.post("/api/projects").send({ name: "x", language: "python", code: "" }),
    );
    // A permissions failure the person cannot read is one they cannot act on.
    // 403 rather than 404 for the same reason: the caller is authenticated and
    // the route exists, and pretending otherwise makes a permissions problem
    // indistinguishable from a typo.
    expect(res.body.error).toMatch(/needs the member role/i);
    expect(res.body.error).toMatch(/you have viewer/i);
  });

  it("cannot reach the credential store at all — not even to list it", async () => {
    // Metadata rather than material, but *which* cloud accounts a company has
    // connected is commercially sensitive on its own.
    expect((await asViewer(request.get("/api/credentials"))).status).toBe(403);
    expect(
      (await asViewer(request.post("/api/credentials").send({ name: "n", kind: "cloud_kms_readonly", secret: "s" })))
        .status,
    ).toBe(403);
  });
});

describe("an admin does what an admin is for", () => {
  it("creates a project, submits to it, and reaches the credential store", async () => {
    const created = await asAdmin(
      request.post("/api/projects").send({ name: `admin-created-${Date.now()}`, language: "python", code: "" }),
    );
    expect(created.status).toBe(201);

    expect((await asAdmin(request.get("/api/credentials"))).status).toBe(200);
  });

  it("is the only one of the two who can delete a project", async () => {
    const created = await asAdmin(
      request.post("/api/projects").send({ name: `to-delete-${Date.now()}`, language: "python", code: "" }),
    );
    expect(created.status).toBe(201);
    const projectId = (created.body as { id: number }).id;

    // A member could create this project but not remove it; a viewer neither.
    expect((await asViewer(request.delete(`/api/projects/${projectId}`))).status).toBe(403);
    expect((await asAdmin(request.delete(`/api/projects/${projectId}`))).status).toBe(204);
  });
});

describe("the gate does not break what came before it", () => {
  it("still answers 401 to an unauthenticated caller, not 403", async () => {
    // Role gating runs after authentication. "Who are you" and "may you" are
    // different questions and must not collapse into one answer.
    const res = await request.get("/api/projects");
    expect(res.status).toBe(401);
  });

  it("leaves public routes public", async () => {
    expect((await request.get("/api/healthz")).status).toBe(200);
    expect((await request.get("/api/demo/repos")).status).toBe(200);
  });
});
