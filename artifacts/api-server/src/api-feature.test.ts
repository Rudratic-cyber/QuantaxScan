import { describe, it, expect, afterAll } from "vitest";
import supertest from "supertest";
import { vi } from "vitest";

const API_KEY = "test-api-key-1234567890-super-secret-key-32bytes";

const { testDb, testScope, closeTestDb } = await vi.hoisted(async () => {
  process.env.QUANTAXSCAN_API_KEYS = "test-api-key-1234567890-super-secret-key-32bytes";
  process.env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";
  // Set explicitly, not left to the default. Vitest isolates modules but NOT
  // `process.env`, and cross-tenant.test.ts sets this to "2" — inherited here
  // it would quietly verify the wrong organisation while still passing, since
  // the suite is self-consistent either way.
  process.env.QUANTAXSCAN_API_KEY_ORG_ID = "1";
  const { createTestDb } = await import("@workspace/db/test-support");
  // `asRole` matters here as much as in the isolation suite: without it the
  // connection is pglite's superuser, which has BYPASSRLS, and these routes
  // would appear to work even if `withOrg` were removed entirely.
  const { db, scope, close } = await createTestDb({ asRole: "quantaxscan_app" });
  return { testDb: db, testScope: scope, closeTestDb: close };
});

vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  return {
    db: testDb,
    pool: {},
    // Routes reach the database only through these, so the mock has to supply
    // them bound to the test handle — a `db` alone would leave every route
    // calling the real, unconfigured pool.
    ...testScope,
    ...schema,
  };
});

// Import app after setting env vars and mocking db
import app from "./app";

const request = supertest(app);

afterAll(async () => {
  await closeTestDb();
});

