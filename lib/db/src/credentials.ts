import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { OrgContext, OrgScope, ScopedTx } from "./org-scope";
import { credentialsTable, type CredentialKind, type CredentialRow } from "./schema/credentials";

/**
 * ============================================================================
 * F4 — THE CREDENTIAL-USE CONTRACT
 * ============================================================================
 *
 * This file is the interface wave two builds against: credentialed KMS polling
 * (B5), live database reads, and identity-provider integration all need to hold
 * a customer secret, and none of them may hold it the way a normal value is
 * held. Read this header before writing a credentialed collector. The table it
 * sits on is documented in `schema/credentials.ts`.
 *
 * ----------------------------------------------------------------------------
 * 1. THE RULE: a reference travels, a value does not
 * ----------------------------------------------------------------------------
 *
 * Nothing outside this module ever holds a decrypted secret as an ordinary
 * string. What travels is a `CredentialRef` — an id, an organisation, a kind
 * and a name, and no material whatsoever. A collector redeems it at the moment
 * of use:
 *
 * ```ts
 * // inside a route, already within withOrg(...):
 * const ref = await resolveCredentialRef(tx, body.credentialId, "cloud_kms_readonly");
 * if (!ref) { res.status(404).json({ error: "Credential not found" }); return; }
 *
 * const keys = await redeemCredential(tx, ref, async (secret) =>
 *   pollKmsKeyMetadata({ region, apiKey: secret.reveal() }),
 * );
 * ```
 *
 * `reveal()` is the only way to a plaintext string, it is deliberately ugly to
 * read in a diff, and the handle it comes from is dead the instant the callback
 * returns — a later `reveal()` throws rather than returning a stale secret.
 *
 * **Why a handle rather than just passing the string into the callback.** A raw
 * string interpolates into a log line, a template literal, an error message and
 * a JSON body with no friction at all. `SecretHandle` refuses all four: it has
 * no enumerable own properties (so `{...handle}`, `Object.entries(handle)` and
 * `JSON.stringify({ handle })` yield nothing), and `toString`, `toJSON`,
 * `Symbol.toPrimitive` and node's inspect hook all return `REDACTED`. The
 * plaintext lives in a `#private` field, which is not reachable by spread,
 * `Object.keys`, `structuredClone` or a serialiser. That is the difference
 * between "we told people not to log it" and "logging it produces the string
 * `[redacted]`".
 *
 * ----------------------------------------------------------------------------
 * 2. WHAT A CREDENTIALED COLLECTOR MUST NOT DO
 * ----------------------------------------------------------------------------
 *
 *  - **Nothing derived from the secret may enter `observations.evidence`, an
 *    asset `location`, a log line, an error message or a response body.** Not
 *    the value, not a hash of it, not its length, not its first four
 *    characters. `evidence` is the sharpest edge here: it is an unconstrained
 *    `jsonb` blob that a collector fills in and three routes return verbatim.
 *  - **Do not put the handle in an object you then log.** `logger.info({ cred })`
 *    is safe because pino calls the inspect hook; `logger.info(\`using ${cred}\`)`
 *    is safe because `Symbol.toPrimitive` fires. `logger.info(\`using
 *    ${cred.reveal()}\`)` is not, and no mechanism here can stop it — that is
 *    what the boundary test in `artifacts/api-server/src/secret-redaction.test.ts`
 *    is for.
 *  - **A failed redemption is not a failed collection — it is no collection.**
 *    If the credential is revoked, expired, or the vendor rejects it, the run
 *    examined nothing, so it must **not** write a `completed` `collection_runs`
 *    row. Writing one would make the D3 coverage meter report the surface as
 *    "examined, nothing found", which is a different and false statement. Write
 *    a `failed` run or no run at all. See the `ReobservationScope` comment in
 *    `artifacts/api-server/src/lib/asset-ingest.ts` for the sibling rule.
 *  - **Never open a scope.** `redeemCredential` takes the caller's `ScopedTx`.
 *    Collectors run inside `withOrg`, and a nested scope silently re-scopes its
 *    parent — the one failure in the tenancy mechanism that returns *another
 *    tenant's* rows rather than none (docs/Claude/13-auth-and-tenancy.md §5.5).
 *
 * ----------------------------------------------------------------------------
 * 3. WHAT THE ENCRYPTION DOES AND DOES NOT PROTECT AGAINST
 * ----------------------------------------------------------------------------
 *
 * Secrets are AES-256-GCM encrypted under a key read from the environment
 * (`QUANTAXSCAN_CREDENTIAL_KEYS`) and never stored in the database. Stated
 * plainly, because a vague claim here is worse than none:
 *
 * **It does protect against a database-only compromise** — a stolen dump, a
 * leaked backup, a read-only SQL foothold, a misconfigured replica, a support
 * engineer with a psql prompt. In every one of those the attacker gets
 * ciphertext and no key.
 *
 * **It does not protect against:**
 *  - *Application compromise.* The running process can decrypt everything it
 *    can read. Code execution in the API server is total compromise of every
 *    credential in every organisation.
 *  - *An attacker who holds both the environment and the database.* Anyone with
 *    shell on the host, the container's env, or the deployment's secret store
 *    has both by definition.
 *  - *A heap or core dump taken while a secret is in use.* JavaScript strings
 *    are immutable and garbage-collected; `SecretHandle` drops its reference on
 *    dispose but cannot zero the memory. There is no `mlock` here.
 *  - *A malicious or compromised operator.* No approval, quorum or
 *    customer-held key stands between an operator and a plaintext.
 *
 * **Two limits of the key management specifically**, both deliberate and both
 * open work:
 *  - *There are no per-organisation keys.* One key encrypts every tenant's
 *    credentials, so compromising it compromises all of them. Per-org keys are
 *    the obvious next step and are not built.
 *  - *There is no KMS or HSM envelope.* The data key is the environment
 *    variable, not a wrapped key unwrapped by a cloud KMS on demand, so there
 *    is no audit trail of key use and no way to revoke access to the key
 *    without a redeploy.
 *
 * 08-security.md's "Store credentials in a secrets manager, never in the
 * application database" is therefore **partially** satisfied and no more: the
 * *key* is out of the database, the *ciphertext* is in it. Say that to a
 * customer in those words. Customer-held keys, which that section also asks
 * for, would mean we cannot use a credential without the customer's
 * involvement, and nothing here provides that.
 *
 * ----------------------------------------------------------------------------
 * 4. KEY CONFIGURATION AND ROTATION
 * ----------------------------------------------------------------------------
 *
 * `QUANTAXSCAN_CREDENTIAL_KEYS` is a comma-separated, ordered list of
 * `<keyId>:<base64 32 bytes>` entries — the same rotation idiom as
 * `SESSION_SECRET` in docs/Claude/13-auth-and-tenancy.md §3.8:
 *
 *     QUANTAXSCAN_CREDENTIAL_KEYS=k2:BASE64...,k1:BASE64...
 *
 * The **first** entry encrypts every new credential; **every** entry can
 * decrypt, matched by the `key_id` stored on the row. So rotation is: generate
 * a key, prepend it, redeploy; old rows keep working and are re-encrypted the
 * next time they are registered. `keyId` must be short, opaque and unique — it
 * is not a secret and it appears in list responses so an operator can tell
 * which rows still need re-encrypting.
 *
 * **There is deliberately no startup gate on this variable**, unlike
 * `assertApiKeysConfigured()` and `assertSessionSecretsConfigured()`. Those
 * guard controls that are load-bearing for *every* request; this one guards a
 * feature. Making it required would break `docker-compose`, the README's
 * getting-started path and every local run that never touches a credential, for
 * no security gain — a deployment with no credential key simply cannot register
 * one. Instead this module fails closed **at use**: `encryptSecret` and
 * `decryptSecret` throw `CredentialKeyUnavailableError`, and the routes turn
 * that into a 503 naming the variable. `.env.example` documents it.
 *
 * ----------------------------------------------------------------------------
 * 5. LIFECYCLE
 * ----------------------------------------------------------------------------
 *
 * register → (redeem)* → revoke. Revocation nulls `ciphertext`, `iv`,
 * `auth_tag` and `key_id` in the same statement that sets `revoked_at`, so the
 * material is destroyed rather than hidden behind a flag a later query could
 * forget. The row survives because "this organisation held a Vault token
 * between March and August" is exactly the fact an incident review needs.
 *
 * A revoked or expired credential fails redemption with a named error. There is
 * no un-revoke: register a new one.
 * ============================================================================
 */

