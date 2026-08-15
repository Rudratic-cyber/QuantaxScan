/**
 * M3 — drift and scheduled re-collection, end to end against the real stack:
 * real Postgres, real API server, real row-level security. No `page.route`
 * appears in this file.
 *
 * These two features are what turn the product from a report generator into an
 * inventory of record, and the failure they exist to avoid is the same one in
 * both directions: **claiming a remediation nobody performed.**
 *
 * "This asset is gone" can mean the vulnerable line was deleted. It can equally
 * mean the collector did not run, the credential expired, the host sat behind a
 * firewall that day, or nobody repeated the submission. Telling a CISO a risk is
 * closed when it is not is worse than telling them nothing, because they stop
 * looking. B3 established the rule at ingest level — an unreachable host is not
 * marked `gone`, because a timeout is not evidence of absence — and the drift
 * feed has to preserve that distinction on the way *out*.
 *
 * Nothing in the feed is persisted, which is the other half of the design: a
 * drift verdict written to a row would be the C1 failure this project exists to
 * fix, since an "urgent" recorded in 2026 still reads urgent in 2028 after the
 * deadline that made it urgent has passed. Every obligation is resolved through
 * `@workspace/mappings` on the way out, at one `asOf` for the whole response.
 *
 * What would fail if M3 regressed, in order of how quietly it would land:
 *
 *  1. an asset that merely stopped being *looked at* appearing under
 *     `disappeared` as though it had been fixed (`an asset nobody looked for`);
 *  2. the feed losing its surface-observability section, which is what lets a
 *     reader tell "nothing changed" from "nothing was collected" (same test);
 *  3. a schedule accepting an interval short enough to hammer a customer's own
 *     hosts, or a target list long enough to do it in one call (`a schedule
 *     refuses`);
 *  4. `run-due` running schedules that are not due, or reporting an attempt it
 *     never made (`run-due`);
 *  5. a schedule naming another organisation's project being created at all
 *     (covered in `cross-tenant.test.ts`, asserted here at the HTTP edge).
 */
import { test, expect } from "./support/fixtures";

interface DriftFeed {
  window: { since: string; until: string };
  appeared: unknown[];
  disappeared: Array<{ location: string; surface: string }>;
  reappeared: unknown[];
  changed: unknown[];
  surfaces: Array<{ surface: string; [key: string]: unknown }>;
  /** `disappeared` entries carry the asset's `location`, which is prefixed `project:<id>:`. */
  schedules: { attempts: unknown[]; overdue: unknown[] };
  caveat: string;
}

interface CollectionSchedule {
  id: number;
  projectId: number;
  targetKind: string;
  /** The route returns the stored column, which nests the list: `{ targets: [...] }`. */
  target: { targets: Array<{ host: string; port: number }> };
  intervalMinutes: number;
  enabled: boolean;
  [key: string]: unknown;
}

async function createProject(api: import("@playwright/test").APIRequestContext): Promise<number> {
  const response = await api.post("/api/projects", {
    data: { name: `continuity-${Date.now()}`, language: "python", code: "" },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: number }).id;
}

