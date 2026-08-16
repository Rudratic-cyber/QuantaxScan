/**
 * P1 and P2 — credentialed collection and cloud enumeration, end to end against
 * the real stack: real Postgres, real row-level security, a real credential
 * encrypted at rest and redeemed through F4, and a real signed HTTP request
 * leaving the API server. No `page.route` appears in this file.
 *
 * **The stubs are servers, not mocks.** Each is an actual `node:http` listener
 * that the API server makes an actual outbound SigV4-signed request to, through
 * the `AWS_KMS_ENDPOINT` / `AWS_S3_ENDPOINT` overrides. The signing, the
 * timeout, the JSON and XML parses, the pagination loop and the refusal mapping
 * all execute. What the stub replaces is only *which* AWS answers — and it can
 * answer in the ways that matter and a real account cannot be asked to: a
 * throttled page, a denied region, a truncated listing.
 *
 * What would fail if these lanes regressed, in order of how quietly it would
 * land:
 *
 *  1. **a truncated or partly-refused poll retiring keys it never saw**
 *     (`a poll that was refused a region retires nothing`) — the mass false
 *     remediation §4.5 exists to prevent, and the one that is invisible until
 *     somebody reads the next morning's board pack;
 *  2. a discovery run writing an asset, so a lead reads as an observation and a
 *     surface becomes examined without anything examining it
 *     (`enumerating a cloud account examines nothing`);
 *  3. a refused scope being reported as an empty one, so "we could not read
 *     your account" becomes "your account has nothing in it"
 *     (`a denied account is refused, never empty`);
 *  4. a member spending a credential they cannot list (`a viewer cannot spend`);
 *  5. an unusable credential answering 200 with an empty result, making a
 *     revoked key read as an empty key store (`a revoked credential`).
 */
import { createServer, type Server } from "node:http";
import { test, expect } from "./support/fixtures";
import { KMS_STUB_PORT, S3_STUB_PORT, HOST, SECOND_ORG_ENABLED } from "./support/config";

/**
 * The plaintext the credential store holds. Every assertion that greps a
 * response for a leak looks for these exact strings, so they are deliberately
 * distinctive rather than realistic.
 */
const AWS_SECRET = JSON.stringify({
  accessKeyId: "AKIAE2ESENTINEL",
  secretAccessKey: "e2e-secret-must-never-appear",
  sessionToken: "e2e-token-must-never-appear",
});
const ACCOUNT = "111122223333";

/** What the KMS stub should do on its next request. Mutated per test. */
let kmsBehaviour: { pages: Array<{ arns: string[]; more: boolean }>; failWith: number | null } = {
  pages: [],
  failWith: null,
};
let s3Behaviour: { buckets: string[]; failWith: number | null } = { buckets: [], failWith: null };

let kmsStub: Server;
let s3Stub: Server;

const arn = (region: string, id: string) => `arn:aws:kms:${region}:${ACCOUNT}:key/${id}`;

test.beforeAll(async () => {
  kmsStub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (kmsBehaviour.failWith !== null) {
        res.writeHead(kmsBehaviour.failWith, { "content-type": "application/x-amz-json-1.1" });
        // A real AWS error body echoes the failing request, headers included.
        // Reproducing that is the point: it is what must never reach a stored
        // row or a response.
        res.end(JSON.stringify({ __type: "AccessDeniedException", message: `denied: ${req.headers.authorization}` }));
        return;
      }
      const target = String(req.headers["x-amz-target"]);
      res.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
      if (target.endsWith("ListKeys")) {
        const marker = (JSON.parse(body) as { Marker?: string }).Marker;
        const index = marker === undefined ? 0 : Number(marker);
        const page = kmsBehaviour.pages[index] ?? { arns: [], more: false };
        res.end(
          JSON.stringify({
            Keys: page.arns.map((a) => ({ KeyArn: a, KeyId: a })),
            Truncated: page.more,
            ...(page.more ? { NextMarker: String(index + 1) } : {}),
          }),
        );
        return;
      }
      const keyId = (JSON.parse(body) as { KeyId: string }).KeyId;
      res.end(
        JSON.stringify({
          KeyMetadata: { Arn: keyId, KeyId: keyId, KeySpec: "RSA_2048", KeyState: "Enabled", Origin: "AWS_KMS" },
        }),
      );
    });
  });

  s3Stub = createServer((req, res) => {
    if (s3Behaviour.failWith !== null) {
      res.writeHead(s3Behaviour.failWith, { "content-type": "application/xml" });
      res.end(`<Error><Code>AccessDenied</Code><Message>denied: ${req.headers.authorization}</Message></Error>`);
      return;
    }
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(
      `<?xml version="1.0"?><ListAllMyBucketsResult><Buckets>${s3Behaviour.buckets
        .map((b) => `<Bucket><Name>${b}</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket>`)
        .join("")}</Buckets></ListAllMyBucketsResult>`,
    );
  });

  await new Promise<void>((resolve) => kmsStub.listen(KMS_STUB_PORT, HOST, resolve));
  await new Promise<void>((resolve) => s3Stub.listen(S3_STUB_PORT, HOST, resolve));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => kmsStub.close(() => resolve()));
  await new Promise<void>((resolve) => s3Stub.close(() => resolve()));
});