/** What a redacted secret renders as, everywhere. Asserted by the boundary test. */
export const REDACTED = "[redacted]";

const KEYS_ENV_VAR = "QUANTAXSCAN_CREDENTIAL_KEYS";
/** AES-256. */
const KEY_BYTES = 32;
/** 96 bits, the GCM-recommended nonce size. */
const IV_BYTES = 12;

/** Thrown when the deployment has configured no usable credential key. Routes turn this into a 503. */
export class CredentialKeyUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `The credential store is not configured: ${detail}. ` +
        `Set ${KEYS_ENV_VAR} to a comma-separated list of "<keyId>:<base64 32-byte key>" entries ` +
        `(the first encrypts, all can decrypt). See lib/db/src/credentials.ts §4.`,
    );
    this.name = "CredentialKeyUnavailableError";
  }
}

/** Thrown when a credential exists but cannot be used — revoked, expired, or encrypted under a key this deployment no longer has. */
export class CredentialUnusableError extends Error {
  constructor(
    message: string,
    readonly reason: "revoked" | "expired" | "unknown_key" | "undecryptable" | "kind_mismatch",
  ) {
    super(message);
    this.name = "CredentialUnusableError";
  }
}

interface KeyringEntry {
  keyId: string;
  key: Buffer;
}

/**
 * Parsed fresh on every call rather than cached at import time.
 *
 * Deliberate: a cached keyring makes the variable un-settable by a test after
 * import, and this module is imported transitively by half the codebase. It is
 * a base64 decode of two or three short strings — the cost is noise next to a
 * round trip to Postgres, and the alternative is a module whose behaviour
 * depends on import order.
 */
