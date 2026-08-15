/**
 * EP — the `endpoint` surface (Windows and Linux host fleets), end to end
 * against the real stack: real Postgres, real API server, real row-level
 * security. No `page.route` appears in this file.
 *
 * **No agent ships with this product, and that is the thing to keep in view
 * while reading these assertions.** What exists is the report format a host
 * agent — or a customer's existing configuration-management tooling — reports
 * *against*, plus the ingest that persists it. So the fixtures below are what
 * such a report looks like: a Windows domain controller's Schannel policy and
 * machine certificate store, and a Linux host with a machine-id and almost
 * nothing else.
 *
 * The surface's honesty problem is specific and worth naming, because `live`
 * claims less here than elsewhere: **an enabled cipher suite is a permitted
 * algorithm, not a negotiated one.** A Windows suite list is an upper bound on
 * what the host would accept and most of it is never selected. That is why the
 * TLS surface (B3) exists separately, and why nothing here may be read as
 * evidence of what a connection actually used.
 *
 * What would fail if EP regressed, in order of how quietly it would land:
 *
 *  1. a suite the host's policy *disables* still producing an asset — a finding
 *     about cryptography the host refuses to use (`a disabled algorithm`);
 *  2. a placeholder or duplicated machine id being ingested, which merges two
 *     real servers into one row or mints a row for a fleet's factory default
 *     (`a placeholder machine id`);
 *  3. a host that was read and declares nothing being treated the same as one
 *     that was never read — the first is a completed run with zero
 *     observations, the second is no run at all (`a host that declares
 *     nothing`);
 *  4. an unrecognised suite token being guessed at rather than passed over,
 *     which is how a post-quantum suite becomes a vulnerable one (same test);
 *  5. a skipped host vanishing from the response instead of being named.
 */
import { test, expect } from "./support/fixtures";

interface EndpointHostResult {
  machineId: string;
  hostname: string | null;
  skipped: "placeholder-machine-id" | "duplicate-machine-id" | "nothing-collected" | null;
  observationsCreated: number;
  certificatesRead: number;
  cipherSuiteDeclarations: number;
  suppressedSuites: unknown[];
  undecodedSuites: unknown[];
}

interface EndpointIngestSummary {
  projectId: number;
  hostsSubmitted: number;
  hostsIngested: number;
  collectionRunId: number | null;
  assetsCreated: number;
  assetsUpdated: number;
  observationsCreated: number;
  assetsMarkedGone: number;
  hosts: EndpointHostResult[];
  evidenceCaveat: string;
}

const WINDOWS_MACHINE_ID = "9f5a1e2c-4b6d-4f21-9c11-6a7b8c9d0e1f";
const LINUX_MACHINE_ID = "4d3c2b1a5e6f70819a2b3c4d5e6f7081";

/** A Windows host whose policy enables one suite and disables an algorithm outright. */
const WINDOWS_HOST = {
  machineId: WINDOWS_MACHINE_ID,
  machineIdSource: "windows-machine-guid",
  hostname: "dc-01",
  os: { family: "windows", name: "Windows Server", version: "2022", build: "20348" },
  tlsPolicy: {
    provider: "schannel",
    cipherSuites: [
      { name: "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384", enabled: true },
      // Enabled in the list, and made unnegotiable by the `Ciphers` subkey
      // below. A host that lists a suite and then disables the cipher it needs
      // will never negotiate it, so reporting it would be a finding about
      // cryptography this host refuses to use.
      { name: "TLS_RSA_WITH_RC4_128_SHA", enabled: true },
      // Disabled outright: nothing from it may be reported at all.
      { name: "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256", enabled: false },
      // ChaCha20 is in nothing this product catalogues. The suite still
      // declares ECDHE and RSA, so it is not "undecoded" — the point is that
      // the bulk cipher contributes *nothing* rather than resolving to the
      // nearest thing that looks similar.
      { name: "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256", enabled: true },
      // A suite in which nothing at all resolves — a post-quantum KEM and
      // signature, no classical token anywhere. This is the case that must
      // pass over in silence and be reported as undecoded, because guessing
      // here would report a quantum-*resistant* host as vulnerable.
      { name: "TLS_MLKEM768_MLDSA65", enabled: true },
    ],
    // Schannel's registry vocabulary, matched exactly rather than parsed.
    disabledAlgorithms: ["RC4 128/128"],
  },
};

async function createProject(api: import("@playwright/test").APIRequestContext): Promise<number> {
  const response = await api.post("/api/projects", {
    data: { name: `endpoint-${Date.now()}`, language: "python", code: "" },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: number }).id;
}