describe("API Feature Test Suite", () => {
  describe("Health Check", () => {
    it("returns status ok for GET /api/healthz", async () => {
      const res = await request.get("/api/healthz");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication Boundary (Security Control)", () => {
    it("allows unauthenticated access to public allowlist routes", async () => {
      const publicEndpoints = [
        { method: "get", path: "/api/healthz" },
        { method: "get", path: "/api/demo/repos" },
        { method: "post", path: "/api/demo/repos/paramiko-ssh/scan" },
        { method: "get", path: "/api/community/posts" },
        { method: "get", path: "/api/community/leaderboard" },
        { method: "get", path: "/api/reports/nonexistent-id-123" }, // returns 404, not 401
      ];

      for (const ep of publicEndpoints) {
        const res = await request[ep.method as "get" | "post"](ep.path);
        expect(res.status).not.toBe(401);
      }
    });

    it("rejects unauthenticated requests to protected routes with 401 Unauthorized", async () => {
      const protectedEndpoints = [
        { method: "get", path: "/api/projects" },
        { method: "post", path: "/api/projects", body: { name: "X", language: "python" } },
        { method: "get", path: "/api/projects/999" },
        { method: "delete", path: "/api/projects/999" },
        { method: "get", path: "/api/projects/999/findings" },
        { method: "get", path: "/api/projects/999/coverage" },
        { method: "post", path: "/api/scans", body: {} },
        { method: "get", path: "/api/scans/999" },
        { method: "get", path: "/api/scans/999/findings" },
        { method: "post", path: "/api/scans/multi", body: {} },
        { method: "post", path: "/api/community/posts", body: {} },
        { method: "post", path: "/api/community/posts/999/vote", body: {} },
        { method: "post", path: "/api/reports", body: {} },
      ];

      for (const ep of protectedEndpoints) {
        const req = request[ep.method as "get" | "post" | "delete"](ep.path);
        if (ep.body) req.send(ep.body);
        const res = await req;
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: "Unauthorized" });
      }
    });

    it("rejects requests with invalid API key with 401 Unauthorized", async () => {
      const res = await request
        .get("/api/projects")
        .set("X-API-Key", "invalid-key-xxxxxxxxxxxxxxxxxxxxxxxx");
      expect(res.status).toBe(401);
    });

    it("accepts requests with valid X-API-Key header", async () => {
      const res = await request.get("/api/projects").set("X-API-Key", API_KEY);
      expect(res.status).toBe(200);
    });

    it("accepts requests with valid Authorization Bearer header", async () => {
      const res = await request
        .get("/api/projects")
        .set("Authorization", `Bearer ${API_KEY}`);
      expect(res.status).toBe(200);
    });
  });

  describe("Demo Repositories & Demo Scan", () => {
    it("lists available demo repositories", async () => {
      const res = await request.get("/api/demo/repos");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      const repo = res.body.find((r: { slug: string }) => r.slug === "paramiko-ssh");
      expect(repo).toBeDefined();
      expect(repo).toHaveProperty("name");
      expect(repo).toHaveProperty("riskScore");
    });

    it("runs a demo scan and returns expected findings with NIST replacements", async () => {
      const res = await request.post("/api/demo/repos/paramiko-ssh/scan");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("riskScore");
      expect(res.body).toHaveProperty("findings");
      expect(Array.isArray(res.body.findings)).toBe(true);
      expect(res.body.findings.length).toBeGreaterThan(0);

      // Verify specific algorithm and NIST replacement assertions
      const rsaFinding = res.body.findings.find(
        (f: { algorithm: string }) => f.algorithm.includes("RSA")
      );
      expect(rsaFinding).toBeDefined();
      expect(rsaFinding.nistReplacement).toBeDefined();
      expect(rsaFinding.nistReplacement).not.toBeNull();
    });

    it("returns 404 for unknown demo repo slug", async () => {
      const res = await request.post("/api/demo/repos/unknown-slug-xyz/scan");
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Demo repo not found" });
    });
  });

  describe("Project Lifecycle (Create, List, Fetch, Findings, Delete)", () => {
    let createdProjectId: number;

    it("creates a new project and runs initial code scan", async () => {
      const res = await request
        .post("/api/projects")
        .set("X-API-Key", API_KEY)
        .send({
          name: "Quantum Security Microservice",
          description: "Internal crypto module",
          language: "python",
          code: "from Crypto.PublicKey import RSA\nkey = RSA.generate(1024)",
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.name).toBe("Quantum Security Microservice");
      expect(res.body.criticalCount).toBeGreaterThan(0);
      createdProjectId = res.body.id;
    });

    it("lists all projects including the newly created project", async () => {
      const res = await request.get("/api/projects").set("X-API-Key", API_KEY);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const found = res.body.find((p: { id: number }) => p.id === createdProjectId);
      expect(found).toBeDefined();
    });

    it("fetches project details by ID", async () => {
      const res = await request
        .get(`/api/projects/${createdProjectId}`)
        .set("X-API-Key", API_KEY);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(createdProjectId);
      expect(res.body.name).toBe("Quantum Security Microservice");
    });

    it("returns 404 for nonexistent project ID", async () => {
      const res = await request
        .get("/api/projects/999999")
        .set("X-API-Key", API_KEY);
      expect(res.status).toBe(404);
    });

    it("fetches findings for project", async () => {
      // First create a scan under this project to produce finding rows
      await request
        .post("/api/scans")
        .set("X-API-Key", API_KEY)
        .send({
          projectId: createdProjectId,
          mode: "scan-only",
          code: "import hashlib\nhashlib.md5(b'secret')",
          language: "python",
        });

      const res = await request
        .get(`/api/projects/${createdProjectId}/findings`)
        .set("X-API-Key", API_KEY);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
    });

    it("deletes a project and cleans up assets/findings", async () => {
      const delRes = await request
        .delete(`/api/projects/${createdProjectId}`)
        .set("X-API-Key", API_KEY);
      expect(delRes.status).toBe(204);

      const getRes = await request
        .get(`/api/projects/${createdProjectId}`)
        .set("X-API-Key", API_KEY);
      expect(getRes.status).toBe(404);
    });
  });

  /**
   * D3 — docs/Claude/03-features.md §D3, and the reporting half of G-11.
   *
   * The assertions worth defending here are the negative ones: an unscanned
   * project must report zero examined surfaces out of ten, and a scanned one
   * must still report only one. A meter that drifts toward "mostly covered"
   * because the arithmetic quietly counts something else is the failure mode
   * this feature exists to prevent, and it would not show up in a test that
   * only checked the endpoint returns 200.
   */
  describe("Coverage & Confidence Meter (D3)", () => {
    let projectId: number;

    it("sets up a project with no collection run against it", async () => {
      const res = await request
        .post("/api/projects")
        .set("X-API-Key", API_KEY)
        .send({ name: "Coverage Subject", language: "python", code: "# nothing here yet" });
      expect(res.status).toBe(201);
      projectId = res.body.id;
    });

    it("reports zero of ten surfaces examined before anything has been collected", async () => {
      const res = await request.get(`/api/projects/${projectId}/coverage`).set("X-API-Key", API_KEY);
      expect(res.status).toBe(200);
      expect(res.body.projectId).toBe(projectId);
      // Creating a project runs the scanner for its risk score but writes no
      // collection run — so nothing has been examined, and the meter says so.
      expect(res.body.examinedSurfaces).toBe(0);
      expect(res.body.totalSurfaces).toBe(10);
      expect(res.body.surfaces).toEqual([]);
      expect(res.body.confidence.scored).toBe(0);
      expect(res.body.confidence.mean).toBeNull();
    });

    it("still reports only one of ten surfaces examined after a source scan", async () => {
      const scan = await request
        .post("/api/scans")
        .set("X-API-Key", API_KEY)
        .send({
          projectId,
          mode: "scan-only",
          code: "from Crypto.PublicKey import RSA\nkey = RSA.generate(2048)",
          language: "python",
        });
      expect(scan.status).toBe(201);

      const res = await request.get(`/api/projects/${projectId}/coverage`).set("X-API-Key", API_KEY);
      expect(res.status).toBe(200);
      expect(res.body.examinedSurfaces).toBe(1);
      expect(res.body.totalSurfaces).toBe(10);

      const source = res.body.surfaces.find((s: { surface: string }) => s.surface === "source");
      expect(source).toMatchObject({ surfaceId: "source", state: "examined", completedRuns: 1, failedRuns: 0 });
      expect(source.activeAssets).toBeGreaterThan(0);
      expect(source.lastExaminedAt).toEqual(expect.any(String));

      // The other nine surfaces are absent, which is how "never examined" is
      // expressed on the wire. Anything else here would be a claim we cannot support.
      expect(res.body.surfaces).toHaveLength(1);
    });

    it("surfaces the confidence the source collector actually emits, and no verified evidence", async () => {
      const res = await request.get(`/api/projects/${projectId}/coverage`).set("X-API-Key", API_KEY);
      expect(res.status).toBe(200);

      const { confidence } = res.body;
      expect(confidence.basis).toBe("latest observation per active asset");
      expect(confidence.scored).toBeGreaterThan(0);
      // G-11: the regex collector emits 0.7 and nothing else exists yet. This
      // is the first code path anywhere that reads observations.confidence.
      expect(confidence.min).toBeCloseTo(0.7, 5);
      expect(confidence.max).toBeCloseTo(0.7, 5);
      expect(confidence.distinctValues).toBe(1);
      expect(confidence.buckets).toHaveLength(5);
      expect(confidence.buckets[3].count).toBe(confidence.scored);
      expect(confidence.buckets[4]).toMatchObject({ label: "0.8–1.0", count: 0 });
    });

    it("returns 404 for a project that does not exist, not an empty coverage payload", async () => {
      const res = await request.get("/api/projects/999999/coverage").set("X-API-Key", API_KEY);
      expect(res.status).toBe(404);
    });

    it("rejects a non-numeric project id", async () => {
      const res = await request.get("/api/projects/not-a-number/coverage").set("X-API-Key", API_KEY);
      expect(res.status).toBe(400);
    });
  });

  describe("Scans (Single-File & Multi-File)", () => {
    let projectId: number;

    it("sets up project for scans", async () => {
      const res = await request
        .post("/api/projects")
        .set("X-API-Key", API_KEY)
        .send({
          name: "Scan Target Repo",
          language: "python",
          code: "# init",
        });
      expect(res.status).toBe(201);
      projectId = res.body.id;
    });

    it("executes a single-file scan on vulnerable code and verifies specific findings", async () => {
      const vulnCode = `import hashlib
from Crypto.PublicKey import RSA

# Vulnerable hash
h = hashlib.md5(b"test").hexdigest()

# Vulnerable key generation
key = RSA.generate(1024)
`;
      const res = await request
        .post("/api/scans")
        .set("X-API-Key", API_KEY)
        .send({
          projectId,
          mode: "scan-only",
          code: vulnCode,
          language: "python",
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.status).toBe("completed");
      expect(res.body.findings.length).toBeGreaterThan(0);

      // Verify specific detected algorithm and NIST replacements
      const md5Finding = res.body.findings.find((f: { algorithm: string }) => f.algorithm === "MD5");
      expect(md5Finding).toBeDefined();
      expect(md5Finding.severity).toBe("alert");
      expect(md5Finding.nistReplacement).toBe("SHA-256 or SHA3-256");

      const rsaFinding = res.body.findings.find((f: { algorithm: string }) => f.algorithm.includes("RSA"));
      expect(rsaFinding).toBeDefined();
      expect(rsaFinding.severity).toBe("critical");
      expect(rsaFinding.nistReplacement).toBe("ML-KEM or ML-DSA");
    });

    it("fetches scan by ID and its findings", async () => {
      const createRes = await request
        .post("/api/scans")
        .set("X-API-Key", API_KEY)
        .send({
          projectId,
          mode: "scan-only",
          code: "import hashlib\nhashlib.sha1(b'test')",
          language: "python",
        });
      const scanId = createRes.body.id;

      const scanRes = await request
        .get(`/api/scans/${scanId}`)
        .set("X-API-Key", API_KEY);
      expect(scanRes.status).toBe(200);
      expect(scanRes.body.id).toBe(scanId);
      expect(Array.isArray(scanRes.body.findings)).toBe(true);

      const findingsRes = await request
        .get(`/api/scans/${scanId}/findings`)
        .set("X-API-Key", API_KEY);
      expect(findingsRes.status).toBe(200);
      expect(Array.isArray(findingsRes.body)).toBe(true);
    });

    it("executes a multi-file scan across multiple files", async () => {
      const multiPayload = {
        projectName: "Multi-File Microservice",
        language: "javascript",
        files: [
          {
            filename: "auth.js",
            content: "const crypto = require('crypto');\nconst hash = crypto.createHash('md5').update('data').digest('hex');",
          },
          {
            filename: "rsa_key.js",
            content: "const { generateKeyPairSync } = require('crypto');\nconst key = generateKeyPairSync('rsa', { modulusLength: 1024 });",
          },
        ],
      };

      const res = await request
        .post("/api/scans/multi")
        .set("X-API-Key", API_KEY)
        .send(multiPayload);

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("projectId");
      expect(res.body.filesScanned).toBe(2);
      expect(res.body.fileResults).toHaveLength(2);
      expect(res.body.criticalCount).toBeGreaterThan(0);
    });
  });

  describe("Community Posts & Leaderboard", () => {
    let postId: number;

    it("creates a new community post", async () => {
      const res = await request
        .post("/api/community/posts")
        .set("X-API-Key", API_KEY)
        .send({
          type: "question",
          title: "Migrating RSA to ML-KEM in Production",
          content: "What are the best practices for dual-signing during migration?",
          authorName: "QuantumSecLab",
          language: "python",
          tags: ["pqc", "migration"],
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.title).toBe("Migrating RSA to ML-KEM in Production");
      postId = res.body.id;
    });

    it("lists community posts", async () => {
      const res = await request.get("/api/community/posts");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const post = res.body.find((p: { id: number }) => p.id === postId);
      expect(post).toBeDefined();
    });

    it("allows voting on a community post", async () => {
      const res = await request
        .post(`/api/community/posts/${postId}/vote`)
        .set("X-API-Key", API_KEY)
        .send({ direction: "up" });

      expect(res.status).toBe(200);
      expect(res.body.upvotes).toBe(1);
    });

    it("fetches the community leaderboard", async () => {
      const res = await request.get("/api/community/leaderboard");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0]).toHaveProperty("rank");
      expect(res.body[0]).toHaveProperty("points");
      expect(res.body[0]).toHaveProperty("badge");
    });
  });

  describe("Report Creation & Shared Link Retrieval", () => {
    let reportId: string;

    it("creates a shared report and returns share URL", async () => {
      const res = await request
        .post("/api/reports")
        .set("X-API-Key", API_KEY)
        .send({
          owner: "acme-corp",
          repo: "payment-gateway",
          repoUrl: "https://github.com/acme-corp/payment-gateway",
          data: {
            riskScore: 85,
            criticalCount: 3,
            summary: "Quantum critical findings present",
          },
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("id");
      expect(res.body).toHaveProperty("shareUrl");
      expect(res.body.shareUrl).toBe(`/report/${res.body.id}`);
      reportId = res.body.id;
    });

    it("publicly fetches shared report by ID without authentication", async () => {
      const res = await request.get(`/api/reports/${reportId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(reportId);
      expect(res.body.owner).toBe("acme-corp");
      expect(res.body.repo).toBe("payment-gateway");
    });

    it("returns 404 for unknown report ID", async () => {
      const res = await request.get("/api/reports/nonexistent-report-id-12345");
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Report not found" });
    });
  });
});
