/**
 * Two organisations, two keys, through the real stack.
 *
 * Every other e2e spec in this directory runs against the single
 * pre-existing organisation the shared key has always been bound to
 * (`QUANTAXSCAN_API_KEY_ORG_ID`). Before this spec, that was the *only*
 * organisation a deployment could have — the API key ↔ organisation binding
 * was fixed at one key, one id. F2 (docs/Claude/03-features.md) names this
 * gap explicitly: "the isolation is real; the tenants are not yet... there is
 * one organisation, and the shared API key is bound to it."
 *
 * This spec starts the stack with `E2E_SECOND_ORG=1` (see
 * tests/e2e/support/config.ts and global-setup.ts), which:
 *
 *   1. runs `pnpm --filter @workspace/db run create-organization` — the real
 *      operator script, not a raw INSERT — to create a second organisation;
 *   2. starts the API server with `QUANTAXSCAN_API_KEYS=<key1>,<key2>` and
 *      `QUANTAXSCAN_API_KEY_ORG_IDS=1,<second id>`, binding each key to its
 *      own organisation.
 *
 * Everything below goes through real HTTP, the real Express router, real
 * `withOrg`, and the real row-level-security policies described in
 * docs/Claude/13-auth-and-tenancy.md §5 — there is no mock and no seam where
 * a leak could be papered over. Every assertion here is written to actually
 * fail if the second key's requests resolved to the first key's organisation
 * (or vice versa): exact counts, not "at least one", and existence checks
 * from the *other* organisation's key rather than trusting a status code
 * alone.
 */
import { randomUUID } from "node:crypto";
import { test, expect, secondOrganizationId } from "./support/fixtures";
import { SECOND_ORG_ENABLED } from "./support/config";

const unique = (label: string) => `${label}-${randomUUID().slice(0, 8)}`;

