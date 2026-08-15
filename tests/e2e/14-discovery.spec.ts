/**
 * D8 — host discovery from Certificate Transparency, end to end against the
 * real stack: real Postgres, real API server, real row-level security, a real
 * HTTP request leaving the server for its CT source, and the real Node
 * resolver. No `page.route` appears in this file.
 *
 * **The stub is a server, not a mock.** `startCtStub()` below runs an actual
 * `node:http` listener and the API server makes an actual outbound request to
 * it — the SSRF guard, the timeout, the byte cap, the JSON parse and the
 * allowlist check all execute. What the stub replaces is only *which* log
 * answers, through the operator override `ct-log.ts` already supports and warns
 * about. Querying the real crt.sh instead would assert on whatever certificates
 * the internet held this morning, fail in an offline CI, and load somebody
 * else's free service on every run.
 *
 * DNS is pointed at a port with nothing listening (`DEAD_DNS_SERVER`), which is
 * not a limitation of the harness but the case worth proving: an unreachable
 * resolver must produce `undetermined`, never `not-resolved`.
 *
 * What would fail if D8 regressed, in order of how quietly it would land:
 *
 *  1. an unreachable resolver being read as "this host does not exist"
 *     (`a resolver that cannot answer`) — the failure that retires a real
 *     target and shrinks the estate on paper;
 *  2. `isWithinDomain` becoming a substring test, so `example.com.evil.test`
 *     and `notexample.com` enter a customer's inventory (`names outside the
 *     domain`);
 *  3. a wildcard SAN being accepted as a host, inventing a name nothing has
 *     evidence for (`a wildcard is not a host`);
 *  4. a re-run resetting `firstDiscoveredAt`, losing when a name was first
 *     seen (`re-running discovery`);
 *  5. a discovered name being written into `assets` — discovery examines
 *     nothing, so a lead must never read as an observation (`a discovered name
 *     is not an asset`).
 */
import { createServer, type Server } from "node:http";
import { test, expect } from "./support/fixtures";
import { CT_STUB_PORT, HOST } from "./support/config";

/** One crt.sh row, in the shape the real service returns. */
interface CrtShRow {
  id: number;
  issuer_name: string;
  common_name: string;
  name_value: string;
  not_before: string;
  not_after: string;
  serial_number: string;
}

const DOMAIN = "example-estate.test";

function row(overrides: Partial<CrtShRow> & { name_value: string }): CrtShRow {
  return {
    id: 1_000_000 + Math.floor(overrides.name_value.length * 7919),
    issuer_name: "C=US, O=Let's Encrypt, CN=R3",
    common_name: overrides.name_value.split("\n")[0] ?? "",
    not_before: "2025-01-01T00:00:00",
    not_after: "2035-01-01T00:00:00",
    serial_number: "04a1b2c3",
    ...overrides,
  };
}

/**
 * The fixture estate. Four names that must be accepted and four that must not,
 * because a spec made only of accepted names proves nothing about what the
 * feature refuses.
 */
const CT_RESPONSE: CrtShRow[] = [
  row({ name_value: `www.${DOMAIN}` }),
  row({ name_value: `api.${DOMAIN}\nstaging.${DOMAIN}` }),
  row({ name_value: `MAIL.${DOMAIN}.` }), // upper case + root dot: normalised, not rejected
  row({ name_value: `*.${DOMAIN}` }), // wildcard — covers a set, evidence for none
  row({ name_value: `${DOMAIN}.evil.test` }), // the lookalike a substring match would accept
  row({ name_value: `not${DOMAIN}` }), // ...and the other one
  row({ name_value: "203.0.113.10" }), // an IP literal is a target but not a name
  row({ name_value: "intranet" }), // single label, unresolvable outside a search domain
];

async function startCtStub(response: unknown, status = 200): Promise<Server> {
  const server = createServer((req, res) => {
    // The real crt.sh takes the domain as a query parameter, which is the only
    // client-influenced part of the URL — assert the server kept it that way.
    const url = new URL(req.url ?? "/", `http://${HOST}:${CT_STUB_PORT}`);
    lastQuery = { path: url.pathname, params: Object.fromEntries(url.searchParams) };
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve) => server.listen(CT_STUB_PORT, HOST, resolve));
  return server;
}