function readKeyring(): KeyringEntry[] {
  const raw = process.env[KEYS_ENV_VAR];
  if (raw === undefined || raw.trim() === "") return [];

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const separator = entry.indexOf(":");
      if (separator <= 0) {
        throw new CredentialKeyUnavailableError(`entry "${entry.slice(0, 8)}…" is not "<keyId>:<base64 key>"`);
      }
      const keyId = entry.slice(0, separator);
      const key = Buffer.from(entry.slice(separator + 1), "base64");
      if (key.length !== KEY_BYTES) {
        throw new CredentialKeyUnavailableError(
          `key "${keyId}" decodes to ${key.length} bytes; AES-256 needs exactly ${KEY_BYTES}`,
        );
      }
      return { keyId, key };
    });
}

/** True when this deployment can register and redeem credentials at all. Routes check it to answer 503 rather than 500. */
export function credentialStoreConfigured(): boolean {
  return readKeyring().length > 0;
}

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyId: string;
}

/** Encrypt under the *first* keyring entry. See §4 — first encrypts, all decrypt. */
export function encryptSecret(plaintext: string): EncryptedSecret {
  const [entry] = readKeyring();
  if (entry === undefined) throw new CredentialKeyUnavailableError(`${KEYS_ENV_VAR} is unset or empty`);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", entry.key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyId: entry.keyId,
  };
}

/**
 * Decrypt under the entry named by `keyId`.
 *
 * GCM's authentication tag is verified by `decipher.final()`, so a wrong key or
 * a tampered ciphertext throws rather than returning plausible-looking garbage.
 * That is the property that makes "encrypted at rest" mean something against a
 * writable database rather than only a readable one.
 */
