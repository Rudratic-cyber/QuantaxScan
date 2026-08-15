/**
 * F4 — the credential store, end to end against the real stack: real Postgres,
 * real API server, real row-level security, real AES-256-GCM. No `page.route`
 * appears in this file; every assertion is against the real HTTP response from
 * the real server (`tests/e2e/support/fixtures.ts`'s one rule).
 *
 * **Why this feature earns an end-to-end spec rather than only a unit one.**
 * Every other collector spec proves the product recorded something. This one
 * proves the product *withholds* something, and the failure it guards against
 * is not a wrong number on a page — it is a customer's cloud key appearing in a
 * response body. Nothing about that failure is visible from inside a unit test
 * that asserts on parsed objects: a secret leaks through a field nobody thought
 * to assert on, an error message that echoes its input, or a driver error whose
 * text embeds the bind parameters. So the assertions below deliberately search
 * the **raw response text** for the secret rather than checking named keys.
 * `expect(body.secret).toBeUndefined()` passes cheerfully while the secret sits
 * in `body.error`.
 *
 * The deployment is configured with a credential key by global setup
 * (`support/config.ts`, `QUANTAXSCAN_CREDENTIAL_KEYS`), because an unconfigured
 * store answers 503 by design and a spec run against it would be testing a
 * deployment that never enabled the feature. That 503 branch is asserted at the
 * handler level in `artifacts/api-server/src/secret-redaction.test.ts`.
 *
 * What would fail if F4 regressed, in order of how quietly it would land:
 *
 *  1. someone "simplifies" the 400 branch to return zod's `error.message`,
 *     which serialises the rejected input — and the rejected input is a
 *     customer's secret (`no route echoes a rejected secret`);
 *  2. a read-back route is added, or `credentialSummary` stops being the only
 *     projection, putting ciphertext/iv/authTag on the wire (`register`,
 *     `list`);
 *  3. revocation becomes a flag rather than a destruction, leaving decryptable
 *     material behind a boolean a later query can forget (`revoke`);
 *  4. revocation starts deleting the row, taking the audit trail with it
 *     (`revoke`);
 *  5. a name collision answers 500 instead of 409, because the unique violation
 *     is wrapped by drizzle and the outer error carries no `code`
 *     (`a duplicate name`).
 */
import { test, expect } from "./support/fixtures";
import { CREDENTIAL_KEY_ID } from "./support/config";

/**
 * Distinctive enough that finding it in any response body is unambiguous, and
 * shaped like the thing it stands in for. Per-run so a stale row from an
 * earlier run cannot make an assertion pass.
 */
const SECRET = `hvs.CAESIJ-e2e-${Date.now()}-do-not-echo-this-anywhere`;

interface CredentialSummary {
  id: number;
  organizationId: number;
  name: string;
  kind: string;
  description: string | null;
  keyId: string | null;
  status: "active" | "expired" | "revoked";
  expiresAt: string | null;
  revokedAt: string | null;
  lastRedeemedAt: string | null;
  redemptionCount: number;
  createdAt: string;
  createdByUserId: string | null;
}

/** The four fields that together are the encrypted material. None may ever be serialised. */
const MATERIAL_FIELDS = ["ciphertext", "iv", "authTag", "secret"] as const;

function assertNoMaterial(rawBody: string, context: string): void {
  expect(rawBody, `${context}: the plaintext secret reached a response body`).not.toContain(SECRET);
  for (const field of MATERIAL_FIELDS) {
    expect(rawBody, `${context}: "${field}" was serialised`).not.toContain(`"${field}"`);
  }
}