let lastQuery: { path: string; params: Record<string, string> } | null = null;

interface DiscoveredTarget {
  id: number;
  hostname: string;
  sourceDomain: string;
  discoveryMethod: string;
  evidence: { entryId: number | null; issuerName: string | null; rawName: string } | null;
  certificateExpired: boolean | null;
  dnsResolution: "resolved" | "not-resolved" | "undetermined" | null;
  resolvedAddresses: string[] | null;
  dnsCheckedAt: string | null;
  firstDiscoveredAt: string;
  lastDiscoveredAt: string;
  examined: boolean;
  examinedPorts: number[];
}

interface DiscoveryRunSummary {
  projectId: number;
  domain: string;
  namesRead: number;
  namesAccepted: number;
  /** `rawName` is the string the log carried, before normalisation — so what was refused can be audited against what was said. */
  rejected: Array<{ rawName: string; reason: string }>;
  targetsCreated: number;
  targetsUpdated: number;
  knownTargets: number;
  dns: Record<string, number>;
  targets: DiscoveredTarget[];
  evidenceCaveat: string;
}

async function createProject(api: import("@playwright/test").APIRequestContext): Promise<number> {
  const response = await api.post("/api/projects", {
    data: { name: `discovery-${Date.now()}`, language: "python", code: "" },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: number }).id;
}