export function decryptSecret(encrypted: EncryptedSecret): string {
  const keyring = readKeyring();
  if (keyring.length === 0) throw new CredentialKeyUnavailableError(`${KEYS_ENV_VAR} is unset or empty`);

  const entry = keyring.find((candidate) => candidate.keyId === encrypted.keyId);
  if (entry === undefined) {
    throw new CredentialUnusableError(
      `This credential was encrypted under key "${encrypted.keyId}", which is not in ${KEYS_ENV_VAR}. ` +
        `Restore that key or re-register the credential.`,
      "unknown_key",
    );
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", entry.key, Buffer.from(encrypted.iv, "base64"));
    decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    // Deliberately not chaining the underlying error: its message is the only
    // place a crypto library might echo input back.
    throw new CredentialUnusableError(
      `Credential material failed authenticated decryption under key "${encrypted.keyId}". ` +
        `The ciphertext, IV or tag has been altered, or the key with that id is not the one that encrypted it.`,
      "undecryptable",
    );
  }
}

/**
 * A live secret, for the duration of one `redeemCredential` callback.
 *
 * Every public member is a **getter on the prototype**, not an own property, so
 * `{...handle}` and `Object.entries(handle)` produce nothing at all. The
 * plaintext is a `#private` field, unreachable by spread, `Object.keys`,
 * `structuredClone`, `JSON.stringify` or any serialiser. The four coercion
 * paths a secret realistically escapes through — string concatenation,
 * `String()`, `JSON.stringify`, `console.log`/pino — are each overridden to
 * `REDACTED`.
 */
export class SecretHandle {
  #plaintext: string | null;
  readonly #credentialId: number;
  readonly #organizationId: number;
  readonly #kind: CredentialKind;
  readonly #name: string;

  constructor(init: { plaintext: string; credentialId: number; organizationId: number; kind: CredentialKind; name: string }) {
    this.#plaintext = init.plaintext;
    this.#credentialId = init.credentialId;
    this.#organizationId = init.organizationId;
    this.#kind = init.kind;
    this.#name = init.name;
  }

  get credentialId(): number {
    return this.#credentialId;
  }
  get organizationId(): number {
    return this.#organizationId;
  }
  get kind(): CredentialKind {
    return this.#kind;
  }
  /** The customer's label. Safe to log — it is what they typed into the form, not the secret. */
  get name(): string {
    return this.#name;
  }
  get disposed(): boolean {
    return this.#plaintext === null;
  }

  /**
   * The plaintext. The only way to one, and named to be conspicuous in review.
   *
   * Call it as late as possible and hand the result straight to the client
   * library that needs it. Do not store it, do not put it in an object that
   * outlives the callback, and do not interpolate it into anything.
   */
  reveal(): string {
    if (this.#plaintext === null) {
      throw new CredentialUnusableError(
        `SecretHandle for credential ${this.#credentialId} has been disposed. ` +
          `A secret must not outlive its redeemCredential() callback — redeem again at the point of use.`,
        "revoked",
      );
    }
    return this.#plaintext;
  }

  /**
   * Drops the reference. Called in a `finally` by `redeemCredential`, so a
   * handle captured out of the callback is inert rather than a live secret.
   *
   * It cannot *erase* anything: JavaScript strings are immutable, so the
   * plaintext survives until the garbage collector reaches it and may appear in
   * a heap dump until then. §3 says so; this method does not pretend otherwise.
   */
  dispose(): void {
    this.#plaintext = null;
  }

