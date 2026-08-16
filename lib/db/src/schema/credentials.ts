import { pgTable, text, serial, integer, timestamp, varchar, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { oneOf } from "./sql-helpers";
import { organizationsTable } from "./organizations";
import { usersTable } from "./auth";

/**
 * F4 — the credential store: third-party secrets a customer entrusts to us.
 *
 * **Why this table is the keystone of the collector roadmap.** Six of the eight
 * live collector surfaces are submission-based — the customer exports something
 * and uploads it — for exactly one reason: there was nowhere in this product to
 * hold a customer credential. `docs/Claude/08-security.md` §"Least privilege for
 * collectors" says collectors touching customer infrastructure need
 * "read-only, narrowly-scoped, customer-issued" credentials and that they must
 * be stored somewhere that is not the application database in plaintext. Until
 * that existed, no credentialed collector could ship. This table is that place.
 *
 * The behavioural contract — how a collector receives, redeems and must not
 * leak one of these — lives in `lib/db/src/credentials.ts`. Read that file's
 * header before building anything on top of this table; it is the part wave two
 * (credentialed KMS, live database reads, IdP integration) consumes.
 *
 * ## What is and is not stored here
 *
 * The secret is stored **only** as AES-256-GCM ciphertext, under a key read
 * from the environment and never from this table or any other. There is
 * deliberately **no** plaintext fingerprint, no hash, no length, no prefix and
 * no last-four: every one of those is a function of the plaintext that an
 * attacker holding a database dump can test guesses against, and nothing in
 * this product needs any of them. If a future feature wants "is this the same
 * secret I registered last month", the answer is to re-register it, not to add
 * an oracle here.
 *
 * `ciphertext`, `iv`, `authTag` and `keyId` are nullable **together**: they are
 * all four non-null exactly while the credential is live, and revocation nulls
 * all four. That makes revocation a destruction of the material rather than a
 * flag a future query could forget to check — the row survives so the audit
 * trail ("this organisation held a Vault token from March to August") survives
 * with it, but there is nothing left to decrypt.
 *
 * `createdByUserId` is nullable because the only principal this server has
 * today is the shared API key, which has no person behind it
 * (docs/Claude/13-auth-and-tenancy.md §6.1). When F1's sign-in lands it starts
 * being populated; a `NOT NULL DEFAULT` here would manufacture an attribution
 * that does not exist, which is the same class of error as a guessed key size.
 */

/**
 * What a stored credential is *for*. Each value names a wave-two consumer that
 * cannot ship until this store exists.
 *
 * Defined here rather than in `@workspace/collectors` for the same reason
 * `vendor_assessments`' enums are: `lib/collectors` is deliberately
 * dependency-free so it can ship as a standalone on-prem agent, and exactly one
 * table uses these. The mechanism CLAUDE.md's rule protects is preserved — one
 * const tuple, `text` + a `CHECK` built by `oneOf()`, never a Postgres `ENUM`,
 * so narrowing or widening it is a one-line diff.
 *
 * **`kind` is not decoration.** It is what a collector asserts it is asking
 * for, and `redeemCredential()` refuses a ref whose kind does not match the row
 * — so a bug that hands the IdP client secret to the KMS poller fails loudly
 * instead of sending a customer's secret to the wrong third party. Adding a
 * value means adding a consumer; there is no `generic` member on purpose,
 * because a generic bucket is how every credential ends up in it.
 */
export const CREDENTIAL_KIND_VALUES = [
  /** A read-only cloud key-management API key or service-principal secret (B5, credentialed). */
  "cloud_kms_readonly",
  /** A read-only database connection secret, for reading a live database's crypto configuration. */
  "database_readonly",
  /** A secrets-manager / Vault token, scoped to listing key metadata. */
  "secrets_manager_token",
  /** An identity-provider OAuth/OIDC client secret, for reading an IdP's signing configuration. */
  "idp_client_secret",
  /**
   * A read-only cloud key for **enumerating an account's resources** — the
   * credential a discovery run redeems, not a collection run.
   *
   * Deliberately separate from `cloud_kms_readonly` even though both are "an
   * AWS key". They are different asks with different blast radii: KMS-readonly
   * lists key metadata in one service, while inventory-readonly walks an
   * account's resources across services, and a customer scoping an IAM policy
   * needs to be able to grant one without the other. `redeemCredential()`
   * refuses a ref whose kind does not match the row, so keeping them apart is
   * what makes that refusal mean something — folding them into one value would
   * let the enumerator silently accept a key the customer issued for a much
   * narrower purpose.
   */
  "cloud_readonly_inventory",
  /**
   * A read-only bind to an MDM/EDR/directory service, for enumerating an
   * enrolled machine fleet.
   *
   * The fleet-directory method proves *enrolment*, which is stronger than
   * "associated with them" and weaker than "all of theirs" — see
   * `DISCOVERY_METHOD_CAVEATS`. **This is not an endpoint agent's enrolment
   * credential**, which is inbound machine identity and a different kind of
   * thing entirely; nothing in this product addresses that yet, and §7 Q7
   * records it as unanswered rather than assuming this row would serve.
   */
  "fleet_directory_readonly",
] as const;

export type CredentialKind = (typeof CREDENTIAL_KIND_VALUES)[number];

export const credentialsTable = pgTable(
  "credentials",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /** What the customer calls this credential, e.g. "AWS eu-west-1 KMS read-only". Unique within the organisation. */
    name: text("name").notNull(),
    kind: text("kind").$type<CredentialKind>().notNull(),
    /** Free text: which account/tenant/endpoint it belongs to, and who issued it. Never the secret. */
    description: text("description"),

    // ── The encrypted material. All four are null exactly when revoked. ──────
    /** Base64 AES-256-GCM ciphertext. Null once revoked — the material is destroyed, not flagged. */
    ciphertext: text("ciphertext"),
    /** Base64 96-bit GCM nonce, fresh per encryption. */
    iv: text("iv"),
    /** Base64 128-bit GCM authentication tag. Verified on decrypt, which is what makes a wrong key an error rather than garbage. */
    authTag: text("auth_tag"),
    /** Which entry of `QUANTAXSCAN_CREDENTIAL_KEYS` encrypted this row. Rotation reads it; it is not itself a secret. */
    keyId: text("key_id"),

    /**
     * When the *third-party* credential expires, as the customer told us. Null
     * means they did not say — never "does not expire". `redeemCredential()`
     * refuses a redemption past this instant, so a customer who records it gets
     * a clear failure instead of an opaque 403 from the vendor.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Set by `POST /credentials/:id/revoke`, at the same moment the material is nulled. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    /** Null until it has been redeemed once. This is the only use-tracking here; S8's audit log is separate and not built. */
    lastRedeemedAt: timestamp("last_redeemed_at", { withTimezone: true }),
    redemptionCount: integer("redemption_count").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Null for the shared API key, which has no person behind it. Populated once F1's sign-in lands. */
    createdByUserId: varchar("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  },
  (table) => [
    index("credentials_org_idx").on(table.organizationId),
    // Scoped to the organisation, not global: two tenants naming their
    // credential "production KMS" is normal and must not collide.
    uniqueIndex("credentials_org_name_idx").on(table.organizationId, table.name),
    check("credentials_kind_check", oneOf(table.kind, CREDENTIAL_KIND_VALUES)),
  ],
);

export type CredentialRow = typeof credentialsTable.$inferSelect;