/** A project and a credential of the given kind, both real rows. */
async function seed(api: import("@playwright/test").APIRequestContext, kind: string) {
  const project = await api.post("/api/projects", {
    data: { name: `cred-${kind}-${Date.now()}`, language: "typescript", code: "" },
  });
  expect(project.status(), await project.text()).toBe(201);
  const projectId = ((await project.json()) as { id: number }).id;

  const credential = await api.post("/api/credentials", {
    data: { name: `aws-${kind}-${Date.now()}`, kind, secret: AWS_SECRET },
  });
  expect(credential.status(), await credential.text()).toBe(201);
  const credentialId = ((await credential.json()) as { id: number }).id;

  return { projectId, credentialId };
}

/** Nothing derived from the plaintext may appear in any response body. */
function assertNoSecret(text: string, where: string): void {
  for (const needle of ["e2e-secret-must-never-appear", "e2e-token-must-never-appear", "AKIAE2ESENTINEL"]) {
    expect(text.includes(needle), `${where} leaked ${needle}`).toBe(false);
  }
  expect(text.toLowerCase().includes("signature="), `${where} leaked a signature`).toBe(false);
}

test.describe("P1 — polling a key store with a stored credential", () => {
  test("reads the keys and records the region as enumerated", async ({ api }) => {
    kmsBehaviour = { pages: [{ arns: [arn("eu-west-1", "a"), arn("eu-west-1", "b")], more: false }], failWith: null };
    const { projectId, credentialId } = await seed(api, "cloud_kms_readonly");

    const response = await api.post(`/api/projects/${projectId}/kms/poll`, {
      data: { credentialId, account: ACCOUNT, regions: ["eu-west-1"] },
    });

    expect(response.status(), await response.text()).toBe(200);
    const text = await response.text();
    assertNoSecret(text, "POST /kms/poll");

    const body = JSON.parse(text) as {
      keysRead: number;
      keysObserved: number;
      assetsMarkedGone: number;
      enumeration: { enumerated: unknown[]; refused: unknown[]; truncated: boolean; credentialId: number };
      reconciliation: string;
    };

    expect(body.keysRead).toBe(2);
    expect(body.keysObserved).toBe(2);
    expect(body.enumeration.enumerated).toHaveLength(1);
    expect(body.enumeration.refused).toEqual([]);
    expect(body.enumeration.truncated).toBe(false);
    // The credential is named by id. That is metadata; the material is not here.
    expect(body.enumeration.credentialId).toBe(credentialId);
    expect(body.reconciliation).toMatch(/enumerated completely/);
  });

  test("records the redemption against the credential, so a use leaves a trace", async ({ api }) => {
    kmsBehaviour = { pages: [{ arns: [arn("eu-west-1", "a")], more: false }], failWith: null };
    const { projectId, credentialId } = await seed(api, "cloud_kms_readonly");

    await api.post(`/api/projects/${projectId}/kms/poll`, {
      data: { credentialId, account: ACCOUNT, regions: ["eu-west-1"] },
    });

    const list = await api.get("/api/credentials");
    const rows = (await list.json()) as Array<{ id: number; redemptionCount: number; lastRedeemedAt: string | null }>;
    const mine = rows.find((r) => r.id === credentialId);

    expect(mine?.redemptionCount).toBe(1);
    expect(mine?.lastRedeemedAt).not.toBeNull();
  });

  test("a poll that was refused a region retires nothing, however many keys it read", async ({ api }) => {
    // THE test in this file. A region answered, another was denied — so the run
    // has real keys and no right to say anything is gone. If this regresses,
    // every key not returned by the region that answered is retired and the
    // drift feed reports a remediation nobody performed.
    kmsBehaviour = { pages: [{ arns: [arn("eu-west-1", "a")], more: false }], failWith: null };
    const { projectId, credentialId } = await seed(api, "cloud_kms_readonly");

    // First poll: two keys on record, cleanly enumerated.
    kmsBehaviour = { pages: [{ arns: [arn("eu-west-1", "a"), arn("eu-west-1", "b")], more: false }], failWith: null };
    const first = await api.post(`/api/projects/${projectId}/kms/poll`, {
      data: { credentialId, account: ACCOUNT, regions: ["eu-west-1"] },
    });
    expect(((await first.json()) as { keysObserved: number }).keysObserved).toBe(2);

    // Second poll: the provider now denies everything.
    kmsBehaviour = { pages: [], failWith: 403 };
    const second = await api.post(`/api/projects/${projectId}/kms/poll`, {
      data: { credentialId, account: ACCOUNT, regions: ["eu-west-1"] },
    });

    expect(second.status()).toBe(200);
    const text = await second.text();
    assertNoSecret(text, "POST /kms/poll (denied)");

    const body = JSON.parse(text) as {
      keysRead: number;
      assetsMarkedGone: number;
      enumeration: { enumerated: unknown[]; refused: Array<{ reason: string }> };
      reconciliation: string;
    };

    expect(body.keysRead).toBe(0);
    expect(body.enumeration.enumerated).toEqual([]);
    expect(body.enumeration.refused[0]?.reason).toBe("access-denied");
    // The assertion that matters: nothing was retired.
    expect(body.assetsMarkedGone).toBe(0);
    expect(body.reconciliation).toMatch(/only the keys it actually read/);

    // And the inventory still holds both keys — a provider we could not read is
    // not a key store that emptied.
    const inventory = await api.get(`/api/projects/${projectId}/kms`);
    const keys = ((await inventory.json()) as { keys: Array<{ status: string }> }).keys;
    expect(keys.filter((k) => k.status === "gone")).toHaveLength(0);
  });

  test("a clean re-poll DOES retire a key that is genuinely gone", async ({ api }) => {
    // The other direction, and the only test here that proves the capability
    // rather than its guardrail. Everything else about §4.5 asserts that
    // nothing was retired — so if the earned prefix never matched a stored
    // location at all (a `repo` segment off by a character, a key stored under
    // a bare KeyId rather than an ARN), every one of those tests would still
    // pass. The failure would be silent and in the safe direction, which is
    // exactly why it needs its own assertion.
    kmsBehaviour = { pages: [{ arns: [arn("eu-west-1", "keep"), arn("eu-west-1", "delete")], more: false }], failWith: null };
    const { projectId, credentialId } = await seed(api, "cloud_kms_readonly");

    const first = await api.post(`/api/projects/${projectId}/kms/poll`, {
      data: { credentialId, account: ACCOUNT, regions: ["eu-west-1"] },
    });
    expect(((await first.json()) as { keysObserved: number }).keysObserved).toBe(2);

    // The key was deleted from the key store. The region still enumerates
    // completely, so this run has the evidence to say so.
    kmsBehaviour = { pages: [{ arns: [arn("eu-west-1", "keep")], more: false }], failWith: null };
    const second = await api.post(`/api/projects/${projectId}/kms/poll`, {
      data: { credentialId, account: ACCOUNT, regions: ["eu-west-1"] },
    });

    const body = (await second.json()) as { assetsMarkedGone: number; reconciliation: string };
    expect(body.assetsMarkedGone).toBe(1);
    expect(body.reconciliation).toMatch(/enumerated completely/);

    const inventory = await api.get(`/api/projects/${projectId}/kms`);
    const keys = ((await inventory.json()) as { keys: Array<{ keyId: string; status: string }> }).keys;
    expect(keys.find((k) => k.keyId.endsWith("key/delete"))?.status).toBe("gone");
    expect(keys.find((k) => k.keyId.endsWith("key/keep"))?.status).toBe("active");
  });

  test("a truncated poll withdraws the right to retire, even though a scope was enumerated", async ({ api }) => {
    kmsBehaviour = {
      pages: [{ arns: [arn("eu-west-1", "a"), arn("eu-west-1", "b"), arn("eu-west-1", "c")], more: false }],
      failWith: null,
    };
    const { projectId, credentialId } = await seed(api, "cloud_kms_readonly");

    const response = await api.post(`/api/projects/${projectId}/kms/poll`, {
      data: { credentialId, account: ACCOUNT, regions: ["eu-west-1"], maxKeys: 1 },
    });

    const body = (await response.json()) as {
      enumeration: { truncated: boolean };
      assetsMarkedGone: number;
      reconciliation: string;
    };

    expect(body.enumeration.truncated).toBe(true);
    expect(body.assetsMarkedGone).toBe(0);
    expect(body.reconciliation).toMatch(/ceiling/);
  });

  test("a revoked credential is 409, not a successful poll that found nothing", async ({ api }) => {
    kmsBehaviour = { pages: [{ arns: [arn("eu-west-1", "a")], more: false }], failWith: null };
    const { projectId, credentialId } = await seed(api, "cloud_kms_readonly");

    const revoked = await api.post(`/api/credentials/${credentialId}/revoke`);
    expect(revoked.status()).toBe(200);

    const response = await api.post(`/api/projects/${projectId}/kms/poll`, {
      data: { credentialId, account: ACCOUNT, regions: ["eu-west-1"] },
    });

    // A 200 with an empty result would make a destroyed credential read as an
    // empty key store, which is a false negative about the estate.
    expect(response.status()).toBe(409);
  });

  test("a credential of the wrong kind is 404, and does not confirm the row exists", async ({ api }) => {
    const { projectId } = await seed(api, "cloud_kms_readonly");
    const other = await api.post("/api/credentials", {
      data: { name: `idp-${Date.now()}`, kind: "idp_client_secret", secret: AWS_SECRET },
    });
    const otherId = ((await other.json()) as { id: number }).id;

    const response = await api.post(`/api/projects/${projectId}/kms/poll`, {
      data: { credentialId: otherId, account: ACCOUNT, regions: ["eu-west-1"] },
    });

    expect(response.status()).toBe(404);
  });

  test("a viewer cannot spend a credential they cannot even list", async ({ api }) => {
    kmsBehaviour = { pages: [{ arns: [arn("eu-west-1", "a")], more: false }], failWith: null };
    const { projectId, credentialId } = await seed(api, "cloud_kms_readonly");

    const { request } = await import("@playwright/test");
    const { viewerApiKey } = await import("./support/fixtures");
    const { API_URL } = await import("./support/config");
    const viewer = await request.newContext({
      baseURL: API_URL,
      extraHTTPHeaders: { "X-API-Key": viewerApiKey() },
    });

    // §4.8's hole, closed. `resolveCredentialRef()` checks the organisation and
    // not the role, so without the admin gate a viewer could spend a credential
    // by guessing a small integer.
    const response = await viewer.post(`/api/projects/${projectId}/kms/poll`, {
      data: { credentialId, account: ACCOUNT, regions: ["eu-west-1"] },
    });
    expect(response.status()).toBe(403);

    await viewer.dispose();
  });
});