test.describe("EP — the endpoint / host-fleet surface", () => {
  test("a host's enabled suites become assets, and its disabled ones do not", async ({ api }) => {
    const projectId = await createProject(api);

    const response = await api.post(`/api/projects/${projectId}/endpoint`, { data: { hosts: [WINDOWS_HOST] } });
    expect(response.status()).toBe(200);
    const summary = (await response.json()) as EndpointIngestSummary;

    expect(summary.hostsSubmitted).toBe(1);
    expect(summary.hostsIngested).toBe(1);
    expect(summary.collectionRunId).not.toBeNull();
    expect(summary.observationsCreated).toBeGreaterThan(0);

    const host = summary.hosts[0]!;
    expect(host.machineId).toBe(WINDOWS_MACHINE_ID);
    expect(host.skipped).toBeNull();
    expect(host.cipherSuiteDeclarations).toBeGreaterThan(0);

    // The RC4 suite was listed as enabled and then made unnegotiable by the
    // `Ciphers` subkey. It must be suppressed — and the suppression reported,
    // so an operator can audit what we decided not to tell them rather than
    // finding a silent gap.
    expect(host.suppressedSuites.length).toBeGreaterThan(0);
    // The post-quantum suite resolves to nothing and is returned as undecoded
    // rather than guessed at. `undecodedSuites` fires only when *no* token in
    // the name resolves — the ChaCha20 suite above still declares its ECDHE and
    // RSA, so it is correctly absent from this list while its bulk cipher
    // contributes nothing.
    expect(host.undecodedSuites).toContain("TLS_MLKEM768_MLDSA65");

    // The caveat is the sentence that stops a reader treating a permitted
    // algorithm as a negotiated one. It travels with the payload rather than
    // living in documentation a client never reads.
    expect(summary.evidenceCaveat).toContain("permitted algorithm");
  });

  test("a placeholder machine id is refused by name, not ingested", async ({ api }) => {
    const projectId = await createProject(api);

    const summary = (await (
      await api.post(`/api/projects/${projectId}/endpoint`, {
        data: {
          hosts: [
            // The Windows factory default. Structurally a valid GUID, and
            // identical across every host imaged from the same template —
            // ingesting it would merge an entire fleet into one row.
            { machineId: "00000000-0000-0000-0000-000000000000", hostname: "ghost-01" },
            WINDOWS_HOST,
          ],
        },
      })
    ).json()) as EndpointIngestSummary;

    expect(summary.hostsSubmitted).toBe(2);
    expect(summary.hostsIngested).toBe(1);

    // Named in the response rather than dropped: a host silently missing from
    // a result is indistinguishable from one with nothing to report, and only
    // one of those is a problem an operator can fix.
    const refused = summary.hosts.find((h) => h.machineId === "00000000-0000-0000-0000-000000000000");
    expect(refused, "the refused host is missing from the response entirely").toBeDefined();
    expect(refused!.skipped).toBe("placeholder-machine-id");
    expect(refused!.observationsCreated).toBe(0);
  });

  test("two hosts claiming one machine id are both refused, not silently deduplicated", async ({ api }) => {
    const projectId = await createProject(api);

    const summary = (await (
      await api.post(`/api/projects/${projectId}/endpoint`, {
        data: {
          hosts: [
            { ...WINDOWS_HOST, hostname: "dc-01" },
            { ...WINDOWS_HOST, hostname: "dc-02" },
          ],
        },
      })
    ).json()) as EndpointIngestSummary;

    // Both, not "the second one". When two reports claim one identity there is
    // no basis for preferring either, and picking one would attribute a
    // server's cryptography to a different server.
    expect(summary.hostsIngested).toBe(0);
    expect(summary.hosts.map((h) => h.skipped)).toEqual(["duplicate-machine-id", "duplicate-machine-id"]);
    expect(summary.collectionRunId).toBeNull();
  });

  test("a host that declares nothing is examined, and a submission of only such hosts is not", async ({ api }) => {
    const projectId = await createProject(api);

    // A Linux host with an identity and no cryptographic declarations at all.
    const summary = (await (
      await api.post(`/api/projects/${projectId}/endpoint`, {
        data: { hosts: [{ machineId: LINUX_MACHINE_ID, machineIdSource: "linux-machine-id", hostname: "app-07" }] },
      })
    ).json()) as EndpointIngestSummary;

    // Nothing was collected from it, so there is nothing to have examined —
    // and no run is recorded. This is the branch that keeps the coverage meter
    // from reporting a fleet as looked-at because someone posted an empty list.
    expect(summary.hostsIngested).toBe(0);
    expect(summary.collectionRunId).toBeNull();
    expect(summary.hosts[0]!.skipped).toBe("nothing-collected");
  });

  test("the fleet reads back with what was suppressed and what could not be decoded", async ({ api }) => {
    const projectId = await createProject(api);
    await api.post(`/api/projects/${projectId}/endpoint`, { data: { hosts: [WINDOWS_HOST] } });

    const response = await api.get(`/api/projects/${projectId}/endpoint`);
    expect(response.status()).toBe(200);
    const fleet = (await response.json()) as {
      hosts: Array<{ machineId: string; hostname: string | null; components: unknown[] }>;
      evidenceCaveat: string;
    };

    expect(fleet.hosts).toHaveLength(1);
    expect(fleet.hosts[0]!.machineId).toBe(WINDOWS_MACHINE_ID);
    expect(fleet.hosts[0]!.components.length).toBeGreaterThan(0);
    expect(fleet.evidenceCaveat.length).toBeGreaterThan(0);
  });

  test("another organisation's project is a 404, not their host fleet", async ({ api }) => {
    expect((await api.get("/api/projects/99999999/endpoint")).status()).toBe(404);
    expect(
      (await api.post("/api/projects/99999999/endpoint", { data: { hosts: [WINDOWS_HOST] } })).status(),
    ).toBe(404);
  });

  test("an anonymous caller reaches none of it", async ({ publicApi }) => {
    expect((await publicApi.get("/api/projects/1/endpoint")).status()).toBe(401);
    expect((await publicApi.post("/api/projects/1/endpoint", { data: { hosts: [WINDOWS_HOST] } })).status()).toBe(401);
  });
});
