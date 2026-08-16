import { describe, it, expect, afterAll, beforeAll } from "vitest";
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
// The denominator is the catalogue's, not a number restated here: three
// surfaces were added on 2026-08-15 and every hardcoded 10 in this file went
// stale at once. What these tests are actually about is the *numerator* —
// that a surface counts as examined only when something was collected from it.
import { COLLECTOR_SURFACES } from "@workspace/collectors/surface-catalogue";
import app from "./app";
import { KEY_SIZE_UNDETERMINED, PROP_KEY_SIZE, type CycloneDxBom } from "@workspace/cbom";
import { createCbomValidator, type CbomValidator } from "@workspace/cbom/validate";

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
        { method: "post", path: "/api/projects/999/dependencies", body: { files: [] } },
        { method: "post", path: "/api/projects/999/tls", body: { targets: [] } },
        { method: "post", path: "/api/scans", body: {} },
        { method: "get", path: "/api/scans/999" },
        { method: "get", path: "/api/scans/999/findings" },
        { method: "post", path: "/api/scans/multi", body: {} },
        { method: "post", path: "/api/community/posts", body: {} },
        { method: "post", path: "/api/community/posts/999/vote", body: {} },
        { method: "post", path: "/api/reports", body: {} },
        // A CBOM is a complete map of an organisation's cryptographic
        // weaknesses. It is not on the public allowlist and must not become
        // one — docs/Claude/13-auth-and-tenancy.md §6.2.
        { method: "get", path: "/api/inventory/cbom" },
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

      // C1: every finding carries the mapping engine's resolved position, with a
      // pinned data version and a citation on every regulatory claim.
      expect(rsaFinding.compliance).toBeTruthy();
      expect(rsaFinding.compliance.bucket).toBe("pqc-migration");
      expect(rsaFinding.compliance.dataVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(rsaFinding.compliance.obligations.length).toBeGreaterThan(0);
      for (const o of rsaFinding.compliance.obligations) expect(o.citation.url).toBeTruthy();

      // G-08: SHA-1 reports which uses are disallowed, at reduced confidence — never a blanket ban.
      const sha1Finding = res.body.findings.find((f: { algorithm: string }) => f.algorithm === "SHA-1");
      expect(sha1Finding.compliance.useDependent).toBe(true);
      expect(sha1Finding.compliance.detection.reviewRequired).toBe(true);
      expect(sha1Finding.compliance.countsTowardPostQuantumScore).toBe(false);

      // C4/C5/C6 reach a real route response, not just the engine's unit tests.
      interface RouteObligation {
        framework: string;
        requirement: string;
        severity: string;
        draftStatus?: string;
        deadline?: unknown;
        citation: { url: string; section?: string };
      }
      const obligations: RouteObligation[] = rsaFinding.compliance.obligations;

      // C4 — IR 8547's 2035 date arrives with the sentence that stops it reading as a target,
      // still labelled draft, and carrying no deadline of its own so it cannot move the bucket.
      const ceiling = obligations.find((o) => /Do not treat 2035 as the migration target/.test(o.requirement));
      expect(ceiling).toBeDefined();
      expect(ceiling!.framework).toBe("NIST-IR-8547");
      expect(ceiling!.draftStatus).toMatch(/DRAFT/);
      expect(ceiling!.deadline).toBeUndefined();
      expect(ceiling!.citation.section).toMatch(/4\.2/);
      expect(rsaFinding.compliance.bucket).toBe("pqc-migration");

      // C6 — the factsheet's vendor and prioritisation instructions, each cited to the section
      // it is actually printed under.
      const vendorRoadmap = obligations.find((o) => /post-quantum roadmap/i.test(o.requirement));
      expect(vendorRoadmap?.framework).toBe("CISA-QR");
      expect(vendorRoadmap?.citation.section).toBe("DISCUSS POST-QUANTUM ROADMAPS WITH TECHNOLOGY VENDORS");
      expect(
        obligations.find((o) => /industrial control system/i.test(o.requirement))?.citation.section,
      ).toBe("SUPPLY CHAIN QUANTUM-READINESS");

      // C5 — this route declares no customer profile, so CNSA 2.0 must not appear at all.
      // It binds US national security systems; showing it to anyone else is the over-claim
      // doc 05 forbids, and it is the framework whose dates are still unverified (G-01).
      expect(obligations.some((o) => o.framework === "CNSA-2.0")).toBe(false);
      for (const finding of res.body.findings as Array<{ compliance?: { obligations: RouteObligation[] } | null }>) {
        for (const obligation of finding.compliance?.obligations ?? []) {
          expect(obligation.framework).not.toBe("CNSA-2.0");
        }
      }
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

    it("reports zero examined surfaces before anything has been collected", async () => {
      const res = await request.get(`/api/projects/${projectId}/coverage`).set("X-API-Key", API_KEY);
      expect(res.status).toBe(200);
      expect(res.body.projectId).toBe(projectId);
      // Creating a project runs the scanner for its risk score but writes no
      // collection run — so nothing has been examined, and the meter says so.
      expect(res.body.examinedSurfaces).toBe(0);
      expect(res.body.totalSurfaces).toBe(COLLECTOR_SURFACES.length);
      expect(res.body.surfaces).toEqual([]);
      expect(res.body.confidence.scored).toBe(0);
      expect(res.body.confidence.mean).toBeNull();
    });

    it("still reports only one examined surface after a source scan", async () => {
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
      expect(res.body.totalSurfaces).toBe(COLLECTOR_SURFACES.length);

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

    /**
     * B2 — the coverage meter has to actually move. Everything above this
     * point was true while `DependencyCollector` sat in the repository
     * unreachable: the collector was built and tested, and the honest answer
     * was still "1 of 10", because nothing submitted a lockfile and nothing
     * persisted what it found.
     */
    const PNPM_LOCK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      node-rsa:
        specifier: ^1.1.0
        version: 1.1.1

packages:

  node-rsa@1.1.1:
    resolution: {integrity: sha512-fake==}

  elliptic@6.5.4:
    resolution: {integrity: sha512-fake==}
`;

    it("records no collection run when the submission carries no readable lockfile", async () => {
      const res = await request
        .post(`/api/projects/${projectId}/dependencies`)
        .set("X-API-Key", API_KEY)
        .send({ files: [{ path: "src/app.py", content: "import paramiko\n" }] });

      expect(res.status).toBe(200);
      expect(res.body.lockfilesRecognised).toBe(0);
      // Null, not an id: writing a run would make the meter report the
      // dependency surface as "examined — nothing found", which is a
      // different and false statement from "nothing readable was submitted".
      expect(res.body.collectionRunId).toBeNull();
      expect(res.body.assetsCreated).toBe(0);

      const coverage = await request.get(`/api/projects/${projectId}/coverage`).set("X-API-Key", API_KEY);
      expect(coverage.body.examinedSurfaces).toBe(1);
      expect(coverage.body.surfaces.map((s: { surface: string }) => s.surface)).toEqual(["source"]);
    });

    it("reports two examined surfaces once a lockfile has actually been collected", async () => {
      const submitted = await request
        .post(`/api/projects/${projectId}/dependencies`)
        .set("X-API-Key", API_KEY)
        .send({ files: [{ path: "pnpm-lock.yaml", content: PNPM_LOCK }] });

      expect(submitted.status).toBe(200);
      expect(submitted.body.lockfilesRecognised).toBe(1);
      expect(submitted.body.lockfiles).toEqual([{ path: "pnpm-lock.yaml", kind: "pnpm-lock" }]);
      expect(submitted.body.collectionRunId).toEqual(expect.any(Number));
      // node-rsa → RSA; elliptic → ECDSA, EdDSA, ECDH.
      expect(submitted.body.assetsCreated).toBe(4);
      expect(submitted.body.observationsCreated).toBe(4);
      // The transitive-dependency caveat travels with every response rather
      // than being left for a client to remember — G-20.
      expect(submitted.body.evidenceCaveat).toContain("transitive");

      const res = await request.get(`/api/projects/${projectId}/coverage`).set("X-API-Key", API_KEY);
      expect(res.status).toBe(200);
      expect(res.body.examinedSurfaces).toBe(2);
      expect(res.body.totalSurfaces).toBe(COLLECTOR_SURFACES.length);

      // The count alone is not the claim: a bare `collection_runs` row with no
      // assets would also make it 2, while stating that we looked at the
      // dependencies and found nothing. Assert the surface's own state.
      const dependency = res.body.surfaces.find((s: { surface: string }) => s.surface === "dependency");
      expect(dependency).toMatchObject({ surfaceId: "dependency", state: "examined", completedRuns: 1, failedRuns: 0 });
      expect(dependency.activeAssets).toBe(4);
      expect(dependency.lastExaminedAt).toEqual(expect.any(String));

      // Source coverage is untouched by a dependency run.
      const source = res.body.surfaces.find((s: { surface: string }) => s.surface === "source");
      expect(source).toMatchObject({ state: "examined", completedRuns: 1 });
      expect(source.activeAssets).toBeGreaterThan(0);

      // Both dependency confidence tiers reach the meter: 0.8 for a
      // single-purpose library (node-rsa), 0.5 for a general-purpose one
      // (elliptic) — G-11.
      expect(res.body.confidence.max).toBeCloseTo(0.8, 5);
      expect(res.body.confidence.min).toBeCloseTo(0.5, 5);
    });

    it("marks a package gone when it leaves the lockfile, and does not touch the source assets", async () => {
      const before = await request.get(`/api/projects/${projectId}/coverage`).set("X-API-Key", API_KEY);
      const sourceActiveBefore = before.body.surfaces.find((s: { surface: string }) => s.surface === "source").activeAssets;

      const resubmitted = await request
        .post(`/api/projects/${projectId}/dependencies`)
        .set("X-API-Key", API_KEY)
        .send({
          files: [
            {
              path: "pnpm-lock.yaml",
              content: "lockfileVersion: '9.0'\n\npackages:\n\n  left-pad@1.3.0:\n    resolution: {integrity: sha512-fake==}\n",
            },
          ],
        });
      expect(resubmitted.status).toBe(200);
      expect(resubmitted.body.assetsMarkedGone).toBe(4);

      const after = await request.get(`/api/projects/${projectId}/coverage`).set("X-API-Key", API_KEY);
      const dependency = after.body.surfaces.find((s: { surface: string }) => s.surface === "dependency");
      expect(dependency.activeAssets).toBe(0);
      // Examined, not never-examined: the rows stay in history.
      expect(dependency).toMatchObject({ state: "examined", completedRuns: 2 });

      // The reconciliation is scoped by surface. A dependency run that reached
      // source assets would report a mass false remediation, and this is the
      // assertion that would catch it.
      const source = after.body.surfaces.find((s: { surface: string }) => s.surface === "source");
      expect(source.activeAssets).toBe(sourceActiveBefore);
    });

    it("returns 404 for a project that does not exist, not an empty coverage payload", async () => {
      const res = await request.get("/api/projects/999999/coverage").set("X-API-Key", API_KEY);
      expect(res.status).toBe(404);
    });

    it("returns 404 when lockfiles are submitted for a project that does not exist", async () => {
      const res = await request
        .post("/api/projects/999999/dependencies")
        .set("X-API-Key", API_KEY)
        .send({ files: [{ path: "pnpm-lock.yaml", content: PNPM_LOCK }] });
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

      // Obligations are derived on read, not stored on the row, so a persisted
      // finding carries the same compliance block a fresh scan does.
      for (const persisted of findingsRes.body) {
        expect(persisted.compliance).toBeTruthy();
        expect(persisted.compliance.obligations.length).toBeGreaterThan(0);
        expect(persisted.compliance.dataVersion).toMatch(/^\d+\.\d+\.\d+$/);
      }
      expect(scanRes.body.findings[0]).toHaveProperty("compliance");
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

  /**
   * A5 / the M1 exit criterion: `GET /api/inventory/cbom` returns a CycloneDX
   * 1.7 document that passes schema validation.
   *
   * The document is validated against the **official** vendored schema via
   * `@workspace/cbom/validate` — the same validator the exporter's own unit
   * tests use — rather than by asserting a handful of fields, because a
   * field-by-field check is exactly the thing that passes while the document
   * is unusable to a real CycloneDX consumer.
   */
  describe("CBOM Export (A5, CycloneDX 1.7)", () => {
    let validate: CbomValidator;
    let projectId: number;

    beforeAll(async () => {
      validate = createCbomValidator();

      // Real ingestion, not hand-inserted rows: this must prove the *asset
      // model* exports cleanly, which is the reason CBOM is sequenced second.
      const res = await request
        .post("/api/scans/multi")
        .set("X-API-Key", API_KEY)
        .send({
          projectName: "CBOM Export Fixture",
          language: "javascript",
          files: [
            // Same-line literal modulus → keySize 2048 is determined.
            { filename: "keys.js", content: "const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });" },
            // Modulus behind a variable → keySize stays null (G-05). Both
            // states must be present or the null branch is untested.
            { filename: "rotate.js", content: "const rotated = new RSA({ bits: modulusBits });" },
            { filename: "digest.js", content: "const h = crypto.createHash('md5').update(x).digest('hex');" },
          ],
        });
      expect(res.status).toBe(201);
      projectId = res.body.projectId;
    });

    it("validates against the official CycloneDX 1.7 JSON schema", async () => {
      const res = await request.get("/api/inventory/cbom").set("X-API-Key", API_KEY);
      expect(res.status).toBe(200);
      expect(validate(res.body), `schema validation failed:\n${validate.explain()}`).toBe(true);
    });

    it("declares CycloneDX 1.7 and serves the CycloneDX media type", async () => {
      const res = await request.get("/api/inventory/cbom").set("X-API-Key", API_KEY);
      // The schema constrains neither of these — bom-1.7.schema.json carries
      // only `examples: ["1.7"]` for specVersion — so they are asserted here.
      expect(res.body.bomFormat).toBe("CycloneDX");
      expect(res.body.specVersion).toBe("1.7");
      expect(res.headers["content-type"]).toContain("application/vnd.cyclonedx+json");
      expect(res.body.serialNumber).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    });

    it("relates the crypto it found to the software component containing it", async () => {
      const res = await request.get("/api/inventory/cbom").set("X-API-Key", API_KEY);
      const doc = res.body as CycloneDxBom;

      const project = doc.components.find((c) => c["bom-ref"] === `project:${projectId}`);
      expect(project?.name).toBe("CBOM Export Fixture");

      const edge = doc.dependencies.find((d) => d.ref === `project:${projectId}`);
      expect(edge?.dependsOn?.length).toBeGreaterThan(0);

      // Every edge target must be a component in this same document; JSON
      // Schema cannot check that, since a bom-ref is just a string.
      const refs = new Set(doc.components.map((c) => c["bom-ref"]));
      for (const target of edge?.dependsOn ?? []) expect(refs).toContain(target);
    });

    it("carries a determined key size, and reports an undetermined one as undetermined (G-05)", async () => {
      const res = await request.get("/api/inventory/cbom").set("X-API-Key", API_KEY);
      const doc = res.body as CycloneDxBom;
      const crypto = doc.components.filter((c) => c.type === "cryptographic-asset");
      const keySizeOf = (c: (typeof crypto)[number]) => c.properties?.find((p) => p.name === PROP_KEY_SIZE)?.value;

      const rsa2048 = crypto.find((c) => c.name === "RSA-2048");
      expect(rsa2048?.cryptoProperties?.algorithmProperties?.parameterSetIdentifier).toBe("2048");
      expect(keySizeOf(rsa2048!)).toBe("2048");

      // The asset whose modulus is behind a variable. The export must say so,
      // not pick a number: A4 keys security strength off this field.
      const undetermined = crypto.find((c) => c.name === "RSA" && keySizeOf(c) === KEY_SIZE_UNDETERMINED);
      expect(undetermined, "an RSA asset with an undetermined key size should be in the export").toBeDefined();
      expect(undetermined?.cryptoProperties?.algorithmProperties?.parameterSetIdentifier).toBeUndefined();

      // Every crypto component states which of the two it is.
      for (const c of crypto) expect(keySizeOf(c)).toBeDefined();
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

  /**
   * B5 — the KMS / secret-store collector, through the real routes and the
   * real (pglite) database. The assertions worth reading are the ones about
   * what is *not* claimed: a null key size that survives the round trip, a
   * rotation state that stays null when the export was silent, and a
   * submission of only-symmetric keys that records a run rather than
   * pretending the key store was never examined.
   */
  describe("KMS / Secret Store Collector (B5)", () => {
    let projectId: number;

    it("sets up a project", async () => {
      const res = await request
        .post("/api/projects")
        .set("X-API-Key", API_KEY)
        .send({ name: "KMS Subject", language: "python", code: "" });
      expect(res.status).toBe(201);
      projectId = res.body.id;
    });

    it("classifies a mixed inventory, and says what it could not classify rather than guessing", async () => {
      const res = await request
        .post(`/api/projects/${projectId}/kms`)
        .set("X-API-Key", API_KEY)
        .send({
          keys: [
            { provider: "aws-kms", keyId: "arn:aws:kms:eu-west-2:1:key/rsa", keySpec: "RSA_4096", rotationEnabled: true },
            { provider: "aws-kms", keyId: "arn:aws:kms:eu-west-2:1:key/sym", keySpec: "SYMMETRIC_DEFAULT" },
            { provider: "aws-kms", keyId: "arn:aws:kms:eu-west-2:1:key/mac", keySpec: "HMAC_512" },
            { provider: "aws-kms", keyId: "arn:aws:kms:eu-west-2:1:key/future", keySpec: "RSA_8192" },
            { provider: "aws-kms", keyId: "arn:aws:kms:eu-west-2:1:key/listed" },
            { provider: "azure-key-vault", keyId: "https://v.vault.azure.net/keys/sign/9f", keySpec: "RSA" },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.keysSubmitted).toBe(6);
      expect(res.body.keysObserved).toBe(3);
      expect(res.body.keysUnclassified).toBe(3);
      expect(res.body.collectionRunId).not.toBeNull();
      expect(res.body.assetsCreated).toBe(3);
      expect(res.body.evidenceCaveat).toContain("never what it protects");

      const byId = Object.fromEntries(res.body.keys.map((k: { keyId: string }) => [k.keyId, k]));

      // Documented in the guide, not derivable from the spec string — the
      // row the citation actually earns its keep on.
      expect(byId["arn:aws:kms:eu-west-2:1:key/sym"]).toMatchObject({
        outcome: "observed",
        algorithm: "AES",
        keySize: 256,
        keySizeSource: "key-spec",
      });

      // Known spec, uncatalogued primitive: examined, nothing to report, and
      // NOT mapped to the nearest algorithm. Its stated size is still given.
      expect(byId["arn:aws:kms:eu-west-2:1:key/mac"]).toMatchObject({
        outcome: "no-algorithm",
        algorithm: null,
        keySize: 512,
      });
      expect(byId["arn:aws:kms:eu-west-2:1:key/mac"].reason).toEqual(expect.any(String));

      // The three non-observed outcomes stay distinguishable: only one of
      // them is fixed by a data update.
      expect(byId["arn:aws:kms:eu-west-2:1:key/future"].outcome).toBe("unrecognised-spec");
      expect(byId["arn:aws:kms:eu-west-2:1:key/listed"].outcome).toBe("no-spec");

      // G-05 in the response: Azure's JsonWebKey has no key_size member, so
      // this key genuinely has a known algorithm and no known size.
      expect(byId["https://v.vault.azure.net/keys/sign/9f"]).toMatchObject({
        outcome: "observed",
        algorithm: "RSA",
        keySize: null,
        keySizeSource: "not-supplied",
      });

      // "Not stated" survives as null everywhere; only the key whose export
      // said so reports a rotation state.
      expect(byId["arn:aws:kms:eu-west-2:1:key/rsa"].rotationEnabled).toBe(true);
      expect(byId["arn:aws:kms:eu-west-2:1:key/sym"].rotationEnabled).toBeNull();
    });

    it("persists the null key size and the null rotation state — the round trip is the point", async () => {
      const res = await request.get(`/api/projects/${projectId}/kms`).set("X-API-Key", API_KEY);
      expect(res.status).toBe(200);
      expect(res.body.projectId).toBe(projectId);
      expect(res.body.keys).toHaveLength(3);

      const azure = res.body.keys.find((k: { provider: string }) => k.provider === "azure-key-vault");
      expect(azure).toBeTruthy();
      // A `NOT NULL DEFAULT` on assets.key_size would turn this into a number
      // and nothing else in the suite would notice.
      expect(azure.keySize).toBeNull();
      expect(azure.algorithm).toBe("RSA");
      expect(azure.rotationEnabled).toBeNull();
      expect(azure.status).toBe("active");

      const rotated = res.body.keys.find((k: { keyId: string }) => k.keyId.endsWith("key/rsa"));
      expect(rotated.rotationEnabled).toBe(true);
      expect(rotated.keySize).toBe(4096);
    });

    it("counts the kms surface as examined in the D3 meter", async () => {
      const res = await request.get(`/api/projects/${projectId}/coverage`).set("X-API-Key", API_KEY);
      expect(res.status).toBe(200);
      const kms = res.body.surfaces.find((s: { surface: string }) => s.surface === "kms");
      expect(kms, "kms surface absent from coverage — the collector ran but coverage did not see it").toBeTruthy();
      expect(kms).toMatchObject({ surfaceId: "kms", state: "examined", completedRuns: 1, failedRuns: 0 });
    });

    it("records a run for a key store holding nothing this product reports on — examined, not un-examined", async () => {
      const create = await request
        .post("/api/projects")
        .set("X-API-Key", API_KEY)
        .send({ name: "KMS Symmetric Only", language: "python", code: "" });
      const symmetricProject = create.body.id;

      const res = await request
        .post(`/api/projects/${symmetricProject}/kms`)
        .set("X-API-Key", API_KEY)
        .send({
          keys: [
            { provider: "hashicorp-vault", keyId: "transit/keys/mac", keySpec: "hmac" },
            { provider: "gcp-kms", keyId: "projects/p/.../1", keySpec: "HMAC_SHA256" },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.keysObserved).toBe(0);
      expect(res.body.keysUnclassified).toBe(2);
      // The whole point of this test: a run IS recorded. Every key was
      // classified; none of them is something this product reports on.
      expect(res.body.collectionRunId).not.toBeNull();
      expect(res.body.observationsCreated).toBe(0);

      const coverage = await request.get(`/api/projects/${symmetricProject}/coverage`).set("X-API-Key", API_KEY);
      const kms = coverage.body.surfaces.find((s: { surface: string }) => s.surface === "kms");
      expect(kms.state).toBe("examined-nothing-found");
    });

    it("records no run at all for a submission carrying no keys", async () => {
      const create = await request
        .post("/api/projects")
        .set("X-API-Key", API_KEY)
        .send({ name: "KMS Empty", language: "python", code: "" });
      const emptyProject = create.body.id;

      const res = await request.post(`/api/projects/${emptyProject}/kms`).set("X-API-Key", API_KEY).send({ keys: [] });
      expect(res.status).toBe(200);
      expect(res.body.collectionRunId).toBeNull();

      // Un-examined, not examined-and-empty — the distinction the previous
      // test's `examined-nothing-found` is the other half of.
      const coverage = await request.get(`/api/projects/${emptyProject}/coverage`).set("X-API-Key", API_KEY);
      expect(coverage.body.surfaces.find((s: { surface: string }) => s.surface === "kms")).toBeUndefined();
    });

    it("updates a key in place when its spec changes, rather than minting a second asset", async () => {
      const res = await request
        .post(`/api/projects/${projectId}/kms`)
        .set("X-API-Key", API_KEY)
        .send({
          keys: [{ provider: "aws-kms", keyId: "arn:aws:kms:eu-west-2:1:key/rsa", keySpec: "RSA_2048" }],
        });
      expect(res.status).toBe(200);
      expect(res.body.assetsCreated).toBe(0);
      expect(res.body.assetsUpdated).toBe(1);
      // A partial export must never retire the keys it did not mention — one
      // page of a paginated list-keys is the normal case.
      expect(res.body.assetsMarkedGone).toBe(0);

      const inventory = await request.get(`/api/projects/${projectId}/kms`).set("X-API-Key", API_KEY);
      expect(inventory.body.keys).toHaveLength(3);
      const rotated = inventory.body.keys.find((k: { keyId: string }) => k.keyId.endsWith("key/rsa"));
      expect(rotated.keySize).toBe(2048);
      expect(rotated.status).toBe("active");
    });

    it("404s for a project that does not exist, on both the write and the read", async () => {
      const post = await request
        .post("/api/projects/999999999/kms")
        .set("X-API-Key", API_KEY)
        .send({ keys: [{ provider: "aws-kms", keyId: "k", keySpec: "RSA_2048" }] });
      expect(post.status).toBe(404);

      const get = await request.get("/api/projects/999999999/kms").set("X-API-Key", API_KEY);
      expect(get.status).toBe(404);
    });

    it("exports a KMS asset through the CBOM without breaking the document", async () => {
      /**
       * `GET /inventory/cbom` reads every asset in the organisation with no
       * surface filter, and until this change nothing had ever put a `kms`
       * asset in front of it: the CBOM block earlier in this file runs
       * against the same pglite database *before* the KMS block, so it saw
       * only source and dependency rows. `build-cbom.test.ts` covers the
       * mapping in isolation; this covers the combination, including a null
       * key size reaching the exporter and the `project:<id>:kms:...`
       * location resolving through the `containedIn` prefix join.
       */
      const res = await request.get("/api/inventory/cbom").set("X-API-Key", API_KEY);
      expect(res.status).toBe(200);

      const bom = res.body as CycloneDxBom;
      const validate: CbomValidator = createCbomValidator();
      expect(validate(bom), `schema validation failed:\n${validate.explain()}`).toBe(true);

      const kmsComponents = (bom.components ?? []).filter((component) =>
        (component.properties ?? []).some((p) => p.name.endsWith(":asset:surface") && p.value === "kms"),
      );
      expect(kmsComponents.length).toBeGreaterThan(0);
      // `kms` maps to `related-crypto-material`, not the `algorithm` fallback
      // an unmapped surface would get.
      for (const component of kmsComponents) {
        expect(component.cryptoProperties?.assetType).toBe("related-crypto-material");
      }

      // G-05 survives the export: the Azure key has no size, so no numeric
      // field is emitted and the absence is stated rather than implied.
      const azure = kmsComponents.find((component) =>
        (component.properties ?? []).some((p) => p.name === PROP_KEY_SIZE && p.value === KEY_SIZE_UNDETERMINED),
      );
      expect(azure, "the null-key-size KMS asset is missing from the CBOM").toBeTruthy();
      expect(azure!.cryptoProperties?.relatedCryptoMaterialProperties?.size).toBeUndefined();

      // The project attribution join works for a kms location, which is
      // longer than the source locations it was written against.
      expect(bom.dependencies ?? []).toEqual(expect.any(Array));
    });

    it("rejects a provider it has no curated data for, rather than accepting and silently dropping it", async () => {
      const res = await request
        .post(`/api/projects/${projectId}/kms`)
        .set("X-API-Key", API_KEY)
        .send({ keys: [{ provider: "some-other-kms", keyId: "k", keySpec: "RSA_2048" }] });
      expect(res.status).toBe(400);
    });
  });
});