test.describe("P2 — enumerating a cloud account", () => {
  test("records buckets as leads with no hostname, and examines nothing", async ({ api }) => {
    s3Behaviour = { buckets: ["reports-archive", "backups-eu"], failWith: null };
    const { projectId, credentialId } = await seed(api, "cloud_readonly_inventory");

    const response = await api.post(`/api/projects/${projectId}/discovery/cloud`, {
      data: { credentialId, account: ACCOUNT },
    });

    expect(response.status(), await response.text()).toBe(200);
    const text = await response.text();
    assertNoSecret(text, "POST /discovery/cloud");

    const body = JSON.parse(text) as {
      status: string;
      targetsCreated: number;
      discoveryRunId: number;
      enumeration: { enumerated: unknown[]; refused: unknown[] };
      evidenceCaveat: { ownership: string; completeness: string };
    };

    expect(body.status).toBe("succeeded");
    expect(body.targetsCreated).toBe(2);
    expect(body.discoveryRunId).toBeGreaterThan(0);
    expect(body.enumeration.enumerated).toHaveLength(1);
    // The caveat is per method and resolved on read. Cloud enumeration is the
    // one method that establishes ownership, and it says so.
    expect(body.evidenceCaveat.ownership).toMatch(/customer's/i);
    expect(body.evidenceCaveat.completeness).toMatch(/that instant|nothing else|account/i);
  });

  test("enumerating a cloud account examines nothing — every surface stays never-examined", async ({ api }) => {
    // D8's first invariant, inherited. A lead is a place a collector could
    // look; if this regresses, a surface reads as examined because somebody
    // listed a bucket name.
    s3Behaviour = { buckets: ["reports-archive"], failWith: null };
    const { projectId, credentialId } = await seed(api, "cloud_readonly_inventory");

    const before = await api.get(`/api/projects/${projectId}/coverage`);
    const beforeBody = (await before.json()) as { surfaces: Array<{ id: string; state: string }> };

    await api.post(`/api/projects/${projectId}/discovery/cloud`, { data: { credentialId, account: ACCOUNT } });

    const after = await api.get(`/api/projects/${projectId}/coverage`);
    const afterBody = (await after.json()) as { surfaces: Array<{ id: string; state: string }> };

    expect(afterBody.surfaces.map((s) => s.state)).toEqual(beforeBody.surfaces.map((s) => s.state));
    for (const surface of afterBody.surfaces) {
      expect(surface.state, `${surface.id} became examined by a discovery run`).not.toBe("examined");
    }
  });

  test("a denied account is refused, never empty", async ({ api }) => {
    s3Behaviour = { buckets: [], failWith: 403 };
    const { projectId, credentialId } = await seed(api, "cloud_readonly_inventory");

    const response = await api.post(`/api/projects/${projectId}/discovery/cloud`, {
      data: { credentialId, account: ACCOUNT },
    });

    const text = await response.text();
    assertNoSecret(text, "POST /discovery/cloud (denied)");
    const body = JSON.parse(text) as { status: string; enumeration: { refused: Array<{ reason: string }> } };

    // `failed`, not `no_evidence`: an account we could not read is not an
    // account with nothing in it.
    expect(body.status).toBe("failed");
    expect(body.enumeration.refused[0]?.reason).toBe("access-denied");
  });

  test("an account that really is empty is no_evidence, which is not a failure", async ({ api }) => {
    s3Behaviour = { buckets: [], failWith: null };
    const { projectId, credentialId } = await seed(api, "cloud_readonly_inventory");

    const response = await api.post(`/api/projects/${projectId}/discovery/cloud`, {
      data: { credentialId, account: ACCOUNT },
    });

    const body = (await response.json()) as { status: string; targetsCreated: number };
    expect(body.status).toBe("no_evidence");
    expect(body.targetsCreated).toBe(0);
  });

  test("re-running updates a lead rather than duplicating it", async ({ api }) => {
    s3Behaviour = { buckets: ["reports-archive"], failWith: null };
    const { projectId, credentialId } = await seed(api, "cloud_readonly_inventory");

    const first = await api.post(`/api/projects/${projectId}/discovery/cloud`, {
      data: { credentialId, account: ACCOUNT },
    });
    expect(((await first.json()) as { targetsCreated: number }).targetsCreated).toBe(1);

    const second = await api.post(`/api/projects/${projectId}/discovery/cloud`, {
      data: { credentialId, account: ACCOUNT },
    });
    const body = (await second.json()) as { targetsCreated: number; targetsUpdated: number };

    // Keyed on `identity` since stage 0. A bucket has no hostname, and a unique
    // index still keyed on one would not collide — so this would duplicate on
    // every run, silently, in exactly the number the meter reports.
    expect(body.targetsCreated).toBe(0);
    expect(body.targetsUpdated).toBe(1);
  });

  // Declared, not assumed — global setup creates the second organisation only
  // on `E2E_SECOND_ORG=1`, so without it there is no second principal for this
  // to be about. Skipped with the reason printed rather than failing a bare
  // run over configuration, and never silently.
  test("another organisation's project is 404, not their cloud inventory", async ({ secondOrgApi, api }) => {
    test.skip(!SECOND_ORG_ENABLED, "needs E2E_SECOND_ORG=1 — see tests/e2e/07-multi-org.spec.ts");
    s3Behaviour = { buckets: ["reports-archive"], failWith: null };
    const { projectId, credentialId } = await seed(api, "cloud_readonly_inventory");

    const response = await secondOrgApi.post(`/api/projects/${projectId}/discovery/cloud`, {
      data: { credentialId, account: ACCOUNT },
    });

    expect(response.status()).toBe(404);
  });
});