test.describe("F4 — the credential store", () => {
  test("register returns metadata only, and never the material", async ({ api }) => {
    const name = `vault-token-${Date.now()}`;

    const response = await api.post("/api/credentials", {
      data: { name, kind: "secrets_manager_token", secret: SECRET, description: "e2e" },
    });

    expect(response.status()).toBe(201);
    assertNoMaterial(await response.text(), "POST /credentials");

    const created = (await response.json()) as CredentialSummary;
    expect(created.name).toBe(name);
    expect(created.kind).toBe("secrets_manager_token");
    expect(created.status).toBe("active");
    // The operator needs to know which key encrypted the row so a rotation can
    // find what still needs re-encrypting. It is metadata, not material.
    expect(created.keyId).toBe(CREDENTIAL_KEY_ID);
    // No person is behind the API-key principal, and the column says so rather
    // than manufacturing an attribution.
    expect(created.createdByUserId).toBeNull();
    expect(created.redemptionCount).toBe(0);
    expect(created.lastRedeemedAt).toBeNull();
  });

  test("list shows the credential and still no material", async ({ api }) => {
    const name = `list-probe-${Date.now()}`;
    const created = await api.post("/api/credentials", {
      data: { name, kind: "cloud_kms_readonly", secret: SECRET },
    });
    expect(created.status()).toBe(201);

    const response = await api.get("/api/credentials");
    expect(response.status()).toBe(200);
    assertNoMaterial(await response.text(), "GET /credentials");

    const rows = (await response.json()) as CredentialSummary[];
    const mine = rows.find((row) => row.name === name);
    expect(mine, "the registered credential is missing from the list").toBeDefined();
    expect(mine?.status).toBe("active");
  });

  test("no route echoes a rejected secret", async ({ api }) => {
    // The body is invalid — `kind` is not a member of CREDENTIAL_KIND_VALUES —
    // but it carries a real-looking secret, which is exactly the shape of the
    // mistake a customer makes and the shape that turns a helpful validation
    // message into a leak.
    const response = await api.post("/api/credentials", {
      data: { name: `rejected-${Date.now()}`, kind: "not-a-real-kind", secret: SECRET },
    });

    expect(response.status()).toBe(400);
    const raw = await response.text();
    expect(raw, "the 400 body echoed the rejected secret").not.toContain(SECRET);
    // Guards the specific regression: zod's serialised issue list names the
    // rejected value under `received`.
    expect(raw).not.toContain("received");
  });

  test("a duplicate name is a 409, not a 500", async ({ api }) => {
    const name = `duplicate-${Date.now()}`;
    const first = await api.post("/api/credentials", {
      data: { name, kind: "database_readonly", secret: SECRET },
    });
    expect(first.status()).toBe(201);

    const second = await api.post("/api/credentials", {
      data: { name, kind: "database_readonly", secret: `${SECRET}-again` },
    });

    expect(second.status()).toBe(409);
    assertNoMaterial(await second.text(), "the 409 body");
  });

  test("revoke destroys the material and keeps the row", async ({ api }) => {
    const name = `revoke-me-${Date.now()}`;
    const created = (await (
      await api.post("/api/credentials", { data: { name, kind: "idp_client_secret", secret: SECRET } })
    ).json()) as CredentialSummary;
    expect(created.keyId).toBe(CREDENTIAL_KEY_ID);

    const response = await api.post(`/api/credentials/${created.id}/revoke`);
    expect(response.status()).toBe(200);
    assertNoMaterial(await response.text(), "POST /credentials/:id/revoke");

    const revoked = (await response.json()) as CredentialSummary;
    expect(revoked.status).toBe("revoked");
    expect(revoked.revokedAt).not.toBeNull();
    // The whole point of the design: revocation is a destruction of the
    // material, not a flag beside it. `keyId` going null is the observable
    // half of ciphertext/iv/authTag going null — there is nothing left to
    // decrypt, so no later query can forget to check a boolean.
    expect(revoked.keyId).toBeNull();

    // ...and the row survives, because "this organisation held a Vault token
    // from March to August" is the audit trail. A revoke that deleted the row
    // would pass every assertion above and lose that.
    const rows = (await (await api.get("/api/credentials")).json()) as CredentialSummary[];
    const stillThere = rows.find((row) => row.id === created.id);
    expect(stillThere, "revocation deleted the row and took the audit trail with it").toBeDefined();
    expect(stillThere?.status).toBe("revoked");
    expect(stillThere?.name).toBe(name);
  });

  test("revoking an unknown credential is a 404 that confirms nothing", async ({ api }) => {
    const response = await api.post("/api/credentials/99999999/revoke");
    expect(response.status()).toBe(404);
    // Which cloud accounts a company has connected is itself commercially
    // sensitive, so the answer for "not yours" and "does not exist" is the
    // same one.
    expect(await response.text()).not.toContain(SECRET);
  });

  test("an anonymous caller reaches none of it", async ({ publicApi }) => {
    expect((await publicApi.get("/api/credentials")).status()).toBe(401);
    expect(
      (
        await publicApi.post("/api/credentials", {
          data: { name: `anon-${Date.now()}`, kind: "cloud_kms_readonly", secret: SECRET },
        })
      ).status(),
    ).toBe(401);
  });
});