  toString(): string {
    return REDACTED;
  }
  toJSON(): string {
    return REDACTED;
  }
  [Symbol.toPrimitive](): string {
    return REDACTED;
  }
  /** What `console.log`, `util.inspect` and pino's object serialiser reach for. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
  get [Symbol.toStringTag](): string {
    return "SecretHandle";
  }
}

/**
 * What the rest of the codebase passes around: an address, never a value.
 *
 * Obtain one from `resolveCredentialRef()` — which confirms the row is visible
 * **inside** the caller's organisation scope — and never by constructing the
 * object literal from a client-supplied id. A foreign key is not subject to
 * RLS, and neither is an integer in a request body.
 */
export interface CredentialRef {
  readonly credentialId: number;
  readonly organizationId: number;
  readonly kind: CredentialKind;
  readonly name: string;
}

/**
 * What a list response may contain. Every column of the row except the four
 * that hold or address the material — `ciphertext`, `iv`, `authTag` are absent
 * outright, and `keyId` is kept because it is not secret and an operator needs
 * it to plan a rotation.
 *
 * There is no `secret` field and there is no route that can produce one. That
 * is the whole point of the type existing separately from `CredentialRow`.
 */
export interface CredentialSummary {
  id: number;
  organizationId: number;
  name: string;
  kind: CredentialKind;
  description: string | null;
  keyId: string | null;
  status: "active" | "expired" | "revoked";
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastRedeemedAt: Date | null;
  redemptionCount: number;
  createdAt: Date;
  createdByUserId: string | null;
}

function credentialStatus(row: CredentialRow, now: Date): CredentialSummary["status"] {
  if (row.revokedAt !== null) return "revoked";
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

/** Project a row to what a client may see. The only function that should ever build a credential response body. */
export function credentialSummary(row: CredentialRow, now: Date = new Date()): CredentialSummary {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    kind: row.kind,
    description: row.description,
    keyId: row.keyId,
    status: credentialStatus(row, now),
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastRedeemedAt: row.lastRedeemedAt,
    redemptionCount: row.redemptionCount,
    createdAt: row.createdAt,
    createdByUserId: row.createdByUserId,
  };
}

export interface RegisterCredentialInput {
  organizationId: number;
  name: string;
  kind: CredentialKind;
  secret: string;
  description?: string | null;
  expiresAt?: Date | null;
  createdByUserId?: string | null;
}

/**
 * Store a secret. Takes the caller's `ScopedTx` — it never opens a scope.
 *
 * `organizationId` is stamped from the caller's context, and the policy's
 * `WITH CHECK` rejects any other value, so a wrong-organisation write is a
 * database error rather than a leak.
 */
export async function registerCredential(tx: ScopedTx, input: RegisterCredentialInput): Promise<CredentialSummary> {
  const encrypted = encryptSecret(input.secret);

  const [row] = await tx
    .insert(credentialsTable)
    .values({
      organizationId: input.organizationId,
      name: input.name,
      kind: input.kind,
      description: input.description ?? null,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      keyId: encrypted.keyId,
      expiresAt: input.expiresAt ?? null,
      createdByUserId: input.createdByUserId ?? null,
    })
    .returning();

  return credentialSummary(row);
}

/**
 * Turn a client-supplied id into a `CredentialRef`, or `null`.
 *
 * **This is the function that makes an id from a request body safe to act on.**
 * The `select` runs inside the caller's scope, so a credential belonging to
 * another organisation is invisible and this returns `null` — the caller then
 * answers 404, which does not confirm the row exists.
 *
 * `expectedKind` is not optional in spirit: pass the kind your collector needs,
 * and a ref for the wrong kind of secret never reaches your vendor call.
 */
export async function resolveCredentialRef(
  tx: ScopedTx,
  credentialId: number,
  expectedKind?: CredentialKind,
): Promise<CredentialRef | null> {
  const [row] = await tx.select().from(credentialsTable).where(eq(credentialsTable.id, credentialId));
  if (!row) return null;
  if (expectedKind !== undefined && row.kind !== expectedKind) return null;

  return { credentialId: row.id, organizationId: row.organizationId, kind: row.kind, name: row.name };
}

/**
 * Redeem a reference for the duration of one callback, then dispose it.
 *
 * Records the redemption on the row (`last_redeemed_at`, `redemption_count`)
 * before running the callback, so a use that crashes still leaves a trace.
 *
 * Throws `CredentialUnusableError` for a revoked, expired or undecryptable
 * credential. The caller must treat that as *no collection happened*, not as a
 * collection that found nothing — see §2.
 */
export async function redeemCredential<T>(
  tx: ScopedTx,
  ref: CredentialRef,
  use: (secret: SecretHandle) => Promise<T>,
  now: Date = new Date(),
): Promise<T> {
  const [row] = await tx.select().from(credentialsTable).where(eq(credentialsTable.id, ref.credentialId));

  // Not reachable through `resolveCredentialRef`, but a caller can hand-build a
  // ref, and a deleted-then-recreated id is a real sequence. Both fail closed.
  if (!row) {
    throw new CredentialUnusableError(`Credential ${ref.credentialId} is not visible in this organisation's scope.`, "revoked");
  }
  if (row.kind !== ref.kind) {
    throw new CredentialUnusableError(
      `Credential ${row.id} is a "${row.kind}" but was redeemed as a "${ref.kind}". ` +
        `Refusing rather than sending a customer's secret to the wrong third party.`,
      "kind_mismatch",
    );
  }
  if (row.revokedAt !== null || row.ciphertext === null || row.iv === null || row.authTag === null || row.keyId === null) {
    throw new CredentialUnusableError(
      `Credential ${row.id} ("${row.name}") was revoked and its material destroyed. Register a new one.`,
      "revoked",
    );
  }
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
    throw new CredentialUnusableError(
      `Credential ${row.id} ("${row.name}") expired at ${row.expiresAt.toISOString()}.`,
      "expired",
    );
  }

