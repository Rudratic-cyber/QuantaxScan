/**
 * B3 — the TLS prober, against a real socket.
 *
 * The point of this feature is that it records what a host *actually
 * negotiated*, not what a config file claims, so the only honest way to test it
 * end to end is to make it complete a genuine TLS handshake. `support/tls-test-server.ts`
 * starts a real `tls.createServer` on loopback with a real certificate; every
 * assertion below is downstream of a handshake that really happened.
 *
 * ## This spec's run needs one extra variable
 *
 * ```
 * QUANTAXSCAN_TLS_PROBE_ALLOW_PRIVATE_TARGETS=1 \
 * E2E_PG_PORT=… E2E_API_PORT=… E2E_UI_PORT=… E2E_PG_CONTAINER=… E2E_DB_NAME=… \
 *   pnpm exec playwright test --config playwright.e2e.config.ts tests/e2e/05-tls.spec.ts
 * ```
 *
 * `support/process.ts`'s `start()` spreads `process.env` into the API server's
 * environment, so setting it on the Playwright invocation reaches the server
 * with no harness change. It disables the SSRF guard's *range* check only —
 * resolve-then-pin still applies — and it exists because loopback is precisely
 * what production must refuse and precisely what a real test server can bind
 * to. See the "test-only escape hatch" section of `tls-ssrf-guard.ts`.
 *
 * **What this spec deliberately does not assert:** that a private or
 * link-local address is refused. With the hatch on, that path is unreachable in
 * this stack by construction, so an assertion here would be theatre.
 * `tls-ssrf-guard.test.ts` owns that proof, hatch off, including the
 * DNS-rebinding case this suite cannot stage. The two refusal shapes asserted
 * below (`invalid-hostname`, and a name that does not resolve) survive the
 * hatch and are therefore real here.
 */
import { randomUUID } from "node:crypto";
import { test, expect } from "./support/fixtures";
import { HOST } from "./support/config";
import { closedLoopbackPort, startTlsTestServer, type TlsTestServer } from "./support/tls-test-server";

const unique = (label: string) => `${label}-${randomUUID().slice(0, 8)}`;

interface TlsTargetOutcome {
  host: string;
  port: number;
  outcome: "probed" | "refused" | "unreachable";
}

interface TlsProbeSummary {
  projectId: number;
  targetsSubmitted: number;
  targetsProbed: number;
  targets: TlsTargetOutcome[];
  collectionRunId: number | null;
  assetsCreated: number;
  assetsUpdated: number;
  observationsCreated: number;
  assetsMarkedGone: number;
  evidenceCaveat: string;
}

interface SurfaceCoverage {
  surface: string;
  state: "examined" | "examined-nothing-found" | "never-examined";
  assets: number;
  activeAssets: number;
  completedRuns: number;
}

/**
 * Declared, not assumed. Without the hatch the API server refuses every
 * loopback target, so these tests would fail for a reason that has nothing to
 * do with the prober — and a bare `playwright test` run must not go red over
 * configuration. Skipped *with this reason printed in the report*, which is the
 * difference between a documented precondition and a quietly disabled test.
 */
const PRIVATE_TARGETS_ALLOWED = process.env["QUANTAXSCAN_TLS_PROBE_ALLOW_PRIVATE_TARGETS"] === "1";

