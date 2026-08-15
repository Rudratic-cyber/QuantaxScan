import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "./test-support/test-db";
import { executeRows } from "./org-scope";
import { credentialsTable } from "./schema/credentials";
import {
  CredentialKeyUnavailableError,
  CredentialUnusableError,
  REDACTED,
  SecretHandle,
  credentialStoreConfigured,
  credentialSummary,
  decryptSecret,
  encryptSecret,
  redeemCredential,
  registerCredential,
  resolveCredentialRef,
  revokeCredential,
} from "./credentials";

/**
 * F4 — the credential store.
 *
 * The assertions that matter most in this file are the ones that would fail if
 * the encryption were a no-op, if the handle leaked through any coercion path,
 * or if a plaintext ended up in a column. A suite of "register then list"
 * happy-path tests would pass against a store that wrote the secret in clear.
 *
 * Every test that touches a credential row runs against
 * `createTestDb({ asRole: "quantaxscan_app" })`, because the store is
 * organisation-scoped and the harness's default role has `rolbypassrls = t` —
 * see this file's sibling, `tenant-isolation.test.ts`, whose negative control
 * explains why.
 */

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

/** A secret shaped like the thing this store actually holds. Long, high-entropy, and greppable. */
const SECRET = "AKIA-QX-TEST-3f9c8d1e5b7a2c4d6e8f0a1b-DO-NOT-LOG";

let harness: TestDb;

beforeEach(async () => {
  process.env.QUANTAXSCAN_CREDENTIAL_KEYS = `ka:${KEY_A}`;
  harness = await createTestDb({ asRole: "quantaxscan_app" });
});

afterEach(async () => {
  delete process.env.QUANTAXSCAN_CREDENTIAL_KEYS;
  await harness.close();
});

describe("key configuration", () => {
  it("reports itself unconfigured rather than throwing, so a route can answer 503", () => {
    delete process.env.QUANTAXSCAN_CREDENTIAL_KEYS;
    expect(credentialStoreConfigured()).toBe(false);
    expect(() => encryptSecret(SECRET)).toThrow(CredentialKeyUnavailableError);
  });

  it("refuses a key that is not 32 bytes rather than silently deriving one", () => {
    process.env.QUANTAXSCAN_CREDENTIAL_KEYS = `ka:${randomBytes(16).toString("base64")}`;
    expect(() => encryptSecret(SECRET)).toThrow(/AES-256 needs exactly 32/);
  });

  it("the first keyring entry encrypts and every entry can decrypt — the rotation contract", () => {
    // Encrypted under ka.
    const underA = encryptSecret(SECRET);
    expect(underA.keyId).toBe("ka");

    // Rotate: kb is prepended, ka is retained.
    process.env.QUANTAXSCAN_CREDENTIAL_KEYS = `kb:${KEY_B},ka:${KEY_A}`;
    const underB = encryptSecret(SECRET);
    expect(underB.keyId).toBe("kb");

    // The old row still decrypts; the new row is encrypted under the new key.
    expect(decryptSecret(underA)).toBe(SECRET);
    expect(decryptSecret(underB)).toBe(SECRET);

    // Drop the old key and the old row becomes unusable — named, not garbage.
    process.env.QUANTAXSCAN_CREDENTIAL_KEYS = `kb:${KEY_B}`;
    expect(() => decryptSecret(underA)).toThrow(/not in QUANTAXSCAN_CREDENTIAL_KEYS/);
  });
});

