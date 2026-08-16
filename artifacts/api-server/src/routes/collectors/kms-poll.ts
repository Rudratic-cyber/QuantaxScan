import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { withOrg, projectsTable, projectRepoId } from "@workspace/db";
import {
  resolveCredentialRef,
  withRedeemedCredential,
  CredentialUnusableError,
  type SecretHandle,
} from "@workspace/db/credentials";
import { PollProjectKmsBody } from "@workspace/api-zod";
import { kmsLocationPrefix, type DiscoveryScope, type EnumerationRecord } from "@workspace/collectors";
import { ingestKmsObservations } from "../../lib/asset-ingest";
import { toKmsKeyResponseEntry, KMS_POLL_EVIDENCE_CAVEAT } from "../../lib/kms-response";
import { awsKmsAcquisition } from "../../lib/acquisition/aws-kms";
import { enumerationRecordFor } from "../../lib/acquisition/types";
import { earnedPrefixes } from "../../lib/acquisition/prefix-scope";
import { orgContextFor } from "../../lib/principal";
import { logger } from "../../lib/logger";

/**
 * P1 — `POST /api/projects/:id/kms/poll`.
 * docs/Claude/17-discovery-design.md §3.2 item 1, §4.6, §4.7.
 *
 * **The first thing in this product that reads a customer's system for itself.**
 * Everything before it either observed something the customer pointed us at
 * (source, TLS) or recorded something they uploaded. This redeems a stored
 * read-only credential and enumerates.
 *
 * ## Why a separate route rather than a union body on `POST /projects/:id/kms`
 *
 * §4.7, and all three reasons are mechanical rather than aesthetic. The zod
 * schema stays one-shaped. `cross-tenant.test.ts`'s manifest and
 * `openapi-drift.test.ts` each get a distinct entry to reason about, rather than
 * one route whose behaviour depends on its body. And `ROUTE_ROLE_OVERRIDES`
 * matches on method and path — so a credentialed route sharing a path with a
 * submission route could not be given a different role floor, and this one needs
 * a higher one.
 *
 * ## The role floor, and the hole it closes
 *
 * `admin`, set in `ROUTE_ROLE_OVERRIDES` before this route existed. §4.8 named
 * the reason as an open question: `GET`/`POST /credentials` are admin-gated
 * because *"a member who submits scans has no reason to hold one"*, but
 * `resolveCredentialRef()` checks the **organisation, not the role** — so a
 * member who cannot list credentials could still *use* one by guessing a small
 * integer in this route's body. Gating the route is what closes it. Any future
 * route accepting a `credentialId` inherits the same obligation.
 *
 * ## Submission is not deprecated by this
 *
 * `POST /projects/:id/kms` keeps accepting `{ keys: [...] }` forever (§4.7): an
 * air-gapped estate has no other path, a customer who declines to issue a
 * credential is a normal customer rather than an edge case, and the submission
 * collectors are the tested ones — a credentialed path that regresses has a
 * working fallback the same day.
 */

const router: IRouter = Router();

/**
 * The asset-location prefix an enumerated scope licenses reconciliation within.
 *
 * **Region- and account-granular, not provider-granular**, and that is §4.5's
 * second corollary made concrete: *"enumerated must be recorded at the
 * granularity the prefix is taken at — enumerating the AWS account does not
 * license retiring keys in `ap-south-1` if `ap-south-1` was never called."*
 *
 * `kmsLocationPrefix()` returns `<repo>:kms:<provider>:` — the whole provider,
 * which is too broad to retire against on its own. So it supplies that half and
 * the ARN's `arn:aws:kms:<region>:<account>:` is appended, narrowing the family
 * to exactly the scope that was enumerated, which is the only prefix this run
 * has evidence for.
 *
 * Returns `null` for anything else, which `earnedPrefixes()` treats as no
 * prefix earned: the safe direction.
 */
function kmsPrefixForScope(repo: string, scope: DiscoveryScope): string | null {
  if (scope.kind !== "cloud_account" || scope.provider !== "aws" || scope.region === undefined) return null;
  // `kmsLocationPrefix()` supplies the `<repo>:kms:<provider>:` half rather than
  // it being written out here, and that is not tidiness — it is the bug this
  // line already had. The scope's provider is AWS's word, `aws`; the location's
  // provider is the collector's, `aws-kms` (KMS_PROVIDER_VALUES names the
  // product, not the cloud). Hand-writing the prefix silently produced
  // `…:kms:aws:…`, which is earned, valid, and matches no asset ever stored —
  // so every guardrail test still passed while retirement did nothing at all.
  return `${kmsLocationPrefix(repo, awsKmsAcquisition.locationProvider)}arn:aws:kms:${scope.region}:${scope.account}:`;
}

