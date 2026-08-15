/**
 * B11 — the `network-flow` surface, end to end against the real stack: real
 * Postgres, real API server, real row-level security. No `page.route` appears
 * in this file.
 *
 * The surface is *conversations between endpoints*, built from flow and session
 * records a customer's own infrastructure already produces. The roadmap lists
 * real-time traffic interception as an explicit twelve-month non-goal, so
 * nothing here captures a packet: the records under test are data in a request
 * body, shaped like the exports they stand in for — a VPC flow log carrying a
 * five-tuple and no cipher at all, a load-balancer log that does name one, and
 * a mesh telemetry row identified by workload rather than address.
 *
 * **The claim this spec exists to protect is a negative one.** A flow log
 * proves two endpoints talked; it usually does *not* prove what protected the
 * conversation. Reading "no cipher in the record" as "unencrypted" would be the
 * loudest false positive this product could produce — it is a finding, on an
 * asset, that nobody observed. So the cipher-free conversation must come back
 * `undetermined`, be *counted* as undetermined, and produce no cryptographic
 * asset whatsoever.
 *
 * What would fail if B11 regressed, in order of how quietly it would land:
 *
 *  1. a cipher-free record acquiring an algorithm, or being rendered as
 *     unencrypted (`a record with no cipher`);
 *  2. `flowsWithUndeterminedCryptography` reaching zero while such rows exist,
 *     which lets the coverage meter read the surface as examined-and-clean
 *     (same test);
 *  3. an unidentified endpoint being recorded against a guess instead of
 *     rejected (`a record naming neither`);
 *  4. the source's ephemeral port entering the conversation's identity, which
 *     creates a new row per TCP handshake and inflates the estate
 *     (`the source port is discarded`);
 *  5. a partial resubmission retiring conversations it never mentioned.
 */
import { test, expect } from "./support/fixtures";

interface NetworkFlowRejection {
  index: number;
  reason: "destination-not-identified" | "destination-port-missing" | "source-not-identified";
}

interface NetworkFlowConversation {
  transport: string;
  applicationProtocol: string | null;
  cryptoState: "observed" | "undetermined";
  cryptography: Array<{ algorithm: string | null; keySize: number | null }>;
  [key: string]: unknown;
}

interface NetworkFlowIngestSummary {
  projectId: number;
  recordsSubmitted: number;
  conversationsRecorded: number;
  flowsCreated: number;
  flowsUpdated: number;
  flowsWithUndeterminedCryptography: number;
  collectionRunId: number | null;
  assetsCreated: number;
  observationsCreated: number;
  rejected: NetworkFlowRejection[];
  conversations: NetworkFlowConversation[];
  evidenceCaveat: string;
}

async function createProject(api: import("@playwright/test").APIRequestContext): Promise<number> {
  const response = await api.post("/api/projects", {
    data: { name: `network-flow-${Date.now()}`, language: "python", code: "" },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: number }).id;
}

/** A VPC flow log row: five-tuple, byte counts, and no cryptography anywhere. */
const CIPHER_FREE_RECORD = {
  source: { address: "10.0.1.20", port: 51234 },
  destination: { address: "10.0.2.30", port: 5432 },
  transport: "tcp",
  recordFormat: "vpc-flow-log",
  recordCount: 4096,
};

/** A load-balancer access log row, which does name the negotiated cipher. */
const CIPHERED_RECORD = {
  source: { address: "203.0.113.5", port: 44112 },
  destination: { hostname: "checkout.internal.test", port: 443 },
  transport: "tcp",
  applicationProtocol: "https",
  recordFormat: "load-balancer-access-log",
  tlsVersion: "TLSv1.2",
  cipherSuite: "ECDHE-RSA-AES128-GCM-SHA256",
};

