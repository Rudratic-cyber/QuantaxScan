import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { credentialsTable, withOrg } from "@workspace/db";
import {
  CredentialKeyUnavailableError,
  credentialStoreConfigured,
  credentialSummary,
  registerCredential,
  revokeCredential,
} from "@workspace/db/credentials";
import { CreateCredentialBody } from "@workspace/api-zod";
import { orgContextFor } from "../lib/principal";
import { logger } from "../lib/logger";

/**
 * F4 — the credential store's HTTP surface.
 *
 * Three routes, and the shape of the set is the point: **register**, **list**,
 * **revoke**. There is no read-back route and there never will be one. The only
 * way a stored secret leaves the database is `redeemCredential()` inside this
 * process, which hands a collector a `SecretHandle` rather than a string — see
 * `lib/db/src/credentials.ts` for the contract wave two builds against.
 *
 * Two things this file does deliberately that are easy to get wrong:
 *
 *  1. **The submitted secret never touches a variable that outlives the
 *     handler, and never reaches a log line.** The `catch` blocks below log
 *     `err.name` and a route label rather than the error object, because a
 *     validation error from zod embeds the input it rejected — and the input
 *     here is a customer's cloud key. That is not hypothetical: zod's
 *     `error.message` is a serialised issue list carrying `received` values.
 *  2. **A deployment with no credential key answers 503, not 500.** There is no
 *     startup gate on `QUANTAXSCAN_CREDENTIAL_KEYS` (see §4 of the contract
 *     header for why), so "the operator has not configured this feature" is a
 *     reachable, expected state and gets an answer that says so.
 */

const router: IRouter = Router();

function parseId(raw: unknown): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = parseInt(String(value), 10);
  return Number.isInteger(id) ? id : null;
}

/**
 * Postgres unique-violation, i.e. `credentials_org_name_idx`.
 *
 * Walks the `cause` chain: drizzle wraps every driver error in its own
 * `Failed query: …` error, which carries no `code`, so a check on the outer
 * error alone would answer 500 for a name collision. (That wrapper is also why
 * this file never logs an error object — its message embeds the statement's
 * bind parameters, one of which is the ciphertext.)
 */
function isUniqueViolation(err: unknown): boolean {
  for (let current: unknown = err; current != null; current = (current as { cause?: unknown }).cause) {
    if (typeof current === "object" && (current as { code?: string }).code === "23505") return true;
  }
  return false;
}

router.get("/credentials", async (req, res): Promise<void> => {
  const rows = await withOrg(orgContextFor(req), (tx) =>
    tx.select().from(credentialsTable).orderBy(desc(credentialsTable.createdAt)),
  );
  // `credentialSummary` is the only projection used anywhere. Returning the
  // raw row would put the ciphertext, IV and tag in a response body — not the
  // plaintext, but three quarters of what an attacker needs and no part of what
  // a client needs.
  res.json(rows.map((row) => credentialSummary(row)));
});

router.post("/credentials", async (req, res): Promise<void> => {
  const parsed = CreateCredentialBody.safeParse(req.body);
  if (!parsed.success) {
    // NOT `parsed.error.message` — zod serialises the rejected input into it,
    // and the rejected input is a customer's secret. Every other route in this
    // codebase returns the zod message; this one must not, and that difference
    // is the reason for this comment.
    res.status(400).json({ error: "Invalid credential body: name, kind and secret are required." });
    return;
  }

  if (!credentialStoreConfigured()) {
    res.status(503).json({
      error:
        "The credential store is not configured on this deployment. Set QUANTAXSCAN_CREDENTIAL_KEYS " +
        "to a comma-separated list of \"<keyId>:<base64 32-byte key>\" entries and restart.",
    });
    return;
  }

  const { name, kind, secret, description, expiresAt } = parsed.data;
  const ctx = orgContextFor(req);

  try {
    const created = await withOrg(ctx, (tx) =>
      registerCredential(tx, {
        organizationId: ctx.organizationId,
        name,
        kind,
        secret,
        description: description ?? null,
        // `userId` is "" for the API-key principal, which has no person behind
        // it (13-auth-and-tenancy.md §6.1). Store null rather than an empty
        // string so the column means what it says.
        createdByUserId: ctx.userId === "" ? null : ctx.userId,
        expiresAt: expiresAt ?? null,
      }),
    );
    logger.info({ credentialId: created.id, kind: created.kind, route: "POST /credentials" }, "credential registered");
    res.status(201).json(created);
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: `A credential named "${name}" already exists in this organisation.` });
      return;
    }
    if (err instanceof CredentialKeyUnavailableError) {
      // Reachable when the variable is set but malformed — `credentialStoreConfigured()`
      // above returns false only for unset/empty, and throws for a bad entry.
      res.status(503).json({ error: err.message });
      return;
    }
    // Log the name and the class, never the error object: a driver error can
    // echo the parameters of the failing statement, and one of them is the
    // ciphertext.
    logger.error(
      { errName: err instanceof Error ? err.name : typeof err, route: "POST /credentials" },
      "credential registration failed",
    );
    res.status(500).json({ error: "Could not store the credential." });
  }
});

router.post("/credentials/:id/revoke", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid credential ID" });
    return;
  }

  // `revokeCredential` runs entirely inside the scope, so another
  // organisation's id is invisible and comes back as null — answered 404, which
  // does not confirm the row exists. Which cloud accounts a company has
  // connected is itself commercially sensitive.
  const revoked = await withOrg(orgContextFor(req), (tx) => revokeCredential(tx, id));

  if (!revoked) {
    res.status(404).json({ error: "Credential not found" });
    return;
  }

  logger.info({ credentialId: revoked.id, route: "POST /credentials/:id/revoke" }, "credential revoked");
  res.json(revoked);
});

export default router;