  const plaintext = decryptSecret({
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.authTag,
    keyId: row.keyId,
  });

  await tx
    .update(credentialsTable)
    .set({ lastRedeemedAt: now, redemptionCount: sql`${credentialsTable.redemptionCount} + 1` })
    .where(eq(credentialsTable.id, row.id));

  const handle = new SecretHandle({
    plaintext,
    credentialId: row.id,
    organizationId: row.organizationId,
    kind: row.kind,
    name: row.name,
  });

  try {
    return await use(handle);
  } finally {
    handle.dispose();
  }
}

/**
 * Redeem a credential for an operation that **outlives a database
 * transaction** — a credentialed acquisition against a third-party API.
 * docs/Claude/17-discovery-design.md §4.6, and §7 Q1.
 *
 * ## Why `redeemCredential` cannot serve this
 *
 * It runs `use` *inside* the caller's `ScopedTx` and disposes the handle in a
 * `finally`. That is right for a short call and wrong for an enumeration that
 * pages through a cloud API: `withOrg` holds a real database transaction for
 * the whole callback, so a minutes-long vendor round trip pins a pooled
 * connection idle for its duration — and behaves badly behind a
 * transaction-mode pooler.
 *
 * The codebase already refuses to do this twice over. `routes/discovery.ts` and
 * `schedule-runner.ts` both split their egress out of the scope, in the second
 * case by taking an `OrgScope` rather than a `ScopedTx` *specifically so it can
 * open its scope after the probe* — "probing is outbound `node:tls` to hosts
 * this server does not control… doing it inside would pin a pooled connection
 * idle for the duration." A credentialed acquisition is the same shape with a
 * secret attached, and `Acquisition.acquire` is documented as running outside
 * any transaction. There is no way to satisfy both contracts with
 * `redeemCredential`, which is why this exists.
 *
 * **§7 Q1 asked whether this is a legitimate second variant of F4's contract or
 * a hole in it, and named a measurement as what would settle it: how long a real
 * enumeration takes against the deployed pool size.** That measurement needs a
 * real cloud account and there is none, so it is settled *structurally* instead
 * — the two contracts are incompatible as written, independent of timing. The
 * timing question stays genuinely open, and it decides something else: whether a
 * ceiling on enumeration duration is needed. Recorded rather than closed.
 *
 * ## The ordering, and what it costs
 *
 * Opens a scope, performs every check `redeemCredential` performs, decrypts,
 * records the redemption, **commits**, and only then runs `use` — disposing the
 * handle in a `finally` so a plaintext never outlives the call.
 *
 * The cost, stated rather than buried: the redemption is recorded before the
 * use, so a crash mid-acquisition leaves a recorded redemption and no
 * collection. That is the right direction and it is already F4's stated
 * behaviour — "records the redemption on the row before running the callback,
 * so a use that crashes still leaves a trace." A redemption that did not happen
 * is the dangerous error; a redemption recorded for a use that failed is an
 * over-count in an audit trail, which is the direction to be wrong in.
 *
 * ## The caller must not already hold a scope
 *
 * Scopes do not nest, and a nested one *silently re-scopes its parent once its
 * savepoint is released* — the single failure in the tenancy mechanism that
 * returns another tenant's rows rather than none. `withOrg` throws if one is
 * already open, so this fails loudly rather than subtly; the rule is stated here
 * because the natural way to call this from a route is from inside the scope
 * that just resolved the ref, and that is exactly wrong.
 */