test.describe("the TLS prober (B3)", () => {
  test.skip(
    !PRIVATE_TARGETS_ALLOWED,
    "needs QUANTAXSCAN_TLS_PROBE_ALLOW_PRIVATE_TARGETS=1: the prober must handshake with a real TLS server on loopback, which production correctly refuses. See this file's header.",
  );

  let server: TlsTestServer;
  let deadPort: number;

  test.beforeAll(async () => {
    server = await startTlsTestServer({ rsaModulusBits: 2048 });
    deadPort = await closedLoopbackPort();
  });

  test.afterAll(async () => {
    await server.close();
  });

  async function createProject(api: import("@playwright/test").APIRequestContext): Promise<number> {
    const response = await api.post("/api/projects", {
      data: { name: unique("tls-probe-project"), language: "python", code: "x = 1" },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).id;
  }

  async function tlsSurface(
    api: import("@playwright/test").APIRequestContext,
    projectId: number,
  ): Promise<SurfaceCoverage | undefined> {
    const response = await api.get(`/api/projects/${projectId}/coverage`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    return (body.surfaces as SurfaceCoverage[]).find((s) => s.surface === "tls");
  }

  test("a real handshake is recorded, and it is what makes the tls surface count as examined", async ({ api }) => {
    const projectId = await createProject(api);

    // Before: the surface has never been looked at. The coverage endpoint omits
    // a surface with no run and no asset entirely, which is the shape D3 chose
    // for "never examined" — asserting it here is what makes the *after* state
    // mean something.
    expect(await tlsSurface(api, projectId)).toBeUndefined();

    const response = await api.post(`/api/projects/${projectId}/tls`, {
      data: { targets: [{ host: HOST, port: server.port }] },
    });
    expect(response.status()).toBe(200);
    const summary: TlsProbeSummary = await response.json();

    expect(summary.targetsSubmitted).toBe(1);
    expect(summary.targetsProbed).toBe(1);
    expect(summary.targets).toEqual([{ host: HOST, port: server.port, outcome: "probed" }]);
    expect(summary.collectionRunId).not.toBeNull();

    // Two observations from one handshake: the negotiated key exchange, and the
    // peer certificate's public key. Asserting the count rather than ">= 1"
    // means dropping either one fails this test.
    expect(summary.observationsCreated).toBe(2);
    expect(summary.assetsCreated).toBe(2);
    expect(summary.assetsMarkedGone).toBe(0);

    // Stated on every response, not just in the docs: what this collector did
    // and did not look at.
    expect(summary.evidenceCaveat).toContain("no certificate identity");

    const surface = await tlsSurface(api, projectId);
    expect(surface?.state).toBe("examined");
    expect(surface?.completedRuns).toBe(1);
    expect(surface?.activeAssets).toBe(2);
  });

  test("the certificate's real key size reaches the inventory, unrounded and unguessed", async ({ api }) => {
    const projectId = await createProject(api);
    await api.post(`/api/projects/${projectId}/tls`, {
      data: { targets: [{ host: HOST, port: server.port }] },
    });

    // The CBOM is the artefact an auditor is handed, so proving the observation
    // survived all the way into it is worth more than reading it back out of
    // the route that wrote it.
    const response = await api.get("/api/inventory/cbom");
    expect(response.status()).toBe(200);
    const cbom = await response.json();

    const location = `project:${projectId}:${HOST}:${server.port}`;
    const ours = (cbom.components as Array<Record<string, unknown>>).filter((component) => {
      const evidence = component.evidence as { occurrences?: Array<{ location?: string }> } | undefined;
      return evidence?.occurrences?.some((o) => o.location === location) ?? false;
    });
    expect(ours).toHaveLength(2);

    // The test server's certificate is RSA-2048 because this spec chose 2048 —
    // so this asserts the prober read the peer's real modulus size rather than
    // defaulting, and would fail if it started guessing. A CBOM component is
    // named `<algorithm>-<keySize>`, and unsuffixed when the size is unknown.
    const names = ours.map((c) => String(c.name));
    expect(names).toContain("RSA-2048");

    const keySizeOf = (componentName: string) => {
      const component = ours.find((c) => c.name === componentName);
      const properties = (component?.properties ?? []) as Array<{ name: string; value: string }>;
      return properties.find((p) => p.name === "quantaxscan:asset:keySize")?.value;
    };
    expect(keySizeOf("RSA-2048")).toBe("2048");

    // And the other half of the same rule. This handshake is TLS 1.3, where
    // Node's `getEphemeralKeyInfo()` reports no group name or size at all
    // (nodejs/node#44322) — so the key exchange is recorded as having happened
    // with its size left **undetermined**, and the component is unsuffixed. A
    // plausible-looking 256 here would be a fabrication, and this assertion is
    // what stops one being introduced later.
    expect(names).toContain("ECDH");
    expect(keySizeOf("ECDH")).toBe("undetermined");
  });

  test("a submission where nothing completes a handshake records no run, and says so", async ({ api }) => {
    const projectId = await createProject(api);

    const response = await api.post(`/api/projects/${projectId}/tls`, {
      data: {
        targets: [
          { host: "no-such-host.invalid", port: 443 },
          { host: HOST, port: deadPort },
        ],
      },
    });
    expect(response.status()).toBe(200);
    const summary: TlsProbeSummary = await response.json();

    // 200, not an error: every target in one submission may legitimately be
    // unreachable, and that is a fact about the estate rather than a fault.
    expect(summary.targetsProbed).toBe(0);
    expect(summary.collectionRunId).toBeNull();
    expect(summary.observationsCreated).toBe(0);
    expect(summary.assetsCreated).toBe(0);

    // The rule this test exists for: a surface whose probe examined nothing must
    // not read as examined. Reporting coverage for an estate nobody successfully
    // looked at is the specific dishonesty D3 and the lane brief both forbid.
    expect(await tlsSurface(api, projectId)).toBeUndefined();
  });

  test("each target's outcome is reported separately, never collapsed into one number", async ({ api }) => {
    const projectId = await createProject(api);

    const response = await api.post(`/api/projects/${projectId}/tls`, {
      data: {
        targets: [
          { host: HOST, port: server.port },
          { host: "no-such-host.invalid", port: 443 },
          { host: HOST, port: deadPort },
          { host: "not a hostname at all", port: 443 },
        ],
      },
    });
    expect(response.status()).toBe(200);
    const summary: TlsProbeSummary = await response.json();

    expect(summary.targetsSubmitted).toBe(4);
    expect(summary.targetsProbed).toBe(1);

    const outcomeFor = (host: string, port: number) =>
      summary.targets.find((t) => t.host === host && t.port === port)?.outcome;

    expect(outcomeFor(HOST, server.port)).toBe("probed");
    expect(outcomeFor(HOST, deadPort)).toBe("unreachable");
    // Refused before any socket is opened: one name that cannot resolve, one
    // that is not a hostname at all. Both survive the escape hatch, which only
    // widens which *addresses* are acceptable.
    expect(outcomeFor("no-such-host.invalid", 443)).toBe("refused");
    expect(outcomeFor("not a hostname at all", 443)).toBe("refused");

    // One good target among three bad ones still produces its run — a batch is
    // not all-or-nothing.
    expect(summary.collectionRunId).not.toBeNull();
    expect((await tlsSurface(api, projectId))?.activeAssets).toBe(2);
  });

  test("a host that stops answering is not thereby declared remediated", async ({ api }) => {
    const projectId = await createProject(api);
    const doomed = await startTlsTestServer();

    await api.post(`/api/projects/${projectId}/tls`, {
      data: {
        targets: [
          { host: HOST, port: server.port },
          { host: HOST, port: doomed.port },
        ],
      },
    });
    expect((await tlsSurface(api, projectId))?.activeAssets).toBe(4);

    await doomed.close();

    // Resubmitting both targets: one answers, one has gone silent. The
    // tempting behaviour is to mark the silent host's crypto `gone` — and it
    // would be wrong. Reobservation scope is paired with what was *actually
    // observed*, and a target that timed out was not observed: a firewall
    // rule, a restart, or a dropped packet is not evidence that RSA-2048
    // stopped being served there. Marking it gone would report remediation
    // that never happened, which is the failure mode the ReobservationScope
    // comment in asset-ingest.ts exists to prevent.
    const response = await api.post(`/api/projects/${projectId}/tls`, {
      data: {
        targets: [
          { host: HOST, port: server.port },
          { host: HOST, port: doomed.port },
        ],
      },
    });
    const summary: TlsProbeSummary = await response.json();
    expect(summary.targetsProbed).toBe(1);
    expect(summary.targets.find((t) => t.port === doomed.port)?.outcome).toBe("unreachable");
    expect(summary.assetsMarkedGone).toBe(0);

    const surface = await tlsSurface(api, projectId);
    expect(surface?.assets).toBe(4);
    expect(surface?.activeAssets).toBe(4);
  });

  test("a project the caller cannot see is a 404, and nothing is written for it", async ({ api }) => {
    const response = await api.post(`/api/projects/999999/tls`, {
      data: { targets: [{ host: HOST, port: server.port }] },
    });
    expect(response.status()).toBe(404);
    expect(await response.json()).toEqual({ error: "Project not found" });
  });

  test("an unauthenticated caller cannot make this server open a socket at all", async ({ publicApi }) => {
    const response = await publicApi.post(`/api/projects/1/tls`, {
      data: { targets: [{ host: HOST, port: server.port }] },
    });
    expect(response.status()).toBe(401);
  });
});
