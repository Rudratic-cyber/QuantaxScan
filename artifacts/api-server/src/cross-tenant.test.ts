import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import supertest from "supertest";
import { sql } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Cross-tenant proof, through the real Express app.
 *
 * The principal here is the shared API key **bound to organisation 2**
 * (via `QUANTAXSCAN_API_KEY_ORG_IDS`, F1's N-keys-to-N-orgs binding — see
 * `artifacts/api-server/src/lib/principal.ts`), while the fixtures put most
 * of the data in organisation 1. So every assertion below is "a caller in one
 * organisation reaching for another organisation's data", exercised end to
 * end: HTTP → middleware → route → `withOrg` → policy.
 *
 * A *second* key, bound to a *third* organisation, is configured alongside
 * it — see "multiple API keys bind to multiple organisations" below. That is
 * what proves the binding is a real N-keys-to-N-orgs map and not just "the
 * one env var happens to say 2 in this file": two independently-issued keys,
 * live at the same time, resolving to two different, mutually-invisible
 * organisations.
 *
 * Three things make it real rather than decorative:
 *
 *   1. The connection runs as `quantaxscan_app`, which has no BYPASSRLS. See
 *      the negative control in lib/db's tenant-isolation.test.ts — without
 *      that role every assertion here would pass vacuously.
 *   2. Nothing is asserted about `where` clauses. The routes genuinely do not
 *      filter by `organization_id`; the database does. That is the point of
 *      08-security.md's "single choke point that cannot be bypassed by
 *      forgetting a `where` clause", and it is why `GET /api/projects` —
 *      literally `select().from(projectsTable)` with no filter at all — is the
 *      strongest test in this file.
 *   3. The two keys below are never sent together and never compared to each
 *      other's digest by the test — each request carries exactly one key, the
 *      same as a real caller, so a leak has to show up as one key's response
 *      containing the other organisation's row, not as an artefact of the
 *      test harness holding both credentials at once.
 *
 * The session half of the design's cross-tenant suite (two signed-in users,
 * membership revocation taking effect on the next request) needs sign-in,
 * which does not exist yet. It is deliberately absent, not forgotten.
 */

const API_KEY = "test-api-key-1234567890-super-secret-key-32bytes";
const OTHER_ORG = 1; // where the fixtures live
const OUR_ORG = 2; // who API_KEY is bound to

/** A second, independently-issued key, bound to a third organisation. */
const SECOND_API_KEY = "second-test-api-key-0987654321-super-secret-32b";
const THIRD_ORG = 3; // who SECOND_API_KEY is bound to

const { testDb, testScope, seedAsSuperuser, closeTestDb } = await vi.hoisted(async () => {
  process.env.QUANTAXSCAN_API_KEYS =
    "test-api-key-1234567890-super-secret-key-32bytes,second-test-api-key-0987654321-super-secret-32b";
  process.env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";
  // Positional: entry i of QUANTAXSCAN_API_KEY_ORG_IDS binds entry i of
  // QUANTAXSCAN_API_KEYS. This is the mapping principal.ts replaced the old
  // single QUANTAXSCAN_API_KEY_ORG_ID with — see its module doc for why an
  // unlisted key is a startup error rather than a silent fall-back to
  // organisation 1.
  process.env.QUANTAXSCAN_API_KEY_ORG_IDS = "2,3";
  // F4 — the credential store fails closed at use rather than at startup, so
  // without a key configured the credential routes would answer 503 and the
  // cross-tenant assertions below would pass for the wrong reason.
  const { randomBytes } = await import("node:crypto");
  process.env.QUANTAXSCAN_CREDENTIAL_KEYS = `ka:${randomBytes(32).toString("base64")}`;
  const { createTestDb } = await import("@workspace/db/test-support");
  // Default is [1, 2]; the third organisation is this file's own fixture for
  // the second-key tests below, so it has to be seeded explicitly too.
  const { db, scope, seedAsSuperuser, close } = await createTestDb({
    asRole: "quantaxscan_app",
    organizations: [1, 2, 3],
  });
  return { testDb: db, testScope: scope, seedAsSuperuser, closeTestDb: close };
});

vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  return { db: testDb, pool: {}, ...testScope, ...schema };
});

import { executeRows } from "@workspace/db/org-scope";
import { projectRepoId } from "@workspace/db/schema";
import app from "./app";
import { requiredRoleFor } from "./lib/require-role";
import { roleAtLeast } from "@workspace/db/roles";
import router from "./routes";

const request = supertest(app);
const auth = <T extends { set: (k: string, v: string) => T }>(r: T): T => r.set("X-API-Key", API_KEY);
const auth2 = <T extends { set: (k: string, v: string) => T }>(r: T): T => r.set("X-API-Key", SECOND_API_KEY);

/** Ids seeded into the OTHER organisation, which this caller must never reach. */
const theirs = { projectId: 0, scanId: 0, findingId: 0, publicReport: "their-public", privateReport: "their-private" };
/** Ids seeded into OUR organisation, which this caller must see. */
const ours = { projectId: 0, scanId: 0 };
/** Ids seeded into the THIRD organisation, for the second-key tests. */
const theirsToo = { projectId: 0 };

beforeAll(async () => {
  await seedAsSuperuser(async (client) => {
    const insertProject = async (org: number, name: string) =>
      (await client.query<{ id: number }>(
        `insert into projects (organization_id, name, language) values ($1, $2, 'python') returning id`,
        [org, name],
      )).rows[0].id;

    const insertScan = async (org: number, projectId: number) =>
      (await client.query<{ id: number }>(
        `insert into scans (organization_id, project_id, total_lines, code) values ($1, $2, 42, 'secret source') returning id`,
        [org, projectId],
      )).rows[0].id;

    theirs.projectId = await insertProject(OTHER_ORG, "their confidential project");
    ours.projectId = await insertProject(OUR_ORG, "our project");
    theirs.scanId = await insertScan(OTHER_ORG, theirs.projectId);
    ours.scanId = await insertScan(OUR_ORG, ours.projectId);
    theirsToo.projectId = await insertProject(THIRD_ORG, "third organisation's project");

    theirs.findingId = (await client.query<{ id: number }>(
      `insert into findings (organization_id, scan_id, file_name, line_number, severity, algorithm, code_snippet)
         values ($1, $2, 'their.py', 1, 'critical', 'RSA', 'their snippet') returning id`,
      [OTHER_ORG, theirs.scanId],
    )).rows[0].id;

    await client.query(
      `insert into activity (organization_id, description) values ($1, 'their private activity'), ($2, 'our activity')`,
      [OTHER_ORG, OUR_ORG],
    );

    // Coverage-meter fixture, deliberately adversarial. These rows belong to
    // the OTHER organisation but are addressed at OUR project's identity —
    // `collection_runs.target` and the `assets.location` prefix are exactly
    // what `GET /projects/:id/coverage` filters on, so its where clauses match
    // them. Nothing but the row-level-security policy stops them being counted
    // into our coverage numbers and our confidence distribution. Constructible
    // because neither table has a foreign key to `projects`.
    const theirRunId = (await client.query<{ id: number }>(
      `insert into collection_runs (organization_id, collector, collector_version, surface, status, target, observation_count, completed_at)
         values ($1, 'source-regex', '1.0.0', 'source', 'completed', $2, 1, now()) returning id`,
      [OTHER_ORG, `project:${ours.projectId}`],
    )).rows[0].id;

    const theirAssetId = (await client.query<{ id: number }>(
      `insert into assets (organization_id, fingerprint, surface, algorithm, location, status)
         values ($1, 'cross-tenant-coverage-fixture', 'source', 'RSA', $2, 'active') returning id`,
      [OTHER_ORG, `project:${ours.projectId}:leak.py`],
    )).rows[0].id;

    await client.query(
      `insert into observations (organization_id, asset_id, collection_run_id, collector, collector_version, confidence, discovery_modality)
         values ($1, $2, $3, 'source-regex', '1.0.0', 0.95, 'static_artifact_analysis')`,
      [OTHER_ORG, theirAssetId, theirRunId],
    );

    // Inventory rows for the CBOM export. Seeded on both sides because the
    // interesting failure is not "we see nothing" — it is "we see theirs".
    await client.query(
      `insert into assets (organization_id, fingerprint, surface, algorithm, key_size, location, status)
         values ($1, 'their-asset-fingerprint', 'source', 'RSA', 4096, $2, 'active'),
                ($3, 'our-asset-fingerprint',   'source', 'MD5', null, $4, 'active')`,
      [
        OTHER_ORG,
        `${projectRepoId(theirs.projectId)}:secrets/their_key.py`,
        OUR_ORG,
        `${projectRepoId(ours.projectId)}:ours.py`,
      ],
    );

    await client.query(
      `insert into shared_reports (id, organization_id, owner, repo, repo_url, data, visibility, expires_at)
         values ($1, $3, 'acme', 'r', 'https://x', '{"secret":true}'::jsonb, 'public',  now() + interval '7 days'),
                ($2, $3, 'acme', 'r', 'https://x', '{"secret":true}'::jsonb, 'private', now() + interval '7 days')`,
      [theirs.publicReport, theirs.privateReport, OTHER_ORG],
    );
  });
});