export async function withRedeemedCredential<T>(
  scope: Pick<OrgScope, "withOrg">,
  ctx: OrgContext,
  ref: CredentialRef,
  use: (secret: SecretHandle) => Promise<T>,
  now: Date = new Date(),
): Promise<T> {
  const handle = await scope.withOrg(ctx, async (tx) => {
    const [row] = await tx.select().from(credentialsTable).where(eq(credentialsTable.id, ref.credentialId));

    // Every check `redeemCredential` makes, in the same order and with the same
    // messages. Deliberately duplicated rather than extracted: the two
    // functions differ only in transaction lifetime, and a shared helper that
    // took a `tx` would make it easy to call the wrong one from the wrong place.
    if (!row) {
      throw new CredentialUnusableError(
        `Credential ${ref.credentialId} is not visible in this organisation's scope.`,
        "revoked",
      );
    }
    if (row.kind !== ref.kind) {
      throw new CredentialUnusableError(
        `Credential ${row.id} is a "${row.kind}" but was redeemed as a "${ref.kind}". ` +
          `Refusing rather than sending a customer's secret to the wrong third party.`,
        "kind_mismatch",
      );
    }
    if (row.revokedAt !== null || row.ciphertext === null || row.iv === null || row.authTag === null || row.keyId === null) {
      throw new CredentialUnusableError(
        `Credential ${row.id} ("${row.name}") was revoked and its material destroyed. Register a new one.`,
        "revoked",
      );
    }
    if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
      throw new CredentialUnusableError(
        `Credential ${row.id} ("${row.name}") expired at ${row.expiresAt.toISOString()}.`,
        "expired",
      );
    }

    const plaintext = decryptSecret({
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.authTag,
      keyId: row.keyId,
    });

    await tx
      .update(credentialsTable)
      .set({ lastRedeemedAt: now, redemptionCount: sql`${credentialsTable.redemptionCount} + 1` })
      .where(eq(credentialsTable.id, row.id));

    return new SecretHandle({
      plaintext,
      credentialId: row.id,
      organizationId: row.organizationId,
      kind: row.kind,
      name: row.name,
    });
  });

  // The scope has committed. The handle now exists outside any transaction,
  // which is the entire point and also the reason `finally` is not optional.
  try {
    return await use(handle);
  } finally {
    handle.dispose();
  }
}

/**
 * Revoke: destroy the material, keep the row.
 *
 * Returns `null` when the credential is not visible in this scope — which is
 * how another organisation's id behaves, and the caller answers 404. Revoking
 * an already-revoked credential is idempotent and leaves the original
 * `revoked_at` alone, because that timestamp is the fact an incident review
 * reads.
 */
export async function revokeCredential(tx: ScopedTx, credentialId: number, now: Date = new Date()): Promise<CredentialSummary | null> {
  const [row] = await tx
    .update(credentialsTable)
    .set({ revokedAt: now, ciphertext: null, iv: null, authTag: null, keyId: null })
    .where(and(eq(credentialsTable.id, credentialId), sql`${credentialsTable.revokedAt} is null`))
    .returning();

  if (row) return credentialSummary(row, now);

  // Either already revoked (return it as-is) or not visible (null).
  const [existing] = await tx.select().from(credentialsTable).where(eq(credentialsTable.id, credentialId));
  return existing ? credentialSummary(existing, now) : null;
}

/** Constant-time comparison, for anywhere a caller must prove it already knows a secret. Not used by the routes; exported so nobody reaches for `===`. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