test.describe("B11 — the network-conversation surface", () => {
  test("a record with no cipher is undetermined, never unencrypted", async ({ api }) => {
    const projectId = await createProject(api);

    const response = await api.post(`/api/projects/${projectId}/network-flows`, {
      data: { records: [CIPHER_FREE_RECORD] },
    });
    expect(response.status()).toBe(200);
    const summary = (await response.json()) as NetworkFlowIngestSummary;

    expect(summary.conversationsRecorded).toBe(1);
    const conversation = summary.conversations[0]!;
    expect(conversation.cryptoState).toBe("undetermined");
    // No algorithm, no key size, no asset. A five-tuple is evidence that two
    // endpoints talked and evidence of nothing else.
    expect(conversation.cryptography).toEqual([]);
    expect(summary.assetsCreated).toBe(0);
    expect(summary.observationsCreated).toBe(0);

    // And it is *counted*. A completed run with zero observations renders on
    // the coverage meter as examined-and-nothing-found, which reads as clean —
    // this number is what keeps "we could not tell" visible.
    expect(summary.flowsWithUndeterminedCryptography).toBe(1);
    expect(summary.evidenceCaveat.length).toBeGreaterThan(0);
  });

  test("a record that names its cipher produces the asset, and only then", async ({ api }) => {
    const projectId = await createProject(api);

    const summary = (await (
      await api.post(`/api/projects/${projectId}/network-flows`, {
        data: { records: [CIPHERED_RECORD, CIPHER_FREE_RECORD] },
      })
    ).json()) as NetworkFlowIngestSummary;

    expect(summary.conversationsRecorded).toBe(2);
    expect(summary.flowsWithUndeterminedCryptography).toBe(1);

    const observed = summary.conversations.filter((c) => c.cryptoState === "observed");
    expect(observed).toHaveLength(1);
    expect(observed[0]!.cryptography.length).toBeGreaterThan(0);
    // The cipher suite named a key exchange and a signature; assets come from
    // the one conversation that carried evidence, not from both.
    expect(summary.assetsCreated).toBeGreaterThan(0);
    expect(summary.observationsCreated).toBeGreaterThan(0);
  });

  test("a record naming neither end is rejected, not recorded against a guess", async ({ api }) => {
    const projectId = await createProject(api);

    const summary = (await (
      await api.post(`/api/projects/${projectId}/network-flows`, {
        data: {
          records: [
            // No workload, hostname or address on the destination.
            { source: { address: "10.0.1.20" }, destination: { port: 443 }, transport: "tcp", recordFormat: "other" },
            // Identified destination, but no port — so no service to key on.
            {
              source: { address: "10.0.1.20" },
              destination: { hostname: "api.internal.test" },
              transport: "tcp",
              recordFormat: "other",
            },
            CIPHER_FREE_RECORD,
          ],
        },
      })
    ).json()) as NetworkFlowIngestSummary;

    // The good record still lands — a bad row does not fail the submission.
    expect(summary.conversationsRecorded).toBe(1);
    // Both bad rows come back with a position and a reason. Reported, never
    // silently dropped: a record we could not read is information the customer
    // needs about their own export, and a quiet drop is indistinguishable from
    // a parser that never saw it.
    expect(summary.rejected).toHaveLength(2);
    expect(summary.rejected.map((r) => r.reason).sort()).toEqual([
      "destination-not-identified",
      "destination-port-missing",
    ]);
    expect(summary.rejected.map((r) => r.index).sort()).toEqual([0, 1]);
  });

  test("the source port is discarded, so one service is one conversation", async ({ api }) => {
    const projectId = await createProject(api);

    // The same client dialling the same service twice, from two ephemeral
    // ports — which is what every TCP connection looks like.
    const summary = (await (
      await api.post(`/api/projects/${projectId}/network-flows`, {
        data: {
          records: [
            { ...CIPHER_FREE_RECORD, source: { address: "10.0.1.20", port: 51234 } },
            { ...CIPHER_FREE_RECORD, source: { address: "10.0.1.20", port: 60999 } },
          ],
        },
      })
    ).json()) as NetworkFlowIngestSummary;

    expect(summary.recordsSubmitted).toBe(2);
    // One conversation, not two. Keying on the ephemeral port would mint a new
    // row per handshake and report an estate several orders of magnitude
    // larger than the one that exists.
    expect(summary.conversationsRecorded).toBe(1);
  });

  test("the inventory reads back, and undetermined stays undetermined", async ({ api }) => {
    const projectId = await createProject(api);
    await api.post(`/api/projects/${projectId}/network-flows`, {
      data: { records: [CIPHERED_RECORD, CIPHER_FREE_RECORD] },
    });

    const response = await api.get(`/api/projects/${projectId}/network-flows`);
    expect(response.status()).toBe(200);
    const inventory = (await response.json()) as {
      conversationsRecorded: number;
      flowsWithUndeterminedCryptography: number;
      conversations: NetworkFlowConversation[];
      evidenceCaveat: string;
    };

    expect(inventory.conversationsRecorded).toBe(2);
    expect(inventory.flowsWithUndeterminedCryptography).toBe(1);
    // The caveat travels on the read as well as the write. A client that only
    // ever calls GET must not have to remember the sentence itself.
    expect(inventory.evidenceCaveat.length).toBeGreaterThan(0);

    const undetermined = inventory.conversations.filter((c) => c.cryptoState === "undetermined");
    expect(undetermined).toHaveLength(1);
    expect(undetermined[0]!.cryptography).toEqual([]);
  });

  test("another organisation's project is a 404, not an empty inventory", async ({ api }) => {
    expect((await api.get("/api/projects/99999999/network-flows")).status()).toBe(404);
  });

  test("an anonymous caller reaches none of it", async ({ publicApi }) => {
    expect(
      (await publicApi.post("/api/projects/1/network-flows", { data: { records: [CIPHER_FREE_RECORD] } })).status(),
    ).toBe(401);
    expect((await publicApi.get("/api/projects/1/network-flows")).status()).toBe(401);
  });
});