afterAll(async () => {
  await closeTestDb();
});

/**
 * A real, self-signed certificate, generated at test time and never
 * committed — a cross-tenant proof needs a submission `certificatesIn()`
 * genuinely recognises, or the "writes nothing" assertion below would be
 * true for the wrong reason (nothing readable was submitted at all, not
 * "the in-scope parent check refused it").
 */
let testCertPem: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "qx-cross-tenant-cert-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath,
        "-days", "365", "-nodes", "-subj", "/CN=cross-tenant-test.invalid",
      ],
      { stdio: "pipe" },
    );
    testCertPem = readFileSync(certPath, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────

describe("route manifest — a new route cannot ship without being considered", () => {
  /**
   * Every route the router exposes, with how it is reached. A route present in
   * Express but absent here fails the suite. That is the whole point: it stops
   * an unscoped route from being added quietly, which is the failure this
   * phase exists to make impossible.
   */
  const MANIFEST: Record<string, "public" | "org-scoped" | "unscoped-public-content"> = {
    "GET /healthz": "public",
    "GET /demo/repos": "public",
    "POST /demo/repos/:slug/scan": "public",
    "GET /reports/:id": "public",
    // F1 — the sign-in routes. `public` because each is how a caller *becomes*
    // authenticated, so requiring authentication to reach one would deadlock.
    // None of them reads project, scan or finding data; `/auth/session` reads
    // the caller's own identity and their own memberships and nothing else.
    "GET /auth/providers": "public",
    "GET /auth/:provider/start": "public",
    "GET /auth/:provider/callback": "public",
    "GET /auth/session": "public",
    "POST /auth/logout": "public",
    // The one that is not: it acts for somebody already signed in, and
    // re-checks membership rather than trusting the session, so a revocation
    // takes effect on the next request instead of the next sign-in.
    "POST /auth/organizations/:id/select": "org-scoped",
    // RBAC stage 5 — the management surface. Every write is admin-gated
    // centrally; the list is readable by a viewer on purpose, so "why can't I
    // see Retail?" is answerable by the person asking it.
    "GET /divisions": "org-scoped",
    "POST /divisions": "org-scoped",
    "PATCH /divisions/:id": "org-scoped",
    "DELETE /divisions/:id": "org-scoped",
    "POST /divisions/:id/grants": "org-scoped",
    "DELETE /divisions/:id/grants/:userId": "org-scoped",
    "GET /organization/members": "org-scoped",
    "PATCH /organization/members/:userId": "org-scoped",
    // C8 — the waivers register. Org-scoped and division-scoped: a waiver names
    // an asset, why somebody was willing to live with it, and until when.
    // Granting one is admin (below); revoking one is deliberately not, because
    // un-silencing must not be harder than silencing.
    "GET /waivers": "org-scoped",
    "POST /waivers": "org-scoped",
    "POST /waivers/:id/revoke": "org-scoped",
    "GET /community/posts": "unscoped-public-content",
    "GET /community/leaderboard": "unscoped-public-content",
    "POST /community/posts": "unscoped-public-content",
    "POST /community/posts/:id/vote": "unscoped-public-content",
    "GET /projects": "org-scoped",
    "POST /projects": "org-scoped",
    "GET /projects/:id": "org-scoped",
    "DELETE /projects/:id": "org-scoped",
    "GET /projects/:id/findings": "org-scoped",
    "GET /projects/:id/coverage": "org-scoped",
    // Writes assets stamped with the caller's organisation and attributed to a
    // project by location prefix, so it confirms the parent inside the scope
    // for the same reason POST /scans does.
    "POST /projects/:id/dependencies": "org-scoped",
    // Same shape as the dependency route immediately above, one surface over.
    "POST /projects/:id/certificates": "org-scoped",
    "GET /projects/:id/certificates": "org-scoped",
    // B8 — the manual OT register. No parent id is ever accepted, so there is
    // no foreign-key-under-RLS check to make: the row is stamped with the
    // caller's organisation and nothing else.
    "GET /ot-fleets": "org-scoped",
    "POST /ot-fleets": "org-scoped",
    "GET /ot-fleets/:id": "org-scoped",
    "PATCH /ot-fleets/:id": "org-scoped",
    "DELETE /ot-fleets/:id": "org-scoped",
    // B9 — the vendor/third-party register. Same reasoning as the OT register
    // above: no parent id is ever accepted, so there is no
    // foreign-key-under-RLS check to make. Which suppliers a company assesses,
    // and what those suppliers admitted about their cryptography, is as
    // tenant-private as a scan result.
    // F4 — the credential store. No parent id is accepted on register, so
    // there is no foreign-key-under-RLS check to make: the row is stamped with
    // the caller's organisation. The revoke route DOES take a client-supplied
    // id, and it is resolved inside the scope — another organisation's id is
    // invisible and comes back 404 rather than 403.
    "GET /credentials": "org-scoped",
    "POST /credentials": "org-scoped",
    "POST /credentials/:id/revoke": "org-scoped",
    "GET /vendor-assessments": "org-scoped",
    "POST /vendor-assessments": "org-scoped",
    "GET /vendor-assessments/:id": "org-scoped",
    "PATCH /vendor-assessments/:id": "org-scoped",
    "DELETE /vendor-assessments/:id": "org-scoped",
    // Same reasoning as dependencies above: assets are attributed to a
    // project only by the `project:<id>:` location prefix, never a foreign
    // key, so the parent is confirmed visible inside the scope.
    "POST /projects/:id/tls": "org-scoped",
    // B6 — same reasoning again: `config` assets are attributed to a project
    // only by the `project:<id>:config:` location prefix, never a foreign key.
    "POST /projects/:id/protocol-config": "org-scoped",
    // B5 — same reasoning again: a submitted key inventory becomes assets
    // attributed to a project only by the `project:<id>:` location prefix,
    // never a foreign key, so the parent is confirmed visible inside the
    // scope. The GET reads those assets with no where clause of its own.
    "POST /projects/:id/kms": "org-scoped",
    "GET /projects/:id/kms": "org-scoped",
    // B7 — same shape again: assets attributed by location prefix, no
    // foreign key, so the parent is confirmed inside the scope.
    "POST /projects/:id/data-at-rest": "org-scoped",
    "GET /projects/:id/data-at-rest": "org-scoped",
    // D8 — discovery. `discovered_targets` has a real foreign key to
    // `projects`, and a foreign key is not subject to RLS, so the parent is
    // confirmed visible inside the scope before a child row is written — the
    // same reasoning as POST /scans.
    "POST /projects/:id/discovery": "org-scoped",
    "GET /projects/:id/discovered-targets": "org-scoped",
    // D8 → B3. The one route in this file whose scope check has to happen
    // *before* the outbound work rather than alongside it: the hostnames come
    // out of this database, so probing before confirming the ids are visible
    // would let a caller make this server open sockets to another tenant's
    // hosts by guessing integers.
    "POST /projects/:id/discovered-targets/probe": "org-scoped",
    "POST /projects/:id/network-flows": "org-scoped",
    "GET /projects/:id/network-flows": "org-scoped",
    // EP — same shape again: a host agent's report becomes assets attributed to
    // a project only by the `project:<id>:endpoint:` location prefix, never a
    // foreign key, so the parent is confirmed visible inside the scope. The GET
    // reads those assets with no where clause of its own.
    "POST /projects/:id/endpoint": "org-scoped",
    "GET /projects/:id/endpoint": "org-scoped",
    "POST /scans": "org-scoped",
    "GET /scans/:id": "org-scoped",
    "GET /scans/:id/findings": "org-scoped",
    "POST /scans/multi": "org-scoped",
    "POST /reports": "org-scoped",
    // E1/E2 — the board pack and the regulator submission. Each reads every
    // asset, project, collection run and observation in the organisation with
    // no where clause of its own, exactly like the CBOM export, and is at
    // least as sensitive: the regulator submission is the CBOM plus per-asset
    // provenance and per-obligation citations. Deliberately **not** on the
    // public allowlist, and deliberately not mounted under `/reports/...`,
    // where `PUBLIC_ROUTES`' share-link regex `/^\/reports\/[^/]+$/` would
    // have matched them and served them anonymously.
    "GET /report-packs/board": "org-scoped",
    "GET /report-packs/board.html": "org-scoped",
    "GET /report-packs/board.pdf": "org-scoped",
    "GET /report-packs/regulator": "org-scoped",
    "GET /report-packs/regulator.html": "org-scoped",
    "GET /report-packs/regulator.pdf": "org-scoped",
    "GET /stats": "org-scoped",
    // A CBOM is the whole inventory in one response — the single worst thing
    // to leak across a tenant boundary, and the reason it is not public.
    "GET /inventory/cbom": "org-scoped",
    // The estate posture timeline reads every asset, project and collection run
    // in the organisation with no where clause at all — the same shape as
    // `GET /projects`, and for the same reason.
    "GET /inventory/timeline": "org-scoped",
    // D1 — same estate-wide read shape as the timeline above: every asset,
    // project, collection run and observation in the organisation, no
    // `where organization_id` in the handler.
    "GET /inventory/readiness": "org-scoped",
    "GET /inventory/assets": "org-scoped",
    // M3 — scheduled re-collection. `collection_schedules.project_id` is a real
    // foreign key, and a foreign key is checked with RLS bypassed, so POST
    // confirms the parent project is visible inside the scope before writing —
    // the same rule the collector submission routes follow for their location
    // prefix, here for an actual FK.
    "GET /collection-schedules": "org-scoped",
    "POST /collection-schedules": "org-scoped",
    "PATCH /collection-schedules/:id": "org-scoped",
    "DELETE /collection-schedules/:id": "org-scoped",
    // The runner. Org-scoped deliberately rather than a cross-tenant daemon:
    // finding due work across every organisation means reading an
    // org-scoped table outside any scope, which org-scope.ts forbids. It
    // executes only the caller's own due schedules.
    "POST /collection-schedules/run-due": "org-scoped",
    // D4 — the drift feed. Reads every asset, collection run, schedule and
    // attempt in the organisation with no where clause at all, the same shape
    // as `GET /projects` and the inventory reads above.
    "GET /drift": "org-scoped",
    // These touch no database at all: chat proxies to OpenAI and persists
    // nothing, and the github routes fetch from GitHub and hand the result
    // straight back. They still require an API key. When any of them starts
    // persisting, this entry has to change, and that is the point of the file.
    "POST /chat": "public",
    "GET /github/rate-limit": "public",
    "POST /github/scan": "public",
    "POST /github/fetch": "public",
    "POST /github/scan-files": "public",
  };

  function routesOf(stack: unknown[]): string[] {
    return stack.flatMap((layer) => {
      const l = layer as { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: unknown[] } };
      if (l.route) {
        return Object.keys(l.route.methods)
          .filter((m) => l.route!.methods[m])
          .map((m) => `${m.toUpperCase()} ${l.route!.path}`);
      }
      return l.handle?.stack ? routesOf(l.handle.stack) : [];
    });
  }

  it("every route mounted on the router is declared in the manifest", () => {
    const mounted = routesOf((router as unknown as { stack: unknown[] }).stack).sort();
    const declared = Object.keys(MANIFEST).sort();

    const undeclared = mounted.filter((r) => !declared.includes(r));
    expect(
      undeclared,
      "a route exists in Express but not in this manifest — decide whether it is org-scoped before shipping it",
    ).toEqual([]);

    const stale = declared.filter((r) => !mounted.includes(r));
    expect(stale, "the manifest names routes that no longer exist").toEqual([]);
  });

  /**
   * RBAC stage 3. The manifest above decides whether a route is org-scoped;
   * these two decide what role it needs. Together they are why a new route
   * cannot ship without someone having thought about both.
   */
  describe("every route's required role is a decision, not an accident", () => {
    /**
     * The complete set of routes that need `admin`. Declared here rather than
     * derived, so adding or removing an administrative gate is a visible diff
     * in a test somebody reviews — not a quiet edit to a regex list.
     */
    const ADMIN_ONLY = [
      "DELETE /divisions/:id",
      "DELETE /divisions/:id/grants/:userId",
      "DELETE /projects/:id",
      "GET /credentials",
      "GET /organization/members",
      "PATCH /divisions/:id",
      "PATCH /organization/members/:userId",
      "POST /credentials",
      "POST /credentials/:id/revoke",
      "POST /divisions",
      "POST /divisions/:id/grants",
      "POST /reports",
      // C8. Granting a waiver accepts a risk on the organisation's behalf.
      // `POST /waivers/:id/revoke` is absent on purpose — see require-role.ts.
      "POST /waivers",
    ].sort();

    it("names exactly the routes that require admin", () => {
      const mounted = routesOf((router as unknown as { stack: unknown[] }).stack);
      const admin = mounted
        .filter((route) => {
          const [method, path] = route.split(" ");
          return requiredRoleFor(method, path.replace(/:[^/]+/g, (m) => m)) === "admin";
        })
        .sort();

      // Compared as a set in both directions: a gate added without declaring
      // it, and a gate removed without noticing, both fail here.
      expect(admin).toEqual(ADMIN_ONLY);
    });

    it("closes every write to a viewer, including routes nobody has considered", () => {
      const mounted = routesOf((router as unknown as { stack: unknown[] }).stack);
      const writes = mounted.filter((route) => {
        const [method] = route.split(" ");
        return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
      });

      expect(writes.length).toBeGreaterThan(0);
      for (const route of writes) {
        const [method, path] = route.split(" ");
        // The default is the design: anything that is not a read needs at
        // least `member`, so a route added without touching require-role.ts is
        // closed to read-only accounts rather than open to them. Asserted as
        // "a viewer cannot reach it" rather than "a member can" — an
        // admin-only write is also correct here, and the property that matters
        // is the floor, not the ceiling.
        expect(roleAtLeast("viewer", requiredRoleFor(method, path)), `${route} is reachable by a viewer`).toBe(
          false,
        );
      }
    });

    it("lets a viewer read", () => {
      expect(requiredRoleFor("GET", "/projects")).toBe("viewer");
      expect(requiredRoleFor("GET", "/inventory/timeline")).toBe("viewer");
      expect(roleAtLeast("viewer", requiredRoleFor("GET", "/projects"))).toBe(true);
    });
  });
});