router.post("/projects/:id/kms/poll", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(String(raw), 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  const body = PollProjectKmsBody.safeParse(req.body);
  if (!body.success) {
    // `body.error.message` is deliberately not returned. It serialises the
    // rejected input, and the rejected input to this route names a credential.
    // Same rule `routes/credentials.ts` follows.
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const ctx = orgContextFor(req);
  const repo = projectRepoId(id);

  const scopes: DiscoveryScope[] = body.data.regions.map((region) => ({
    kind: "cloud_account" as const,
    provider: "aws",
    account: body.data.account,
    region,
    service: "kms",
  }));

  // ── 1. Resolve the parent and the credential, inside a scope ───────────────
  //
  // Both must be confirmed visible *inside* the transaction. A foreign key is
  // not subject to RLS, and neither is an integer in a request body — so
  // neither the project id nor the credential id may be acted on until a
  // scoped SELECT has returned it.
  const resolved = await withOrg(ctx, async (tx) => {
    const [parent] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, id));
    if (!parent) return { kind: "no-project" as const };

    const ref = await resolveCredentialRef(tx, body.data.credentialId, awsKmsAcquisition.credentialKind);
    // 404 rather than 403, and it does not confirm the row exists: which cloud
    // accounts a company has connected is commercially sensitive on its own.
    if (ref === null) return { kind: "no-credential" as const };

    return { kind: "ok" as const, ref };
  });

  if (resolved.kind === "no-project") {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (resolved.kind === "no-credential") {
    res.status(404).json({ error: "Credential not found" });
    return;
  }

  // ── 2. Redeem and enumerate, OUTSIDE any transaction ──────────────────────
  //
  // `withRedeemedCredential` commits the redemption before running the
  // callback, so the pooled connection is released for the duration of the
  // vendor round trips. Doing this inside `withOrg` would pin a connection idle
  // for the length of a paginated cloud enumeration — the same reason
  // `schedule-runner.ts` takes an `OrgScope` rather than a `ScopedTx`.
  let acquired;
  try {
    acquired = await withRedeemedCredential({ withOrg }, ctx, resolved.ref, (secret: SecretHandle) =>
      awsKmsAcquisition.acquire(secret, { scopes, maxItems: body.data.maxKeys ?? 500 }),
    );
  } catch (err: unknown) {
    if (err instanceof CredentialUnusableError) {
      // A revoked, expired or undecryptable credential means **no collection
      // happened** — not a collection that found nothing. Returning 200 with an
      // empty result would make an unusable credential read as an empty key
      // store, which is the exact class of false negative this product refuses.
      res.status(409).json({ error: `Credential unusable: ${err.reason}` });
      return;
    }
    throw err;
  }

  const enumeration: EnumerationRecord = enumerationRecordFor(acquired, resolved.ref.credentialId);
  const decision = earnedPrefixes(enumeration, (scope) => kmsPrefixForScope(repo, scope));

  // ── 3. Persist, inside a fresh scope ───────────────────────────────────────
  //
  // A run that read nothing still records what it attempted. The alternative —
  // returning early with no record — is the defect G-25 closed one level up: an
  // attempt that produced nothing must be distinguishable from an attempt that
  // never happened, and only a row can do that.
  if (acquired.input.length === 0) {
    logger.info(
      { projectId: id, enumerated: enumeration.enumerated.length, refused: enumeration.refused.length, route: "POST /projects/:id/kms/poll" },
      "KMS poll returned no keys",
    );
    res.json({
      projectId: id,
      keysRead: 0,
      keysObserved: 0,
      keysUnclassified: 0,
      keys: [],
      collectionRunId: null,
      assetsCreated: 0,
      assetsUpdated: 0,
      observationsCreated: 0,
      assetsMarkedGone: 0,
      enumeration,
      reconciliation: decision.reason,
      evidenceCaveat: KMS_POLL_EVIDENCE_CAVEAT,
    });
    return;
  }

  const result = await withOrg(ctx, (tx) =>
    ingestKmsObservations(tx, {
      repo,
      keys: acquired.input,
      organizationId: ctx.organizationId,
      provenance: { acquisition: "polled" },
      enumeration,
      ...(decision.prefixes === null ? {} : { reconcilePrefixes: decision.prefixes }),
    }),
  );

  const observed = result.outcomes.filter((o) => o.kind === "observed").length;
  logger.info(
    {
      projectId: id,
      keysRead: acquired.input.length,
      keysObserved: observed,
      enumerated: enumeration.enumerated.length,
      refused: enumeration.refused.length,
      truncated: enumeration.truncated,
      prefixesEarned: decision.prefixes?.length ?? 0,
      assetsMarkedGone: result.assetsMarkedGone,
      route: "POST /projects/:id/kms/poll",
    },
    "KMS poll complete",
  );

  res.json({
    projectId: id,
    keysRead: acquired.input.length,
    keysObserved: observed,
    keysUnclassified: result.outcomes.length - observed,
    keys: result.outcomes.map(toKmsKeyResponseEntry),
    collectionRunId: result.collectionRunId,
    assetsCreated: result.assetsCreated,
    assetsUpdated: result.assetsUpdated,
    observationsCreated: result.observationsCreated,
    assetsMarkedGone: result.assetsMarkedGone,
    enumeration,
    reconciliation: decision.reason,
    evidenceCaveat: KMS_POLL_EVIDENCE_CAVEAT,
  });
});

export default router;