test.describe("multi-organisation isolation", () => {
  // Declared, not assumed. Global setup only creates the second organisation
  // and the second key when `E2E_SECOND_ORG=1` is set, so without it there is
  // no second principal for these tests to be about. Skipped with the reason
  // printed rather than left to fail a bare `playwright test` run over
  // configuration — and never silently, which would be the worse failure.
  test.skip(
    !SECOND_ORG_ENABLED,
    "needs E2E_SECOND_ORG=1: global setup creates the second organisation and its API key only on that flag. See this file's header.",
  );

  test("distinct API keys resolve to distinct organisations, and both are usable", async ({ api, secondOrgApi }) => {
    const oursRes = await api.get("/api/projects");
    expect(oursRes.status()).toBe(200);

    const theirsRes = await secondOrgApi.get("/api/projects");
    expect(theirsRes.status()).toBe(200);

    // Confirmed by creating a row with each key and reading back which
    // organisation it landed in — not by asserting on the request, which
    // would only prove the client sent a header, not that the server acted
    // on it correctly.
    const oursName = unique("org-a-binding-project");
    const created = await api.post("/api/projects", {
      data: { name: oursName, language: "python", code: "key = 1" },
    });
    expect(created.status()).toBe(201);
    const ours = await created.json();
    expect(ours.organizationId).toBe(1);

    const theirsName = unique("org-b-binding-project");
    const createdTheirs = await secondOrgApi.post("/api/projects", {
      data: { name: theirsName, language: "python", code: "key = 2" },
    });
    expect(createdTheirs.status()).toBe(201);
    const theirs = await createdTheirs.json();
    expect(theirs.organizationId).toBe(secondOrganizationId());
    expect(theirs.organizationId).not.toBe(ours.organizationId);
  });

  test("a key's project list contains exactly what that key created, never the other organisation's rows", async ({
    api,
    secondOrgApi,
  }) => {
    const oursName = unique("org-a-list-project");
    const theirsName = unique("org-b-list-project");

    const before = await Promise.all([
      api.get("/api/projects").then((r) => r.json()),
      secondOrgApi.get("/api/projects").then((r) => r.json()),
    ]);
    const oursCountBefore = before[0].length;
    const theirsCountBefore = before[1].length;

    await api.post("/api/projects", { data: { name: oursName, language: "python", code: "a = 1" } });
    await secondOrgApi.post("/api/projects", { data: { name: theirsName, language: "python", code: "b = 1" } });

    const oursList = await (await api.get("/api/projects")).json();
    const theirsList = await (await secondOrgApi.get("/api/projects")).json();

    // Each list grew by exactly one, not two — a leaked write would either
    // inflate the wrong side's count or, if it landed in the wrong
    // organisation entirely, leave this side's count unchanged while the
    // other side's grew by two.
    expect(oursList).toHaveLength(oursCountBefore + 1);
    expect(theirsList).toHaveLength(theirsCountBefore + 1);

    const oursNames: string[] = oursList.map((p: { name: string }) => p.name);
    const theirsNames: string[] = theirsList.map((p: { name: string }) => p.name);

    expect(oursNames).toContain(oursName);
    expect(oursNames).not.toContain(theirsName);
    expect(theirsNames).toContain(theirsName);
    expect(theirsNames).not.toContain(oursName);
  });

  test("a project addressed by id is invisible to the other organisation's key, in both directions", async ({
    api,
    secondOrgApi,
  }) => {
    const oursRes = await api.post("/api/projects", {
      data: { name: unique("org-a-address-project"), language: "python", code: "a = 1" },
    });
    const ours = await oursRes.json();

    const theirsRes = await secondOrgApi.post("/api/projects", {
      data: { name: unique("org-b-address-project"), language: "python", code: "b = 1" },
    });
    const theirs = await theirsRes.json();

    // The owning key can read its own row.
    expect((await api.get(`/api/projects/${ours.id}`)).status()).toBe(200);
    expect((await secondOrgApi.get(`/api/projects/${theirs.id}`)).status()).toBe(200);

    // Neither key can read the other's row — 404, not 403, matching the
    // existing single-organisation cross-tenant suite's stated reason: a 403
    // would confirm the row exists.
    const oursSeenByThem = await secondOrgApi.get(`/api/projects/${ours.id}`);
    expect(oursSeenByThem.status()).toBe(404);
    expect(await oursSeenByThem.json()).toEqual({ error: "Project not found" });

    const theirsSeenByUs = await api.get(`/api/projects/${theirs.id}`);
    expect(theirsSeenByUs.status()).toBe(404);
    expect(await theirsSeenByUs.json()).toEqual({ error: "Project not found" });
  });

  test("deleting another organisation's project via the wrong key changes nothing", async ({ api, secondOrgApi }) => {
    const name = unique("org-a-delete-survivor-project");
    const createdRes = await api.post("/api/projects", { data: { name, language: "python", code: "a = 1" } });
    const created = await createdRes.json();

    // The second organisation's key attempts to delete organisation 1's row.
    const deleteRes = await secondOrgApi.delete(`/api/projects/${created.id}`);
    // Same "204 for everything, matched-zero-rows-or-not" shape the existing
    // single-org suite documents (docs/Claude/13-auth-and-tenancy.md §14
    // deviation 8) — the response code is not what proves anything here.
    expect(deleteRes.status()).toBe(204);

    // What proves it: the owning key still sees the row, untouched.
    const survivorRes = await api.get(`/api/projects/${created.id}`);
    expect(survivorRes.status()).toBe(200);
    const survivor = await survivorRes.json();
    expect(survivor.name).toBe(name);
  });

  test("GET /api/stats never leaks the other organisation's project names into recentActivity", async ({
    api,
    secondOrgApi,
  }) => {
    const oursName = unique("org-a-stats-project");
    const theirsName = unique("org-b-stats-project");

    await api.post("/api/projects", { data: { name: oursName, language: "python", code: "key = RSA.generate(2048)" } });
    await secondOrgApi.post("/api/projects", {
      data: { name: theirsName, language: "python", code: "key = RSA.generate(2048)" },
    });

    const oursStats = await (await api.get("/api/stats")).json();
    const theirsStats = await (await secondOrgApi.get("/api/stats")).json();

    const oursActivity = JSON.stringify(oursStats.recentActivity);
    const theirsActivity = JSON.stringify(theirsStats.recentActivity);

    expect(oursActivity).not.toContain(theirsName);
    expect(theirsActivity).not.toContain(oursName);
  });

  test("an unrecognised key is rejected before any organisation binding is even considered", async ({ publicApi }) => {
    const response = await publicApi.get("/api/projects", {
      headers: { "X-API-Key": "not-a-configured-key-at-all-00000000000000" },
    });
    expect(response.status()).toBe(401);
  });
});