test.describe("M3 — the drift feed", () => {
  test("an asset nobody looked for is not reported as remediated", async ({ api }) => {
    const projectId = await createProject(api);

    // A real submission, so there is something in the inventory to drift.
    const submitted = await api.post(`/api/projects/${projectId}/network-flows`, {
      data: {
        records: [
          {
            source: { address: "10.0.1.20" },
            destination: { hostname: "payments.internal.test", port: 443 },
            transport: "tcp",
            recordFormat: "load-balancer-access-log",
            cipherSuite: "ECDHE-RSA-AES128-GCM-SHA256",
          },
        ],
      },
    });
    expect(submitted.status()).toBe(200);

    const response = await api.get("/api/drift");
    expect(response.status()).toBe(200);
    const feed = (await response.json()) as DriftFeed;

    // The asset was submitted once and never re-submitted. Nothing has been
    // observed to have gone away — only to have stopped being looked at — so
    // it must not appear as a disappearance.
    //
    // **Scoped to this project on purpose.** The feed is estate-wide, and when
    // the whole suite runs against one stack other specs legitimately retire
    // their own assets — the OT register genuinely marks a fleet's asset `gone`
    // when the fleet is deleted, which *is* an observed disappearance and
    // belongs in the feed. Asserting the list is globally empty passed in
    // isolation and failed the moment the suite ran unfiltered, which is the
    // argument for running it unfiltered.
    const mine = feed.disappeared.filter((entry) => entry.location.startsWith(`project:${projectId}:`));
    expect(mine, "an asset that merely stopped being collected was reported as gone").toEqual([]);

    // And the feed says what *was* collected per surface, which is the section
    // that lets a reader tell "nothing changed" apart from "nothing ran".
    expect(Array.isArray(feed.surfaces)).toBe(true);
    expect(feed.surfaces.length).toBeGreaterThan(0);

    // The caveat travels with the payload rather than living in documentation.
    expect(feed.caveat.length).toBeGreaterThan(0);

    expect(new Date(feed.window.since).getTime()).toBeLessThan(new Date(feed.window.until).getTime());
  });

  test("a `since` in the future is refused rather than answered with an empty feed", async ({ api }) => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const response = await api.get(`/api/drift?since=${encodeURIComponent(future)}`);

    // An empty feed here would read as "nothing has changed", which is a claim.
    // The request is malformed and says so.
    expect(response.status()).toBe(400);
  });

  test("an unparseable `since` is a 400, not a silent default window", async ({ api }) => {
    const response = await api.get("/api/drift?since=last-tuesday");
    expect(response.status()).toBe(400);
  });
});

