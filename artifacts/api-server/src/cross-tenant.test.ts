import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import supertest from "supertest";
import { sql } from "drizzle-orm";

/**
 * Cross-tenant proof, through the real Express app.
 *
 * The principal here is the shared API key **bound to organisation 2**
 * (`QUANTAXSCAN_API_KEY_ORG_ID=2`), while the fixtures put most of the data in
 * organisation 1. So every assertion below is "a caller in one organisation
 * reaching for another organisation's data", exercised end to end: HTTP →
 * middleware → route → `withOrg` → policy.
 *
 * Two things make it real rather than decorative:
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
 *
 * The session half of the design's cross-tenant suite (two signed-in users,
 * membership revocation taking effect on the next request) needs sign-in,
 * which does not exist yet. It is deliberately absent, not forgotten.
 */

const API_KEY = "test-api-key-1234567890-super-secret-key-32bytes";
const OTHER_ORG = 1; // where the fixtures live
const OUR_ORG = 2; // who the API key is

const { testDb, testScope, seedAsSuperuser, closeTestDb } = await vi.hoisted(async () => {
  process.env.QUANTAXSCAN_API_KEYS = "test-api-key-1234567890-super-secret-key-32bytes";
  process.env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";
  process.env.QUANTAXSCAN_API_KEY_ORG_ID = "2";
  const { createTestDb } = await import("@workspace/db/test-support");
  const { db, scope, seedAsSuperuser, close } = await createTestDb({ asRole: "quantaxscan_app" });
  return { testDb: db, testScope: scope, seedAsSuperuser, closeTestDb: close };
});

vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  return { db: testDb, pool: {}, ...testScope, ...schema };
});

import { executeRows } from "@workspace/db/org-scope";
import { projectRepoId } from "@workspace/db/schema";
import app from "./app";
import router from "./routes";

const request = supertest(app);
const auth = <T extends { set: (k: string, v: string) => T }>(r: T): T => r.set("X-API-Key", API_KEY);

/** Ids seeded into the OTHER organisation, which this caller must never reach. */
const theirs = { projectId: 0, scanId: 0, findingId: 0, publicReport: "their-public", privateReport: "their-private" };
/** Ids seeded into OUR organisation, which this caller must see. */
const ours = { projectId: 0, scanId: 0 };

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
    "POST /scans": "org-scoped",
    "GET /scans/:id": "org-scoped",
    "GET /scans/:id/findings": "org-scoped",
    "POST /scans/multi": "org-scoped",
    "POST /reports": "org-scoped",
    "GET /stats": "org-scoped",
    // A CBOM is the whole inventory in one response — the single worst thing
    // to leak across a tenant boundary, and the reason it is not public.
    "GET /inventory/cbom": "org-scoped",
    // The estate posture timeline reads every asset, project and collection run
    // in the organisation with no where clause at all — the same shape as
    // `GET /projects`, and for the same reason.
    "GET /inventory/timeline": "org-scoped",
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