describe("encryption", () => {
  it("produces ciphertext that is not the plaintext, and a fresh IV every time", () => {
    const first = encryptSecret(SECRET);
    const second = encryptSecret(SECRET);

    // The assertion that catches a no-op or a reversible encoding.
    expect(first.ciphertext).not.toBe(SECRET);
    expect(Buffer.from(first.ciphertext, "base64").toString("utf8")).not.toContain(SECRET);
    expect(Buffer.from(first.ciphertext, "base64").toString("latin1")).not.toContain(SECRET);

    // Same plaintext, same key, different ciphertext — otherwise two customers
    // registering the same secret would be visibly identical in a dump.
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("the wrong key cannot decrypt — proving the GCM tag is actually verified", () => {
    const encrypted = encryptSecret(SECRET);
    // Same key id, different key material: the row would decrypt to garbage
    // under a cipher whose tag was not checked.
    process.env.QUANTAXSCAN_CREDENTIAL_KEYS = `ka:${KEY_B}`;
    expect(() => decryptSecret(encrypted)).toThrow(CredentialUnusableError);
    expect(() => decryptSecret(encrypted)).toThrow(/failed authenticated decryption/);
  });

  it("a tampered ciphertext is rejected, not decrypted to something else", () => {
    const encrypted = encryptSecret(SECRET);
    const bytes = Buffer.from(encrypted.ciphertext, "base64");
    bytes[0] ^= 0xff;
    expect(() => decryptSecret({ ...encrypted, ciphertext: bytes.toString("base64") })).toThrow(
      CredentialUnusableError,
    );
  });
});

describe("SecretHandle — structurally hard, not merely discouraged", () => {
  const handle = () =>
    new SecretHandle({
      plaintext: SECRET,
      credentialId: 1,
      organizationId: 1,
      kind: "cloud_kms_readonly",
      name: "test key",
    });

  it("renders as [redacted] through every coercion path a secret realistically escapes by", () => {
    const h = handle();

    expect(String(h)).toBe(REDACTED);
    expect(`${h}`).toBe(REDACTED);
    expect("using " + h).toBe(`using ${REDACTED}`);
    expect(JSON.stringify(h)).toBe(`"${REDACTED}"`);
    expect(JSON.stringify({ credential: h })).toBe(`{"credential":"${REDACTED}"}`);
    expect(JSON.stringify({ nested: { deep: [h] } })).toContain(REDACTED);
    expect(inspect(h)).toBe(REDACTED);
    expect(inspect({ h }, { depth: 5 })).toContain(REDACTED);
  });

  it("has no enumerable own properties, so spreading or enumerating it yields nothing", () => {
    const h = handle();

    // This is the assertion a `readonly plaintext` field would fail. Every
    // accessor is a prototype getter and the value is a #private field.
    expect({ ...h }).toEqual({});
    expect(Object.keys(h)).toEqual([]);
    expect(Object.entries(h)).toEqual([]);
    expect(Object.getOwnPropertyNames(h)).toEqual([]);
    expect(JSON.stringify({ ...h })).toBe("{}");
  });

  it("no coercion, serialisation or inspection of it contains the secret", () => {
    const h = handle();
    const renderings = [
      String(h),
      `${h}`,
      JSON.stringify(h),
      JSON.stringify({ h }),
      JSON.stringify({ ...h }),
      inspect(h, { depth: 10, showHidden: true }),
      inspect({ wrapped: h }, { depth: 10, showHidden: true }),
      Object.keys(h).join(","),
    ];
    for (const rendering of renderings) expect(rendering).not.toContain(SECRET);
  });

  it("exposes the plaintext only through reveal(), and not after disposal", () => {
    const h = handle();
    expect(h.reveal()).toBe(SECRET);
    expect(h.disposed).toBe(false);

    h.dispose();
    expect(h.disposed).toBe(true);
    expect(() => h.reveal()).toThrow(/must not outlive its redeemCredential\(\) callback/);
  });

  it("carries the label but never the material — the label is safe to log", () => {
    const h = handle();
    expect(h.name).toBe("test key");
    expect(h.kind).toBe("cloud_kms_readonly");
    expect(h.credentialId).toBe(1);
  });
});

describe("the store, end to end under RLS", () => {
  const ctx = { organizationId: 1, userId: "" };

  it("registers, lists and redeems — and the summary carries no material", async () => {
    const summary = await harness.scope.withOrg(ctx, (tx) =>
      registerCredential(tx, {
        organizationId: 1,
        name: "AWS eu-west-1 KMS read-only",
        kind: "cloud_kms_readonly",
        secret: SECRET,
        description: "account 1234, read-only",
      }),
    );

    expect(summary.status).toBe("active");
    expect(summary.keyId).toBe("ka");
    expect(summary.redemptionCount).toBe(0);
    // The type has no secret member; this asserts the runtime object matches.
    expect(Object.keys(summary)).not.toContain("secret");
    expect(JSON.stringify(summary)).not.toContain(SECRET);

    const ref = await harness.scope.withOrg(ctx, (tx) =>
      resolveCredentialRef(tx, summary.id, "cloud_kms_readonly"),
    );
    expect(ref).not.toBeNull();
    // A ref is an address, not a value.
    expect(JSON.stringify(ref)).not.toContain(SECRET);

    const seen = await harness.scope.withOrg(ctx, (tx) =>
      redeemCredential(tx, ref!, async (secret) => secret.reveal()),
    );
    expect(seen).toBe(SECRET);

    const [after] = await harness.scope.withOrg(ctx, (tx) => tx.select().from(credentialsTable));
    expect(after.redemptionCount).toBe(1);
    expect(after.lastRedeemedAt).not.toBeNull();
  });

  it("disposes the handle when the callback returns, so a captured handle is inert", async () => {
    const summary = await harness.scope.withOrg(ctx, (tx) =>
      registerCredential(tx, { organizationId: 1, name: "captured", kind: "vaultish" as never, secret: SECRET }),
    ).catch(() => null);
    // `kind` above is deliberately invalid: the CHECK constraint must reject it
    // rather than the row being stored with an unknown kind.
    expect(summary).toBeNull();

    const real = await harness.scope.withOrg(ctx, (tx) =>
      registerCredential(tx, { organizationId: 1, name: "captured", kind: "secrets_manager_token", secret: SECRET }),
    );
    const ref = { credentialId: real.id, organizationId: 1, kind: "secrets_manager_token" as const, name: "captured" };

    let escaped: SecretHandle | null = null;
    await harness.scope.withOrg(ctx, (tx) =>
      redeemCredential(tx, ref, async (secret) => {
        escaped = secret;
        return null;
      }),
    );

    expect(escaped).not.toBeNull();
    expect(() => escaped!.reveal()).toThrow(CredentialUnusableError);
  });

  it("refuses to redeem a credential as the wrong kind", async () => {
    const created = await harness.scope.withOrg(ctx, (tx) =>
      registerCredential(tx, { organizationId: 1, name: "idp", kind: "idp_client_secret", secret: SECRET }),
    );

    // `resolveCredentialRef` filters by kind, so a collector asking for the
    // wrong one gets nothing at all rather than a mismatched ref.
    const wrongKind = await harness.scope.withOrg(ctx, (tx) =>
      resolveCredentialRef(tx, created.id, "cloud_kms_readonly"),
    );
    expect(wrongKind).toBeNull();

    // And a hand-built ref is caught at redemption, which is the backstop.
    await expect(
      harness.scope.withOrg(ctx, (tx) =>
        redeemCredential(
          tx,
          { credentialId: created.id, organizationId: 1, kind: "cloud_kms_readonly", name: "idp" },
          async () => "unreachable",
        ),
      ),
    ).rejects.toThrow(/wrong third party/);
  });

  it("revocation destroys the material rather than flagging it", async () => {
    const created = await harness.scope.withOrg(ctx, (tx) =>
      registerCredential(tx, { organizationId: 1, name: "to revoke", kind: "database_readonly", secret: SECRET }),
    );

    const revoked = await harness.scope.withOrg(ctx, (tx) => revokeCredential(tx, created.id));
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.keyId).toBeNull();

    const [row] = await harness.scope.withOrg(ctx, (tx) => tx.select().from(credentialsTable));
    // The row survives — "this organisation held this credential between these
    // dates" is what an incident review reads — but nothing is left to decrypt.
    expect(row.ciphertext).toBeNull();
    expect(row.iv).toBeNull();
    expect(row.authTag).toBeNull();
    expect(row.revokedAt).not.toBeNull();

    await expect(
      harness.scope.withOrg(ctx, (tx) =>
        redeemCredential(
          tx,
          { credentialId: created.id, organizationId: 1, kind: "database_readonly", name: "to revoke" },
          async () => "unreachable",
        ),
      ),
    ).rejects.toThrow(/revoked and its material destroyed/);
  });

  it("re-revoking is idempotent and keeps the original revokedAt", async () => {
    const created = await harness.scope.withOrg(ctx, (tx) =>
      registerCredential(tx, { organizationId: 1, name: "twice", kind: "database_readonly", secret: SECRET }),
    );
    const first = await harness.scope.withOrg(ctx, (tx) => revokeCredential(tx, created.id));
    const second = await harness.scope.withOrg(ctx, (tx) => revokeCredential(tx, created.id));
    expect(second?.revokedAt?.toISOString()).toBe(first?.revokedAt?.toISOString());
  });

  it("an expired credential is refused, and 'no expiry recorded' is not 'never expires'", async () => {
    const expired = await harness.scope.withOrg(ctx, (tx) =>
      registerCredential(tx, {
        organizationId: 1,
        name: "expired",
        kind: "cloud_kms_readonly",
        secret: SECRET,
        expiresAt: new Date("2020-01-01T00:00:00Z"),
      }),
    );
    expect(expired.status).toBe("expired");

    await expect(
      harness.scope.withOrg(ctx, (tx) =>
        redeemCredential(
          tx,
          { credentialId: expired.id, organizationId: 1, kind: "cloud_kms_readonly", name: "expired" },
          async () => "unreachable",
        ),
      ),
    ).rejects.toThrow(/expired at 2020-01-01/);

    const undated = await harness.scope.withOrg(ctx, (tx) =>
      registerCredential(tx, { organizationId: 1, name: "undated", kind: "cloud_kms_readonly", secret: SECRET }),
    );
    // Null expiry reads `active` because the customer did not tell us when it
    // expires — the status is about what we know, not a claim it is eternal.
    expect(undated.expiresAt).toBeNull();
    expect(undated.status).toBe("active");
  });
});

describe("tenant isolation of the credential store", () => {
  it("another organisation's credential is invisible, unresolvable and unrevokable", async () => {
    const theirs = await harness.scope.withOrg({ organizationId: 2, userId: "" }, (tx) =>
      registerCredential(tx, { organizationId: 2, name: "their kms", kind: "cloud_kms_readonly", secret: SECRET }),
    );

    const ours = { organizationId: 1, userId: "" };

    // The list route runs exactly this select, with no `where organization_id`.
    const visible = await harness.scope.withOrg(ours, (tx) => tx.select().from(credentialsTable));
    expect(visible).toHaveLength(0);

    expect(await harness.scope.withOrg(ours, (tx) => resolveCredentialRef(tx, theirs.id))).toBeNull();
    expect(await harness.scope.withOrg(ours, (tx) => revokeCredential(tx, theirs.id))).toBeNull();

    // And it is genuinely unchanged, not merely unreadable by us.
    const [stillTheirs] = await harness.scope.withOrg({ organizationId: 2, userId: "" }, (tx) =>
      tx.select().from(credentialsTable),
    );
    expect(stillTheirs.revokedAt).toBeNull();
    expect(stillTheirs.ciphertext).not.toBeNull();
  });

  it("a wrong-organisation insert is rejected by the policy, not by a where clause", async () => {
    // Not `rejects.toThrow`: drizzle wraps driver errors in a `Failed query: …`
    // error and puts the real one on `cause`, so a naive match tests the
    // wrapper and would pass for a typo. Same helper shape as
    // `tenant-isolation.test.ts`'s `expectRejection`, and the same reason.
    let thrown: unknown;
    try {
      await harness.scope.withOrg({ organizationId: 1, userId: "" }, (tx) =>
        registerCredential(tx, { organizationId: 2, name: "smuggled", kind: "cloud_kms_readonly", secret: SECRET }),
      );
    } catch (err) {
      thrown = err;
    }

    const messages: string[] = [];
    for (let err = thrown; err instanceof Error; err = err.cause) messages.push(err.message);
    expect(messages.join("\n")).toMatch(/row-level security policy/);

    // And a finding worth pinning: drizzle's wrapper embeds the failing
    // statement's bind parameters, one of which is the ciphertext. That is why
    // `routes/credentials.ts` logs `err.name` rather than the error object —
    // the plaintext is not in there, but three quarters of what an attacker
    // needs is. If a future change makes this assertion fail because the
    // parameters are no longer embedded, delete the assertion, not the rule.
    expect(messages.join("\n")).toContain("params:");
  });

  it("two organisations may use the same credential name", async () => {
    const name = "production KMS";
    await harness.scope.withOrg({ organizationId: 1, userId: "" }, (tx) =>
      registerCredential(tx, { organizationId: 1, name, kind: "cloud_kms_readonly", secret: SECRET }),
    );
    await expect(
      harness.scope.withOrg({ organizationId: 2, userId: "" }, (tx) =>
        registerCredential(tx, { organizationId: 2, name, kind: "cloud_kms_readonly", secret: SECRET }),
      ),
    ).resolves.toBeTruthy();
  });
});

describe("nothing anywhere in the database holds the plaintext", () => {
  /**
   * The strongest test in this file, and the one that would catch a future
   * change adding a "fingerprint", "prefix" or "lastFour" column, or a
   * denormalised copy in an audit row.
   *
   * It walks **every text-ish column of every table** rather than the columns
   * this feature knows about, so it does not need updating when the schema
   * grows — which is exactly the property a targeted assertion would lack.
   */
  it("a full-database sweep for the registered secret finds nothing", async () => {
    await harness.scope.withOrg({ organizationId: 1, userId: "" }, (tx) =>
      registerCredential(tx, {
        organizationId: 1,
        name: "swept",
        kind: "cloud_kms_readonly",
        secret: SECRET,
        description: "a description that is not the secret",
      }),
    );

    const columns = await executeRows<{ table_name: string; column_name: string }>(
      harness.db,
      sql`select table_name, column_name
            from information_schema.columns
           where table_schema = 'public'
             and data_type in ('text', 'character varying', 'json', 'jsonb')`,
    );
    expect(columns.length).toBeGreaterThan(20);

    const hits: string[] = [];
    await harness.seedAsSuperuser(async (client) => {
      for (const column of columns) {
        const result = await client.query<{ n: string }>(
          `select count(*)::text as n from "${column.table_name}" where "${column.column_name}"::text like $1`,
          [`%${SECRET}%`],
        );
        if (result.rows[0].n !== "0") hits.push(`${column.table_name}.${column.column_name}`);
      }
    });

    expect(hits, "the plaintext secret appears in these columns").toEqual([]);

    // Control: the sweep is capable of finding something. Without this, a
    // broken query would report "no hits" for every future change too.
    const controlHits: string[] = [];
    await harness.seedAsSuperuser(async (client) => {
      const result = await client.query<{ n: string }>(
        `select count(*)::text as n from credentials where description like $1`,
        ["%not the secret%"],
      );
      if (result.rows[0].n !== "0") controlHits.push("credentials.description");
    });
    expect(controlHits).toEqual(["credentials.description"]);
  });
});

describe("credentialSummary", () => {
  it("is the only projection, and it omits ciphertext, iv and authTag", () => {
    const now = new Date("2026-08-15T00:00:00Z");
    const summary = credentialSummary(
      {
        id: 7,
        organizationId: 1,
        name: "n",
        kind: "cloud_kms_readonly",
        description: null,
        ciphertext: "CIPHERTEXT-SHOULD-NOT-APPEAR",
        iv: "IV-SHOULD-NOT-APPEAR",
        authTag: "TAG-SHOULD-NOT-APPEAR",
        keyId: "ka",
        expiresAt: null,
        revokedAt: null,
        lastRedeemedAt: null,
        redemptionCount: 0,
        createdAt: now,
        createdByUserId: null,
      },
      now,
    );

    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain("CIPHERTEXT-SHOULD-NOT-APPEAR");
    expect(serialised).not.toContain("IV-SHOULD-NOT-APPEAR");
    expect(serialised).not.toContain("TAG-SHOULD-NOT-APPEAR");
    // keyId is kept on purpose: not secret, and an operator needs it to plan a
    // rotation.
    expect(summary.keyId).toBe("ka");
  });
});