describe("list routes return this organisation's rows and only this organisation's rows", () => {
  it("GET /api/projects — no `where organization_id` exists in the handler; the policy is what scopes it", async () => {
    const res = await auth(request.get("/api/projects"));
    expect(res.status).toBe(200);
    expect(res.body.map((p: { name: string }) => p.name)).toEqual(["our project"]);
    expect(res.body).toHaveLength(1);
  });

  it("GET /api/stats counts only this organisation, and leaks no other tenant's project names", async () => {
    const res = await auth(request.get("/api/stats"));
    expect(res.status).toBe(200);

    const descriptions = res.body.recentActivity.map((a: { description: string }) => a.description);
    expect(descriptions).toContain("our activity");
    expect(descriptions).not.toContain("their private activity");

    // one project + one scan in our organisation
    expect(res.body.totalReposScanned).toBe(2);
  });

  it("GET /api/inventory/cbom exports our inventory and no trace of theirs", async () => {
    // The worst single response to get wrong: one document listing every
    // cryptographic weakness an organisation has, including file paths.
    const res = await auth(request.get("/api/inventory/cbom"));
    expect(res.status).toBe(200);

    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain("their-asset-fingerprint");
    expect(serialised).not.toContain("secrets/their_key.py");
    expect(serialised).not.toContain("their confidential project");
    expect(serialised).toContain("our-asset-fingerprint");

    const crypto = res.body.components.filter((c: { type: string }) => c.type === "cryptographic-asset");
    expect(crypto).toHaveLength(1);
  });

  it("GET /api/inventory/timeline plots none of another organisation's history", async () => {
    // The adversarial coverage fixture is exactly the attack this route is
    // exposed to, and more so: it seeds a *completed collection run* in the
    // OTHER organisation whose `target` is OUR project id, plus an asset at
    // OUR project's location prefix. This handler filters on neither — it reads
    // the whole organisation — so if the policy leaks, that run becomes a point
    // on our timeline and their asset becomes a breach in our count.
    const res = await auth(request.get("/api/inventory/timeline"));
    expect(res.status).toBe(200);

    // Their run must not become our history. Zero instants is the honest answer
    // for an organisation nothing has ever been collected from.
    expect(res.body.observed.distinctCollectionInstants).toBe(0);
    expect(res.body.observed.sufficientForTrend).toBe(false);
    expect(res.body.observed.points).toEqual([]);

    // One asset, ours, at our project. Not theirs, and not the one they planted
    // at our project's location prefix.
    expect(res.body.estate.totalAssets).toBe(1);
    expect(res.body.estate.projects).toEqual([
      { id: ours.projectId, name: "our project", assets: 1, presentAssets: 1 },
    ]);

    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain("their confidential project");
    // Ours is MD5; theirs is the only RSA in the fixture. An RSA deadline
    // marker here would mean their asset was scored into our estate.
    expect(res.body.deadlines.every((d: { algorithms: string[] }) => !d.algorithms.includes("RSA"))).toBe(true);
  });

  it("GET /api/inventory/readiness scores none of another organisation's coverage or assets", async () => {
    // Same adversarial fixture as the timeline test: their completed run and
    // their asset are addressed at OUR project's identity, and this handler
    // reads the whole organisation with no `where` clause. If the policy
    // leaked, their source-surface run would mark "source" examined for us.
    const res = await auth(request.get("/api/inventory/readiness"));
    expect(res.status).toBe(200);

    // Our own MD5 source asset is real evidence — "source" is examined for us.
    // The claim under test is that THEIRS is not counted alongside it: their
    // completed run at our project's `target` would additionally mark
    // `completedRuns` on our "source" entry if the policy leaked.
    expect(res.body.coverage.examinedSurfaces).toBe(1);
    expect(res.body.coverage.surfaces).toEqual([
      expect.objectContaining({ surface: "source", assets: 1, completedRuns: 0 }),
    ]);

    const inventorySection = res.body.sections.find((s: { id: string }) => s.id === "cryptographic-inventory");
    expect(inventorySection.numerator).toBe(1);

    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain("their confidential project");
  });

  it("GET /api/inventory/assets lists only our own asset, not theirs", async () => {
    const res = await auth(request.get("/api/inventory/assets"));
    expect(res.status).toBe(200);

    expect(res.body.assets).toHaveLength(1);
    expect(res.body.assets[0].fingerprint).toBe("our-asset-fingerprint");
    expect(res.body.assets[0].algorithm).toBe("MD5");

    // Their `active` asset must not be folded into our status counts.
    expect(res.body.statusCounts).toEqual({ active: 1 });

    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain("their-asset-fingerprint");
    expect(serialised).not.toContain("secrets/their_key.py");
  });

  it("GET /api/report-packs/regulator submits our inventory and no trace of theirs", async () => {
    // The most sensitive payload in the product: every asset, with its
    // location, its provenance and its obligations, in one document meant for
    // a regulator. Same adversarial fixture as the timeline and readiness
    // tests — their completed run and their asset are addressed at OUR
    // project's identity, and this handler reads the whole organisation with
    // no where clause of its own, so only the policy separates them.
    const res = await auth(request.get("/api/report-packs/regulator"));
    expect(res.status).toBe(200);

    expect(res.body.inventory).toHaveLength(1);
    expect(res.body.inventory[0].fingerprint).toBe("our-asset-fingerprint");
    expect(res.body.inventory[0].algorithm).toBe("MD5");
    expect(res.body.scope.statusCounts).toEqual({ active: 1 });

    // Their collection run must not become our provenance, and their
    // observation must not become our evidence — the two fields an auditor
    // would read as "somebody looked at this on our behalf".
    expect(res.body.header.collectors).toEqual([]);
    expect(res.body.methodology.discoveryModalities).toEqual([]);
    expect(res.body.inventory[0].provenance.collector).toBeNull();
    expect(res.body.inventory[0].provenance.note).not.toBeNull();
    expect(res.body.coverageLimitations.assetsWithoutObservation).toBe(1);

    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain("their-asset-fingerprint");
    expect(serialised).not.toContain("cross-tenant-coverage-fixture");
    expect(serialised).not.toContain("secrets/their_key.py");
    expect(serialised).not.toContain("their confidential project");
    expect(serialised).not.toContain("leak.py");
  });

  it("GET /api/report-packs/board counts none of another organisation's exposure", async () => {
    const res = await auth(request.get("/api/report-packs/board"));
    expect(res.status).toBe(200);

    // Ours is MD5 — classical hygiene, not a post-quantum problem. Theirs is
    // the only RSA in the fixture, so a non-zero quantum-vulnerable count here
    // would mean their asset was scored into our board's headline.
    expect(res.body.page1.exposure.assetsFound).toBe(1);
    expect(res.body.page1.exposure.quantumVulnerableAssets).toBe(0);
    expect(res.body.page1.exposure.classicalHygieneAssets).toBe(1);
    expect(JSON.stringify(res.body.appendices)).not.toContain("RSA");

    // Their completed run must not become an instant we can claim to trend
    // against. Zero is the honest answer for an organisation nothing has ever
    // been collected from.
    expect(res.body.page1.trend.distinctCollectionInstants).toBe(0);
    expect(res.body.page1.trend.verdict).toBe("baseline");
    expect(res.body.header.collectors).toEqual([]);

    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain("their confidential project");
    expect(serialised).not.toContain("secrets/their_key.py");
  });

  it("GET /api/projects/:id/findings returns nothing for another organisation's project", async () => {
    const res = await auth(request.get(`/api/projects/${theirs.projectId}/findings`));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("GET /api/projects/:id/coverage counts none of another organisation's runs, assets or confidence", async () => {
    // The fixture put a completed source run, an active asset and a 0.95
    // observation in the OTHER organisation, addressed at OUR project. The
    // handler's `target = project:<id>` and `location like 'project:<id>:%'`
    // both match them. If this returns anything but an empty, zeroed meter,
    // the policy — not a where clause — has failed.
    const res = await auth(request.get(`/api/projects/${ours.projectId}/coverage`));
    expect(res.status).toBe(200);

    // The claim under test is that none of THEIR rows are counted — not that the meter
    // reads empty. The A5 fixture seeds one of OUR OWN active source assets on this
    // project, and `coverage.ts` treats an asset as evidence a surface was examined, so
    // exactly one examined surface is the correct answer. A bare `toBe(0)` here would
    // fail for the right thing happening, which is how a tenancy test stops being read.
    expect(res.body.examinedSurfaces).toBe(1);
    expect(res.body.surfaces.filter((s: { state: string }) => s.state !== "never-examined"))
      .toHaveLength(1);

    // Their completed run, their asset and their 0.95 observation are all addressed at
    // this project and all match the handler's where clauses. Only the policy excludes
    // them, so their absence from the payload is the whole assertion.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("0.95");
    expect(body).not.toContain("leak.py");
    expect(res.body.confidence.max).not.toBe(0.95);
  });
});

describe("addressing another organisation's row by id is indistinguishable from it not existing", () => {
  it("GET /api/projects/:id → 404, not 403 — a 403 would confirm the row is real", async () => {
    const res = await auth(request.get(`/api/projects/${theirs.projectId}`));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Project not found" });
  });

  it("GET /api/projects/:id/coverage → 404, matching GET /api/projects/:id", async () => {
    // An empty coverage payload would assert "this project exists and nothing
    // has been examined", which is a different and false statement.
    const res = await auth(request.get(`/api/projects/${theirs.projectId}/coverage`));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Project not found" });
  });

  it("GET /api/scans/:id → 404", async () => {
    const res = await auth(request.get(`/api/scans/${theirs.scanId}`));
    expect(res.status).toBe(404);
  });

  it("GET /api/scans/:id/findings → empty, and their snippet is not in the body", async () => {
    const res = await auth(request.get(`/api/scans/${theirs.scanId}/findings`));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("DELETE /api/projects/:id reports success but changes nothing — their row survives intact", async () => {
    const res = await auth(request.delete(`/api/projects/${theirs.projectId}`));
    expect(res.status).toBe(204);

    // Verified from outside the request's scope, so this is the row's real
    // state and not another scoped read agreeing with itself.
    const survivors = await testScope.withOrg({ organizationId: OTHER_ORG, userId: "" }, (tx) =>
      executeRows<{ name: string }>(tx, sql`select name from projects where id = ${theirs.projectId}`),
    );
    expect(survivors).toEqual([{ name: "their confidential project" }]);
  });

  it("POST /api/scans naming another organisation's project writes nothing", async () => {
    const countTheirScans = () =>
      testScope.withOrg({ organizationId: OTHER_ORG, userId: "" }, (tx) =>
        executeRows<{ n: number }>(tx, sql`select count(*)::int as n from scans where project_id = ${theirs.projectId}`),
      );
    const before = await countTheirScans();

    const res = await auth(
      request.post("/api/scans").send({
        projectId: theirs.projectId,
        mode: "scan-only",
        code: "key = RSA.generate(2048)",
        language: "python",
      }),
    );
    // 404, and not for free: a foreign key is checked with RLS bypassed, so
    // the database happily accepted `project_id` pointing at another
    // organisation's project until the handler was made to confirm the parent
    // is visible inside the scope. This assertion is what caught that.
    expect(res.status).toBe(404);

    const after = await countTheirScans();
    expect(after).toEqual(before);
  });

  it("POST /api/projects/:id/dependencies naming another organisation's project writes nothing", async () => {
    // `assets` has no foreign key to `projects` at all — the association is
    // the `project:<id>:` prefix this route writes into `location`. So there
    // is no database-level check to fall back on: without the in-scope parent
    // lookup, this request would create real, RLS-stamped assets attributed
    // to a project the caller cannot see, and the D3 meter for that project
    // would then count a surface examined by a stranger.
    const theirAssetPrefix = `project:${theirs.projectId}:%`;
    const countTheirDependencyAssets = () =>
      testScope.withOrg({ organizationId: OTHER_ORG, userId: "" }, (tx) =>
        executeRows<{ n: number }>(
          tx,
          sql`select count(*)::int as n from assets where location like ${theirAssetPrefix} and surface = 'dependency'`,
        ),
      );
    const before = await countTheirDependencyAssets();

    const res = await auth(
      request.post(`/api/projects/${theirs.projectId}/dependencies`).send({
        files: [{ path: "pnpm-lock.yaml", content: "packages:\n\n  node-rsa@1.1.1:\n    resolution: {integrity: sha512-x==}\n" }],
      }),
    );
    expect(res.status).toBe(404);

    const after = await countTheirDependencyAssets();
    expect(after).toEqual(before);
  });

  it("POST /api/projects/:id/certificates naming another organisation's project writes nothing", async () => {
    // Same shape as the dependency proof above, one surface over: `assets`
    // has no foreign key to `projects`, so only the in-scope parent lookup
    // stands between this request and a real, RLS-stamped asset attributed to
    // a project the caller cannot see.
    const theirAssetPrefix = `project:${theirs.projectId}:%`;
    const countTheirCertificateAssets = () =>
      testScope.withOrg({ organizationId: OTHER_ORG, userId: "" }, (tx) =>
        executeRows<{ n: number }>(
          tx,
          sql`select count(*)::int as n from assets where location like ${theirAssetPrefix} and surface = 'certificate'`,
        ),
      );
    const before = await countTheirCertificateAssets();

    const res = await auth(
      request.post(`/api/projects/${theirs.projectId}/certificates`).send({
        files: [{ path: "cert.pem", content: testCertPem }],
      }),
    );
    expect(res.status).toBe(404);

    const after = await countTheirCertificateAssets();
    expect(after).toEqual(before);
  });

  it("POST /api/projects/:id/tls naming another organisation's project writes nothing", async () => {
    // The submitted target is loopback, which the SSRF guard refuses before
    // any socket is opened — deliberately, so this test needs no real TLS
    // server and stays fast and deterministic. The point under test is the
    // parent-visibility check, not the probe itself; `tls-ssrf-guard.test.ts`
    // and the e2e spec cover the probe.
    const theirAssetPrefix = `project:${theirs.projectId}:%`;
    const countTheirTlsAssets = () =>
      testScope.withOrg({ organizationId: OTHER_ORG, userId: "" }, (tx) =>
        executeRows<{ n: number }>(
          tx,
          sql`select count(*)::int as n from assets where location like ${theirAssetPrefix} and surface = 'tls'`,
        ),
      );
    const before = await countTheirTlsAssets();

    const res = await auth(
      request.post(`/api/projects/${theirs.projectId}/tls`).send({
        targets: [{ host: "127.0.0.1", port: 1 }],
      }),
    );
    expect(res.status).toBe(404);

    const after = await countTheirTlsAssets();
    expect(after).toEqual(before);
  });

  it("POST /api/collection-schedules naming another organisation's project writes nothing (M3)", async () => {
    // `collection_schedules.project_id` is a genuine foreign key, and
    // PostgreSQL checks referential integrity with policies BYPASSED — so
    // without the parent-visibility check inside the scope this insert would
    // succeed, and a runner would then start opening sockets to hosts named
    // against another tenant's project.
    const countTheirSchedules = () =>
      testScope.withOrg({ organizationId: OTHER_ORG, userId: "" }, (tx) =>
        executeRows<{ n: number }>(tx, sql`select count(*)::int as n from collection_schedules`),
      );
    const before = await countTheirSchedules();

    const res = await auth(
      request.post("/api/collection-schedules").send({
        projectId: theirs.projectId,
        targetKind: "tls",
        targets: [{ host: "example.test", port: 443 }],
        intervalMinutes: 60,
      }),
    );
    expect(res.status).toBe(404);

    expect(await countTheirSchedules()).toEqual(before);
  });

  it("a schedule is invisible to another key, by list and by id, and its target hosts do not leak (M3)", async () => {
    const created = await auth(
      request.post("/api/collection-schedules").send({
        projectId: ours.projectId,
        targetKind: "tls",
        // A hostname is estate intelligence in its own right: which internal
        // endpoints a company watches names its infrastructure.
        targets: [{ host: "vault.internal.ours.test", port: 8443 }],
        intervalMinutes: 30,
      }),
    );
    expect(created.status).toBe(201);

    const theirList = await auth2(request.get("/api/collection-schedules"));
    expect(theirList.status).toBe(200);
    expect(JSON.stringify(theirList.body)).not.toContain("vault.internal.ours.test");

    expect((await auth2(request.patch(`/api/collection-schedules/${created.body.id}`).send({ enabled: false }))).status).toBe(404);
    await auth2(request.delete(`/api/collection-schedules/${created.body.id}`));

    const stillOurs = await auth(request.get("/api/collection-schedules"));
    expect(stillOurs.body.map((s: { id: number }) => s.id)).toContain(created.body.id);

    // And the drift feed's schedule half is scoped the same way.
    const theirDrift = await auth2(request.get("/api/drift"));
    expect(theirDrift.status).toBe(200);
    expect(theirDrift.body.schedules.overdue.map((o: { scheduleId: number }) => o.scheduleId)).not.toContain(
      created.body.id,
    );

    await auth(request.delete(`/api/collection-schedules/${created.body.id}`));
  });

  it("GET /api/drift reports none of another organisation's assets or history (M3)", async () => {
    const res = await auth(request.get("/api/drift"));
    expect(res.status).toBe(200);
    // The fixture organisation's project id appears in every one of its asset
    // locations, so its absence from the whole serialised feed is the proof.
    expect(JSON.stringify(res.body)).not.toContain(`project:${theirs.projectId}:`);
    expect(res.body.caveat).toContain("NOT a remediation");
  });

  it("GET /api/projects/:id/certificates → 404 for another organisation's project, not their certificate inventory", async () => {
    const res = await auth(request.get(`/api/projects/${theirs.projectId}/certificates`));
    expect(res.status).toBe(404);
  });

  it("POST /api/projects/:id/protocol-config naming another organisation's project writes nothing", async () => {
    // Same shape as the three proofs above, one surface over. The submitted
    // file IS a valid sshd_config declaring a real algorithm, so a missing
    // parent check would produce a genuine `config` asset attributed to a
    // project the caller cannot see — the failure has to be reachable for the
    // test to prove anything.
    const theirAssetPrefix = `project:${theirs.projectId}:%`;
    const countTheirConfigAssets = () =>
      testScope.withOrg({ organizationId: OTHER_ORG, userId: "" }, (tx) =>
        executeRows<{ n: number }>(
          tx,
          sql`select count(*)::int as n from assets where location like ${theirAssetPrefix} and surface = 'config'`,
        ),
      );
    const before = await countTheirConfigAssets();

    const res = await auth(
      request.post(`/api/projects/${theirs.projectId}/protocol-config`).send({
        files: [{ path: "etc/ssh/sshd_config", content: "HostKeyAlgorithms ssh-rsa\n" }],
      }),
    );
    expect(res.status).toBe(404);

    const after = await countTheirConfigAssets();
    expect(after).toEqual(before);
  });

  it("POST /api/projects/:id/kms naming another organisation's project writes nothing", async () => {
    // Same shape again, and the submitted key deliberately resolves — an
    // `RSA_4096` AWS spec that `kms-key-specs.json` genuinely carries. A
    // submission the collector could not classify would make this assertion
    // true for the wrong reason (nothing was written because nothing was
    // classifiable), rather than because the in-scope parent check refused it.
    const theirAssetPrefix = `project:${theirs.projectId}:%`;
    const countTheirKmsAssets = () =>
      testScope.withOrg({ organizationId: OTHER_ORG, userId: "" }, (tx) =>
        executeRows<{ n: number }>(
          tx,
          sql`select count(*)::int as n from assets where location like ${theirAssetPrefix} and surface = 'kms'`,
        ),
      );
    const before = await countTheirKmsAssets();

    const res = await auth(
      request.post(`/api/projects/${theirs.projectId}/kms`).send({
        keys: [{ provider: "aws-kms", keyId: "arn:aws:kms:eu-west-2:1:key/theirs", keySpec: "RSA_4096" }],
      }),
    );
    expect(res.status).toBe(404);

    const after = await countTheirKmsAssets();
    expect(after).toEqual(before);
  });

  it("GET /api/projects/:id/kms → 404 for another organisation's project, not their key inventory", async () => {
    // A key inventory names every key a customer holds — as bad a thing to
    // leak across a tenant boundary as the CBOM.
    const res = await auth(request.get(`/api/projects/${theirs.projectId}/kms`));
    expect(res.status).toBe(404);
  });

  it("POST /api/projects/:id/data-at-rest naming another organisation's project writes nothing", async () => {
    // Same shape again, with one addition worth stating: this route also
    // persists a caller-supplied `dataClassification` onto the asset, so a
    // successful cross-tenant write would let one organisation assert how long
    // another's data has to stay secret — an input the risk engine then uses.
    const theirAssetPrefix = `project:${theirs.projectId}:%`;
    const countTheirDataAtRestAssets = () =>
      testScope.withOrg({ organizationId: OTHER_ORG, userId: "" }, (tx) =>
        executeRows<{ n: number }>(
          tx,
          sql`select count(*)::int as n from assets where location like ${theirAssetPrefix} and surface = 'data-at-rest'`,
        ),
      );
    const before = await countTheirDataAtRestAssets();

    const res = await auth(
      request.post(`/api/projects/${theirs.projectId}/data-at-rest`).send({
        stores: [
          {
            storeId: "billing",
            engine: "postgresql",
            encryptionState: "encrypted",
            dataEncryption: { algorithm: "AES-256-CBC" },
            keyProtection: { algorithm: "RSA-2048" },
            dataClassification: "regulated",
          },
        ],
      }),
    );
    expect(res.status).toBe(404);

    const after = await countTheirDataAtRestAssets();
    expect(after).toEqual(before);
  });

  it("GET /api/projects/:id/data-at-rest → 404 for another organisation's project, not their store inventory", async () => {
    const res = await auth(request.get(`/api/projects/${theirs.projectId}/data-at-rest`));
    expect(res.status).toBe(404);
  });

  it("POST /api/projects/:id/network-flows naming another organisation's project writes no conversation", async () => {
    // This route writes to a table `assets` does not cover, so the count below
    // is on `network_flows` rather than on assets. Worth stating why the
    // boundary matters more here than on most surfaces: the rows are an ordered
    // list of which of a tenant's services talk to which, i.e. a network map of
    // their estate — it leaks topology even when every row's cryptography is
    // undetermined and no algorithm is recorded at all.
    const countTheirFlows = () =>
      testScope.withOrg({ organizationId: OTHER_ORG, userId: "" }, (tx) =>
        executeRows<{ n: number }>(
          tx,
          sql`select count(*)::int as n from network_flows where project_id = ${theirs.projectId}`,
        ),
      );
    const before = await countTheirFlows();

    const res = await auth(
      request.post(`/api/projects/${theirs.projectId}/network-flows`).send({
        records: [
          {
            source: { workload: "attacker" },
            destination: { hostname: "their-payments.internal", port: 443 },
            cipherSuite: "ECDHE-RSA-AES128-GCM-SHA256",
          },
        ],
      }),
    );
    expect(res.status).toBe(404);

    const after = await countTheirFlows();
    expect(after).toEqual(before);
  });

  it("GET /api/projects/:id/network-flows → 404 for another organisation's project, not their network map", async () => {
    const res = await auth(request.get(`/api/projects/${theirs.projectId}/network-flows`));
    expect(res.status).toBe(404);
  });

  it("POST /api/projects/:id/endpoint naming another organisation's project writes nothing", async () => {
    const theirAssetPrefix = `project:${theirs.projectId}:%`;
    const countTheirEndpointAssets = () =>
      testScope.withOrg({ organizationId: OTHER_ORG, userId: "" }, (tx) =>
        executeRows<{ n: number }>(
          tx,
          sql`select count(*)::int as n from assets where location like ${theirAssetPrefix} and surface = 'endpoint'`,
        ),
      );
    const before = await countTheirEndpointAssets();

    const res = await auth(
      request.post(`/api/projects/${theirs.projectId}/endpoint`).send({
        hosts: [
          {
            machineId: "9f5a1e2c-4b6d-4f21-9c11-6a7b8c9d0e1f",
            hostname: "their-dc-01",
            tlsPolicy: { provider: "schannel", cipherSuites: [{ name: "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384", enabled: true }] },
          },
        ],
      }),
    );
    expect(res.status).toBe(404);

    const after = await countTheirEndpointAssets();
    expect(after).toEqual(before);
  });

  it("GET /api/projects/:id/endpoint → 404 for another organisation's project, not their host fleet", async () => {
    // A host fleet names every server a customer runs, its OS build and what it
    // trusts — as bad a thing to leak across a tenant boundary as the CBOM.
    const res = await auth(request.get(`/api/projects/${theirs.projectId}/endpoint`));
    expect(res.status).toBe(404);
  });
});

describe("share links are governed by the policy, not by the route", () => {
  it("another organisation's PUBLIC report is readable anonymously — that is what a share link is for", async () => {
    const res = await request.get(`/api/reports/${theirs.publicReport}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(theirs.publicReport);
  });

  it("another organisation's PRIVATE report is 404 anonymously AND to us, even holding a valid API key", async () => {
    expect((await request.get(`/api/reports/${theirs.privateReport}`)).status).toBe(404);
    expect((await auth(request.get(`/api/reports/${theirs.privateReport}`))).status).toBe(404);
  });

  it("a revoked report stops resolving without the route knowing anything about revocation", async () => {
    await seedAsSuperuser(async (client) => {
      await client.query(`update shared_reports set revoked_at = now() where id = $1`, [theirs.publicReport]);
    });
    expect((await request.get(`/api/reports/${theirs.publicReport}`)).status).toBe(404);

    await seedAsSuperuser(async (client) => {
      await client.query(`update shared_reports set revoked_at = null where id = $1`, [theirs.publicReport]);
    });
    expect((await request.get(`/api/reports/${theirs.publicReport}`)).status).toBe(200);
  });

  it("an expired report stops resolving too", async () => {
    await seedAsSuperuser(async (client) => {
      await client.query(`update shared_reports set expires_at = now() - interval '1 hour' where id = $1`, [
        theirs.publicReport,
      ]);
    });
    expect((await request.get(`/api/reports/${theirs.publicReport}`)).status).toBe(404);

    await seedAsSuperuser(async (client) => {
      await client.query(`update shared_reports set expires_at = now() + interval '7 days' where id = $1`, [
        theirs.publicReport,
      ]);
    });
    expect((await request.get(`/api/reports/${theirs.publicReport}`)).status).toBe(200);
  });

  it("a report we create lands in OUR organisation and is readable by its link", async () => {
    const created = await auth(
      request.post("/api/reports").send({ owner: "us", repo: "r", repoUrl: "https://x", data: { ok: true } }),
    );
    expect(created.status).toBe(200);

    const fetched = await request.get(`/api/reports/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.organizationId).toBe(OUR_ORG);
    expect(fetched.body.expiresAt).not.toBeNull();
  });
});

describe("writes land in the caller's organisation, never anywhere else", () => {
  it("POST /api/projects stamps our organisation and is invisible to the other one", async () => {
    const res = await auth(
      request.post("/api/projects").send({ name: "brand new", language: "python", code: "x = 1" }),
    );
    expect(res.status).toBe(201);
    expect(res.body.organizationId).toBe(OUR_ORG);

    const theirView = await testScope.withOrg({ organizationId: OTHER_ORG, userId: "" }, (tx) =>
      executeRows<{ n: number }>(tx, sql`select count(*)::int as n from projects where name = 'brand new'`),
    );
    expect(theirView).toEqual([{ n: 0 }]);
  });

  it("POST /api/scans/multi stamps every row it writes — scans, findings, activity and assets alike", async () => {
    const res = await auth(
      request.post("/api/scans/multi").send({
        projectName: "multi",
        language: "python",
        files: [{ filename: "a.py", content: "key = RSA.generate(2048)" }],
      }),
    );
    expect(res.status).toBe(201);

    // Everything this request wrote must carry OUR organisation. Counted from
    // the other organisation's scope: it should see none of it.
    const projectId: number = res.body.projectId;
    const assetPrefix = `project:${projectId}:%`;
    const leaked = await testScope.withOrg({ organizationId: OTHER_ORG, userId: "" }, (tx) =>
      executeRows<{ p: number; s: number; a: number; o: number }>(
        tx,
        sql`select
          (select count(*)::int from projects     where name = 'multi')                  as p,
          (select count(*)::int from scans        where project_id = ${projectId})       as s,
          (select count(*)::int from assets       where location like ${assetPrefix})    as a,
          -- Qualified by this request's assets rather than counting every
          -- observation the other organisation can see: the coverage fixture
          -- above legitimately owns one, and an unqualified count would fail
          -- on that instead of on a leak, which is the opposite of the point.
          (select count(*)::int from observations obs
             join assets ast on ast.id = obs.asset_id
            where ast.location like ${assetPrefix})                                      as o`,
      ),
    );
    expect(leaked).toEqual([{ p: 0, s: 0, a: 0, o: 0 }]);

    // And our own scope sees the assets, so the dual-write really happened
    // rather than being silently swallowed by the policy.
    const mine = await testScope.withOrg({ organizationId: OUR_ORG, userId: "" }, (tx) =>
      executeRows<{ n: number }>(tx, sql`select count(*)::int as n from assets where location like ${assetPrefix}`),
    );
    expect(mine[0].n).toBeGreaterThan(0);
  });
});

describe("multiple API keys bind to multiple organisations (F1)", () => {
  /**
   * Everything above this point uses one key (`API_KEY`, bound to `OUR_ORG`)
   * against fixtures in `OTHER_ORG`. That alone would still pass if the
   * server only ever supported a single key-to-org binding — it says nothing
   * about whether a *second*, independently-configured key resolves to a
   * *different* organisation rather than either erroring or quietly reusing
   * the first key's binding. These tests exist to make exactly that leak
   * fail: `SECOND_API_KEY` is bound to `THIRD_ORG`, a organisation neither
   * `API_KEY` nor its fixtures have any relationship to.
   */

  it("the second key reaches its own organisation and none of the other two", async () => {
    const res = await auth2(request.get("/api/projects"));
    expect(res.status).toBe(200);
    expect(res.body.map((p: { name: string }) => p.name)).toEqual(["third organisation's project"]);
  });

  it("the second key cannot address the first key's organisation's project by id — 404, not 403", async () => {
    const res = await auth2(request.get(`/api/projects/${ours.projectId}`));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Project not found" });
  });

  it("the second key cannot address the fixture organisation's project by id either", async () => {
    const res = await auth2(request.get(`/api/projects/${theirs.projectId}`));
    expect(res.status).toBe(404);
  });

  it("the FIRST key cannot address the SECOND key's organisation's project — the binding is symmetric", async () => {
    const res = await auth(request.get(`/api/projects/${theirsToo.projectId}`));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Project not found" });
  });

  it("a project the second key creates lands in THIRD_ORG, invisible to the first key, and disappears from neither existing organisation's count", async () => {
    const beforeOurs = await auth(request.get("/api/projects"));
    const beforeCount = beforeOurs.body.length;

    const created = await auth2(
      request.post("/api/projects").send({ name: "third org new project", language: "python", code: "z = 1" }),
    );
    expect(created.status).toBe(201);
    expect(created.body.organizationId).toBe(THIRD_ORG);

    // The first key's list is exactly what it was — not stamped with the
    // third organisation's new row, and not missing anything.
    const afterOurs = await auth(request.get("/api/projects"));
    expect(afterOurs.body).toHaveLength(beforeCount);
    expect(afterOurs.body.map((p: { name: string }) => p.name)).not.toContain("third org new project");

    // Verified from outside either scope, the same way the rest of this file
    // verifies writes: this is the row's real organisation, not an
    // agreement between two reads that both trust the same broken binding.
    const stamped = await testScope.withOrg({ organizationId: THIRD_ORG, userId: "" }, (tx) =>
      executeRows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from projects where name = 'third org new project'`,
      ),
    );
    expect(stamped).toEqual([{ n: 1 }]);
  });

  it("an unrecognised key is still 401, unaffected by there now being two valid ones", async () => {
    const res = await request
      .get("/api/projects")
      .set("X-API-Key", "not-one-of-the-configured-keys-at-all-000000000");
    expect(res.status).toBe(401);
  });
});

describe("the vendor register is tenant-private (B9)", () => {
  /**
   * Written entirely against the two keys already configured above rather than
   * against the shared fixture, so it seeds nothing another test can see.
   *
   * The stake is specific to this register: a vendor assessment names a real
   * supplier relationship and records what that supplier admitted about its own
   * cryptography. Leaking one across a tenant boundary discloses both a
   * commercial relationship and a third party's weakness to a company that has
   * no business knowing either.
   */
  it("an assessment one key creates is invisible to the other key, by list and by id", async () => {
    const created = await auth(
      request.post("/api/vendor-assessments").send({
        vendorName: "Acme Payments — our supplier, nobody else's",
        cryptoDisclosed: "RSA-2048 signing keys",
      }),
    );
    expect(created.status).toBe(201);
    expect(created.body.organizationId).toBe(OUR_ORG);

    const theirList = await auth2(request.get("/api/vendor-assessments"));
    expect(theirList.status).toBe(200);
    expect(JSON.stringify(theirList.body)).not.toContain("Acme Payments");
    // The disclosed cryptography specifically — the third party's weakness.
    expect(JSON.stringify(theirList.body)).not.toContain("RSA-2048 signing keys");

    // 404, not 403: a 403 would confirm the row is real and therefore that the
    // relationship exists, which is itself the disclosure.
    const byId = await auth2(request.get(`/api/vendor-assessments/${created.body.id}`));
    expect(byId.status).toBe(404);

    // Nor can the other key edit or delete it out from under us.
    expect((await auth2(request.patch(`/api/vendor-assessments/${created.body.id}`).send({ notes: "x" }))).status).toBe(404);
    await auth2(request.delete(`/api/vendor-assessments/${created.body.id}`));
    const stillOurs = await auth(request.get(`/api/vendor-assessments/${created.body.id}`));
    expect(stillOurs.status).toBe(200);
  });
});

describe("the credential store is tenant-private (F4)", () => {
  /**
   * The highest-stakes cross-tenant assertion in this file. Every other row
   * here is a *description* of a customer's estate; this one is a working
   * read-only key into it. A leak is not a disclosure about their
   * infrastructure — it is access to it.
   *
   * Written against the two configured keys rather than the shared fixture, the
   * same as the vendor block above, so it seeds nothing another test can see.
   */
  const SECRET = "cross-tenant-credential-plaintext-9e2f7a4c1b8d-NEVER-CROSS";

  it("a credential one key registers is invisible to the other, by list and by revoke", async () => {
    const created = await auth(
      request.post("/api/credentials").send({
        name: "our production KMS",
        kind: "cloud_kms_readonly",
        secret: SECRET,
        description: "our account, nobody else's",
      }),
    );
    expect(created.status).toBe(201);
    expect(created.body.organizationId).toBe(OUR_ORG);
    // Belt and braces on the register response itself, in the one suite that
    // runs the whole middleware stack.
    expect(JSON.stringify(created.body)).not.toContain(SECRET);

    const theirList = await auth2(request.get("/api/credentials"));
    expect(theirList.status).toBe(200);
    expect(theirList.body).toEqual([]);
    expect(JSON.stringify(theirList.body)).not.toContain("our production KMS");
    expect(JSON.stringify(theirList.body)).not.toContain(SECRET);

    // 404, not 403: a 403 confirms the row exists, and which cloud accounts a
    // company has connected is itself commercially sensitive.
    const revokeAttempt = await auth2(request.post(`/api/credentials/${created.body.id}/revoke`));
    expect(revokeAttempt.status).toBe(404);

    // And it really is unchanged, not merely unreadable by them — a revoke that
    // silently succeeded would destroy our material while returning 404.
    const stillOurs = await auth(request.get("/api/credentials"));
    expect(stillOurs.body).toHaveLength(1);
    expect(stillOurs.body[0].status).toBe("active");
    expect(stillOurs.body[0].revokedAt).toBeNull();
    expect(stillOurs.body[0].keyId).not.toBeNull();
  });

  it("both organisations may hold a credential with the same name, and neither sees the other's", async () => {
    const name = "shared name, different secret";
    const ourCredential = await auth(
      request.post("/api/credentials").send({ name, kind: "database_readonly", secret: `${SECRET}-ours` }),
    );
    const theirCredential = await auth2(
      request.post("/api/credentials").send({ name, kind: "database_readonly", secret: `${SECRET}-theirs` }),
    );
    expect(ourCredential.status).toBe(201);
    expect(theirCredential.status).toBe(201);
    expect(ourCredential.body.organizationId).toBe(OUR_ORG);
    expect(theirCredential.body.organizationId).toBe(THIRD_ORG);

    const ourList = await auth(request.get("/api/credentials"));
    expect(ourList.body.map((c: { id: number }) => c.id)).not.toContain(theirCredential.body.id);
  });
});