test.describe("D8 — discovery from certificate transparency", () => {
  let stub: Server;

  test.beforeAll(async () => {
    stub = await startCtStub(CT_RESPONSE);
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  test("accepts the names inside the domain and reports every one it refused", async ({ api }) => {
    const projectId = await createProject(api);

    const response = await api.post(`/api/projects/${projectId}/discovery`, { data: { domain: DOMAIN } });
    expect(response.status()).toBe(200);
    const summary = (await response.json()) as DiscoveryRunSummary;

    const accepted = summary.targets.map((t) => t.hostname).sort();
    expect(accepted).toEqual([`api.${DOMAIN}`, `mail.${DOMAIN}`, `staging.${DOMAIN}`, `www.${DOMAIN}`]);
    expect(summary.targetsCreated).toBe(4);

    // Every refusal is reported with its reason rather than silently dropped:
    // a name we declined to act on is information the customer needs, and a
    // quiet drop is indistinguishable from a parser that never saw it.
    const rejected = Object.fromEntries(summary.rejected.map((r) => [r.rawName, r.reason]));
    expect(rejected[`*.${DOMAIN}`]).toBe("wildcard");
    expect(rejected[`${DOMAIN}.evil.test`]).toBe("out-of-scope");
    expect(rejected[`not${DOMAIN}`]).toBe("out-of-scope");
    expect(rejected["203.0.113.10"]).toBe("ip-literal");
    expect(rejected["intranet"]).toBe("not-a-hostname");

    // The caveat travels with the payload. A CT name is a lead; the sentence
    // saying so must not be something a client has to remember to add.
    expect(summary.evidenceCaveat.length).toBeGreaterThan(0);

    // Only the query parameter is client-influenced — the path is ours.
    expect(lastQuery?.params["q"] ?? lastQuery?.params["Q"] ?? "").toContain(DOMAIN);
  });

  test("a wildcard is not a host, and a lookalike domain is not the customer's", async ({ api }) => {
    const projectId = await createProject(api);
    await api.post(`/api/projects/${projectId}/discovery`, { data: { domain: DOMAIN } });

    const targets = (await (
      await api.get(`/api/projects/${projectId}/discovered-targets`)
    ).json()) as { targets: DiscoveredTarget[] };
    const names = targets.targets.map((t) => t.hostname);

    // The three that would arrive if `isWithinDomain` were a substring test or
    // if a wildcard were treated as evidence of a host.
    expect(names).not.toContain(`*.${DOMAIN}`);
    expect(names).not.toContain(`${DOMAIN}.evil.test`);
    expect(names).not.toContain(`not${DOMAIN}`);
  });

  test("a resolver that cannot answer leaves the target undetermined, never absent", async ({ api }) => {
    const projectId = await createProject(api);
    const summary = (await (
      await api.post(`/api/projects/${projectId}/discovery`, { data: { domain: DOMAIN } })
    ).json()) as DiscoveryRunSummary;

    for (const target of summary.targets) {
      // The whole point. `not-resolved` here would be a claim that these hosts
      // do not exist, made on the evidence that our own resolver was down —
      // and acting on it retires a live target.
      expect(target.dnsResolution, `${target.hostname} was attributed to a resolver that never answered`).toBe(
        "undetermined",
      );
      expect(target.resolvedAddresses).toEqual([]);
      // It *was* attempted, which is distinct from never having looked.
      expect(target.dnsCheckedAt).not.toBeNull();
    }
    expect(summary.dns["undetermined"]).toBe(4);
    expect(summary.dns["notResolved"] ?? 0).toBe(0);
  });

  test("a discovered name is not an asset — discovery examines nothing", async ({ api }) => {
    const projectId = await createProject(api);
    await api.post(`/api/projects/${projectId}/discovery`, { data: { domain: DOMAIN } });

    // A lead must not appear in the inventory or move the coverage meter: we
    // have looked at no cryptography on any of these hosts, and a surface that
    // counted them would report an examination that never happened.
    const coverage = (await (await api.get(`/api/projects/${projectId}/coverage`)).json()) as {
      surfaces: Array<{ surface: string; state: string }>;
    };
    for (const surface of coverage.surfaces) {
      expect(surface.state, `discovery moved the ${surface.surface} surface off never-examined`).toBe(
        "never-examined",
      );
    }

    const targets = (await (
      await api.get(`/api/projects/${projectId}/discovered-targets`)
    ).json()) as { targets: DiscoveredTarget[] };
    for (const target of targets.targets) {
      expect(target.examined).toBe(false);
      expect(target.examinedPorts).toEqual([]);
    }
  });

  test("re-running discovery updates the evidence and keeps first-seen", async ({ api }) => {
    const projectId = await createProject(api);
    const first = (await (
      await api.post(`/api/projects/${projectId}/discovery`, { data: { domain: DOMAIN } })
    ).json()) as DiscoveryRunSummary;

    const second = (await (
      await api.post(`/api/projects/${projectId}/discovery`, { data: { domain: DOMAIN } })
    ).json()) as DiscoveryRunSummary;

    expect(second.targetsCreated).toBe(0);
    expect(second.targetsUpdated).toBe(4);
    expect(second.knownTargets).toBe(4);

    const firstSeen = new Map(first.targets.map((t) => [t.hostname, t.firstDiscoveredAt]));
    for (const target of second.targets) {
      // When a name was first seen is a fact about history. A re-run that
      // reset it would make every host look newly discovered, which is the
      // number a migration programme is scheduled against.
      expect(target.firstDiscoveredAt).toBe(firstSeen.get(target.hostname));
      expect(new Date(target.lastDiscoveredAt).getTime()).toBeGreaterThanOrEqual(
        new Date(target.firstDiscoveredAt).getTime(),
      );
    }
  });

  test("another organisation's project is a 404, not an empty list", async ({ api }) => {
    const response = await api.get("/api/projects/99999999/discovered-targets");
    // An empty list would confirm the project exists and has nothing, which is
    // a different and false statement — and which projects a company has is
    // itself information.
    expect(response.status()).toBe(404);
  });

  test("an anonymous caller reaches none of it", async ({ publicApi }) => {
    expect((await publicApi.post("/api/projects/1/discovery", { data: { domain: DOMAIN } })).status()).toBe(401);
    expect((await publicApi.get("/api/projects/1/discovered-targets")).status()).toBe(401);
  });
});

test.describe("D8 — when the certificate-transparency source fails", () => {
  test("a source that answers with an error is a 502 that blames the source", async ({ api }) => {
    const stub = await startCtStub({ error: "rate limited" }, 429);
    try {
      const projectId = await createProject(api);
      const response = await api.post(`/api/projects/${projectId}/discovery`, { data: { domain: DOMAIN } });

      // Not a 500 and not a 200 with an empty list. An empty list here would
      // read as "this domain has no certificates", which is the strongest
      // possible false statement this feature could make.
      expect(response.status()).toBe(502);
      expect(((await response.json()) as { reason: string }).reason).toBe("source-error");

      const targets = (await (
        await api.get(`/api/projects/${projectId}/discovered-targets`)
      ).json()) as { targets: DiscoveredTarget[] };
      expect(targets.targets).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });
});