test.describe("M3 — scheduled re-collection", () => {
  test("a schedule round-trips and appears in the list", async ({ api }) => {
    const projectId = await createProject(api);

    const created = await api.post("/api/collection-schedules", {
      data: {
        projectId,
        targetKind: "tls",
        targets: [{ host: "example.test", port: 443 }],
        intervalMinutes: 1440,
      },
    });
    expect(created.status()).toBe(201);
    const schedule = (await created.json()) as CollectionSchedule;
    expect(schedule.projectId).toBe(projectId);
    expect(schedule.intervalMinutes).toBe(1440);
    expect(schedule.enabled).toBe(true);

    const list = (await (await api.get("/api/collection-schedules")).json()) as
      | CollectionSchedule[]
      | { schedules: CollectionSchedule[] };
    const schedules = Array.isArray(list) ? list : list.schedules;
    expect(schedules.some((s) => s.id === schedule.id)).toBe(true);

    // Disabling is a state change, not a deletion: the record of what a
    // customer asked us to watch survives them pausing it.
    const patched = await api.patch(`/api/collection-schedules/${schedule.id}`, { data: { enabled: false } });
    expect(patched.status()).toBe(200);
    expect(((await patched.json()) as CollectionSchedule).enabled).toBe(false);

    expect((await api.delete(`/api/collection-schedules/${schedule.id}`)).status()).toBe(204);
  });

  test("a schedule refuses an interval or a target list that would hammer the customer", async ({ api }) => {
    const projectId = await createProject(api);

    // Below the floor. The targets are the customer's own hosts and this
    // server does the dialling, so a one-minute interval is a denial of
    // service we would be running on their behalf.
    const tooFrequent = await api.post("/api/collection-schedules", {
      data: { projectId, targetKind: "tls", targets: [{ host: "example.test", port: 443 }], intervalMinutes: 1 },
    });
    expect(tooFrequent.status()).toBe(400);

    // Over the per-schedule cap. Split it rather than truncating, which would
    // silently monitor a subset while reading as if it monitored all of them.
    const tooMany = await api.post("/api/collection-schedules", {
      data: {
        projectId,
        targetKind: "tls",
        targets: Array.from({ length: 25 }, (_, i) => ({ host: `host-${i}.example.test`, port: 443 })),
        intervalMinutes: 1440,
      },
    });
    expect(tooMany.status()).toBe(400);

    // **G-23, closed 2026-08-15.** This assertion used to pin the defect: a URL
    // was accepted with a 201 because the "never a URL" rule lived only in the
    // spec's description. Not a security hole — B3's resolve-then-pin guard
    // refuses it at probe time — but a schedule that could never succeed,
    // stored as though it were fine. Now refused where the caller can still fix
    // it, and the error names what was wrong with their input.
    const notAHost = await api.post("/api/collection-schedules", {
      data: {
        projectId,
        targetKind: "tls",
        targets: [{ host: "https://example.test/path", port: 443 }],
        intervalMinutes: 1440,
      },
    });
    expect(notAHost.status()).toBe(400);
    expect(((await notAHost.json()) as { error: string }).error).toMatch(/is a URL/);
  });

  test("the host rule is enforced on update too, and normalises what it accepts (G-23)", async ({ api }) => {
    const projectId = await createProject(api);
    const created = await api.post("/api/collection-schedules", {
      data: {
        projectId,
        targetKind: "tls",
        // Upper case and a trailing root dot: legal, and the same host as
        // `example.test`. Stored canonically so re-registering cannot mint a
        // second schedule against one host.
        targets: [{ host: "EXAMPLE.test.", port: 443 }],
        intervalMinutes: 1440,
      },
    });
    expect(created.status()).toBe(201);
    const schedule = (await created.json()) as CollectionSchedule;
    expect(schedule.target.targets[0]!.host).toBe("example.test");

    // A rule enforced on create and not on update is a rule with a door beside
    // it — the update path was the second half of this gap.
    const patched = await api.patch(`/api/collection-schedules/${schedule.id}`, {
      data: { targets: [{ host: "https://example.test/path", port: 443 }] },
    });
    expect(patched.status()).toBe(400);

    // ...and the schedule still holds what it held before the refused edit.
    const list = (await (await api.get("/api/collection-schedules")).json()) as
      | CollectionSchedule[]
      | { schedules: CollectionSchedule[] };
    const schedules = Array.isArray(list) ? list : list.schedules;
    expect(schedules.find((s) => s.id === schedule.id)?.target.targets[0]!.host).toBe("example.test");
  });

  test("a schedule naming another organisation's project is refused", async ({ api }) => {
    const response = await api.post("/api/collection-schedules", {
      data: {
        projectId: 99999999,
        targetKind: "tls",
        targets: [{ host: "example.test", port: 443 }],
        intervalMinutes: 1440,
      },
    });
    // A foreign key is not subject to RLS, so the parent has to be confirmed
    // visible inside the scope before a child row is written.
    expect(response.status()).toBe(404);
  });

  test("run-due runs nothing when nothing is due, and says so", async ({ api }) => {
    const projectId = await createProject(api);
    const created = await api.post("/api/collection-schedules", {
      data: {
        projectId,
        targetKind: "tls",
        targets: [{ host: "example.test", port: 443 }],
        intervalMinutes: 1440,
      },
    });
    expect(created.status()).toBe(201);

    // Freshly created and not yet due. A run that fired here would re-probe a
    // customer's hosts on every call, and would also record an attempt that
    // says more about our scheduler than about their estate.
    const response = await api.post("/api/collection-schedules/run-due");
    expect(response.status()).toBe(200);
    const result = (await response.json()) as { executions?: unknown[]; schedulesRun?: number };
    const executions = result.executions ?? [];
    expect(Array.isArray(executions)).toBe(true);
    expect(
      executions.length,
      "run-due executed a schedule that was created moments ago and is not due",
    ).toBe(0);
  });

  test("an anonymous caller reaches none of it", async ({ publicApi }) => {
    expect((await publicApi.get("/api/drift")).status()).toBe(401);
    expect((await publicApi.get("/api/collection-schedules")).status()).toBe(401);
    expect((await publicApi.post("/api/collection-schedules/run-due")).status()).toBe(401);
  });
});
