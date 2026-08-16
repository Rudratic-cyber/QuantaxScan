import { Router, type IRouter } from "express";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import {
  withOrg,
  projectsTable,
  assetsTable,
  discoveredTargetsTable,
  discoveryRunsTable,
  projectRepoId,
  type DiscoveredTarget,
} from "@workspace/db";
import {
  resolveCredentialRef,
  withRedeemedCredential,
  CredentialUnusableError,
  type SecretHandle,
} from "@workspace/db/credentials";
import { RunProjectDiscoveryBody, ProbeDiscoveredTargetsBody, DiscoverCloudResourcesBody } from "@workspace/api-zod";
import {
  certificateExpired,
  DISCOVERY_EVIDENCE_CAVEAT,
  DISCOVERY_METHOD_CAVEATS,
  MAX_DISCOVERED_HOSTNAMES_PER_RUN,
  type DiscoveryRunStatus,
  type EnumerationRecord,
  type CtCertificateEvidence,
  type DiscoveryScope,
  type DnsResolution,
} from "@workspace/collectors";
import type { ScopedTx } from "@workspace/db/org-scope";
import { queryCertificateTransparency, CtQueryError } from "../lib/ct-log";
import { corroborateHostnames } from "../lib/dns-corroboration";
import { examinedHostPorts, summariseDiscoveryCoverage } from "../lib/discovery-coverage";
import { probeTlsTargets, MAX_TLS_TARGETS_PER_SUBMISSION } from "../lib/tls-probe";
import { acquireS3Leads } from "../lib/acquisition/aws-s3-discovery";
import { enumerationRecordFor } from "../lib/acquisition/types";
import { ingestTlsObservations } from "../lib/asset-ingest";
import { orgContextFor } from "../lib/principal";
import { logger } from "../lib/logger";

/**
 * D8 — asset and host discovery. docs/Claude/03-features.md §D8.
 *
 * Every handler runs inside `withOrg` and uses the `tx` it is handed, so `db`
 * is not imported here — the same rule as every other route file.
 *
 * ## The boundary this file is mostly about
 *
 * Discovery and scanning are separate acts, and this file keeps them separate
 * on purpose:
 *
 *   - `POST /projects/:id/discovery` reads a **public log** and, as
 *     corroboration, asks a **resolver** about the names it found. Neither of
 *     those touches the customer's hosts. It writes leads.
 *   - `POST /projects/:id/discovered-targets/probe` opens a **TCP connection**
 *     from this server to a machine, which is a thing a customer has to
 *     consent to and a thing that shows up in somebody's logs.
 *
 * Discovery finding a name is not consent to connect to it. A CT log routinely
 * names hosts that turn out to belong to a supplier, a former subsidiary, a
 * CDN, or an unrelated third party who happened to share a certificate — and
 * an automatic probe would mean this product port-scanning strangers on a
 * customer's behalf, from the customer's account, without either party having
 * asked. So the handoff is a distinct call, it requires the caller to name the
 * target ids, there is no "probe everything discovered" shortcut, and the port
 * has no default. Every one of those is friction on purpose.
 */

const router: IRouter = Router();

/**
 * What the probe route's results are and are not. Two claims, because a probe
 * of a discovered target inherits both sets of limits: B3's (what a handshake
 * observes) and D8's (what the name it was pointed at is evidence of).
 */
const DISCOVERED_PROBE_EVIDENCE_CAVEAT =
  "Each result below is a real TLS handshake with the named host: it records the negotiated key-exchange " +
  "algorithm/group and the peer certificate's public key type/size only — no certificate identity, chain or " +
  "validity (see B4), and no certificate is validated against any CA. The hosts were named by the caller from " +
  "certificate-transparency discovery, which is evidence that a certificate covering the name was logged — not " +
  "that this organisation owns or operates it.";

function parseProjectId(raw: unknown): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = parseInt(String(value), 10);
  return Number.isInteger(id) ? id : null;
}

/**
 * The domain a CT target was found under, read back out of `source_scope`.
 *
 * Stage 0 replaced `source_domain text` with a discriminated `source_scope`
 * jsonb, because "what did you search?" outgrew a string the moment a cloud
 * account (provider, account, region, service) became answerable. Every row
 * this route can see is `kind: "domain"` — it is the only method that writes
 * here — so the fallback is unreachable rather than lossy, and it returns the
 * empty string rather than inventing a plausible domain, which is the same rule
 * `normaliseHostname()` follows.
 */
function sourceDomainOf(scope: DiscoveryScope): string {
  return scope.kind === "domain" ? scope.domain : "";
}

/** Shape of one target as every response in this file returns it. `examined` and `certificateExpired` are derived here, never stored. */
function targetPayload(row: DiscoveredTarget, examinedPorts: Map<string, number[]>, asOf: Date) {
  // `hostname` is nullable since stage 0 — a KMS key ring has no DNS name. For
  // a `hostname`-kind target it always equals `identity`, and this route only
  // ever sees that kind, so the coalesce is total rather than a guess.
  const hostname = row.hostname ?? row.identity;
  const ports = examinedPorts.get(hostname) ?? [];
  return {
    id: row.id,
    hostname,
    sourceDomain: sourceDomainOf(row.sourceScope),
    discoveryMethod: row.discoveryMethod,
    evidence: row.evidence,
    certificateExpired: certificateExpired(row.evidence, asOf),
    dnsResolution: row.dnsResolution,
    resolvedAddresses: row.resolvedAddresses,
    dnsCheckedAt: row.dnsCheckedAt === null ? null : row.dnsCheckedAt.toISOString(),
    firstDiscoveredAt: row.firstDiscoveredAt.toISOString(),
    lastDiscoveredAt: row.lastDiscoveredAt.toISOString(),
    examined: ports.length > 0,
    examinedPorts: ports,
  };
}

/**
 * The four DNS states, counted. `notChecked` is the one that needs a column of
 * its own in a reader's head: it is a NULL, meaning nobody looked, which is
 * distinct from all three answers a lookup can give.
 */
function dnsSummary(rows: Array<{ dnsResolution: DnsResolution | null }>) {
  const count = (value: DnsResolution) => rows.filter((r) => r.dnsResolution === value).length;
  const notChecked = rows.filter((r) => r.dnsResolution === null).length;
  return {
    checked: rows.length - notChecked,
    resolved: count("resolved"),
    notResolved: count("not-resolved"),
    undetermined: count("undetermined"),
    notChecked,
  };
}

/** Every `tls` asset location of this project, so examined-ness can be derived rather than stored. */
async function examinedPortsFor(tx: ScopedTx, projectId: number): Promise<Map<string, number[]>> {
  const repo = projectRepoId(projectId);
  const assets = await tx
    .select({ location: assetsTable.location })
    .from(assetsTable)
    .where(and(eq(assetsTable.surface, "tls"), like(assetsTable.location, `${repo}:%`)));
  return examinedHostPorts(repo, assets.map((a) => a.location));
}

async function targetsFor(tx: ScopedTx, projectId: number): Promise<DiscoveredTarget[]> {
  return tx
    .select()
    .from(discoveredTargetsTable)
    .where(eq(discoveredTargetsTable.projectId, projectId))
    .orderBy(discoveredTargetsTable.hostname);
}

/**
 * D8 — `POST /api/projects/:id/discovery`.
 *
 * Structured like B3's TLS route: the outbound work happens **before**
 * `withOrg` is opened, because `withOrg` holds a real database transaction for
 * its whole callback and a CT query plus up to a few hundred DNS lookups has
 * nothing to do with the database. The same cost applies — an unknown or
 * another organisation's project id still triggers the CT query before the 404
 * — and it is the same trade: wasted egress to a *public log*, not a data
 * leak. Nothing is persisted or returned until the parent is confirmed visible
 * inside the scope.
 *
 * Note that this cost is acceptable here for a reason it would not be on the
 * probe route below: the egress goes to crt.sh, not to a host somebody else
 * owns. That is why the probe route reads first and connects second.
 */
router.post("/projects/:id/discovery", async (req, res): Promise<void> => {
  const id = parseProjectId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }
  const body = RunProjectDiscoveryBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  let discovered: Awaited<ReturnType<typeof queryCertificateTransparency>>;
  try {
    discovered = await queryCertificateTransparency(body.data.domain);
  } catch (err) {
    if (err instanceof CtQueryError) {
      // `invalid-domain` is the caller's fault; everything else is the
      // source's, and a 502 says so rather than blaming the request.
      const status = err.reason === "invalid-domain" ? 400 : 502;
      logger.warn({ projectId: id, reason: err.reason }, "Certificate-transparency discovery failed");
      res.status(status).json({ error: "Certificate-transparency query failed", reason: err.reason });
      return;
    }
    throw err;
  }

  // Corroboration, not discovery — see `dns-corroboration.ts`. A name this
  // does not reach keeps `dnsResolution: null`, which is "nobody looked".
  const corroboration = await corroborateHostnames(discovered.hostnames.map((h) => h.hostname));

  const ctx = orgContextFor(req);
  const outcome = await withOrg(ctx, async (tx) => {
    // A foreign key is not subject to RLS, so the parent has to be confirmed
    // visible *inside* the scope before a child row referencing it is written.
    const [parent] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, id));
    if (!parent) return null;

    const before = await tx
      .select({ identity: discoveredTargetsTable.identity })
      .from(discoveredTargetsTable)
      .where(eq(discoveredTargetsTable.projectId, id));
    const known = new Set(before.map((b) => b.identity));

    if (discovered.hostnames.length > 0) {
      const now = new Date();
      await tx
        .insert(discoveredTargetsTable)
        .values(
          discovered.hostnames.map((found) => {
            const dns = corroboration.get(found.hostname);
            return {
              organizationId: ctx.organizationId,
              projectId: id,
              // Both, and they are equal here on purpose. `identity` is the id
              // the unique index keys on for every method; `hostname` is set
              // only where the target genuinely has a DNS name, which is what
              // makes the three corroboration columns beneath it meaningful.
              // For certificate transparency the two coincide — that is a fact
              // about this method, not a redundancy to collapse.
              identity: found.hostname,
              targetKind: "hostname" as const,
              hostname: found.hostname,
              sourceScope: { kind: "domain" as const, domain: discovered.domain },
              discoveryMethod: found.method,
              evidence: found.evidence,
              // Absent from the map = never looked up. Null, not a value.
              dnsResolution: dns?.resolution ?? null,
              resolvedAddresses: dns === undefined ? null : dns.addresses,
              dnsCheckedAt: dns?.checkedAt ?? null,
              lastDiscoveredAt: now,
            };
          }),
        )
        .onConflictDoUpdate({
          target: [
            discoveredTargetsTable.organizationId,
            discoveredTargetsTable.projectId,
            // `identity`, not `hostname`, since stage 0 — and this is the line
            // that has to change rather than merely being allowed to. NULLs do
            // not collide in a unique index, so an ON CONFLICT keyed on a now-
            // nullable `hostname` would stop matching for every target kind
            // without a DNS name and duplicate it on every re-run.
            discoveredTargetsTable.identity,
            discoveredTargetsTable.discoveryMethod,
          ],
          // `firstDiscoveredAt` is deliberately absent: re-running discovery
          // must not reset when a name was first seen. Everything else is the
          // newer evidence and replaces what was there.
          set: {
            hostname: sql`excluded.hostname`,
            sourceScope: sql`excluded.source_scope`,
            evidence: sql`excluded.evidence`,
            dnsResolution: sql`excluded.dns_resolution`,
            resolvedAddresses: sql`excluded.resolved_addresses`,
            dnsCheckedAt: sql`excluded.dns_checked_at`,
            lastDiscoveredAt: sql`excluded.last_discovered_at`,
          },
        });
    }

    const rows = await targetsFor(tx, id);
    return {
      rows,
      examined: await examinedPortsFor(tx, id),
      created: discovered.hostnames.filter((h) => !known.has(h.hostname)).length,
      updated: discovered.hostnames.filter((h) => known.has(h.hostname)).length,
    };
  });

  if (outcome === null) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const asOf = new Date();
  logger.info(
    {
      projectId: id,
      domain: discovered.domain,
      namesRead: discovered.namesRead,
      accepted: discovered.hostnames.length,
      rejected: discovered.rejected.length,
      route: "POST /projects/:id/discovery",
    },
    "Discovery run complete",
  );

  res.json({
    projectId: id,
    domain: discovered.domain,
    entriesRead: discovered.entriesRead,
    namesRead: discovered.namesRead,
    namesAccepted: discovered.hostnames.length,
    truncated: discovered.truncated,
    rejected: discovered.rejected,
    targetsCreated: outcome.created,
    targetsUpdated: outcome.updated,
    knownTargets: outcome.rows.length,
    dns: dnsSummary(outcome.rows),
    targets: outcome.rows.map((row) => targetPayload(row, outcome.examined, asOf)),
    evidenceCaveat: DISCOVERY_EVIDENCE_CAVEAT,
  });
});

/** D8 — `GET /api/projects/:id/discovered-targets`. */
router.get("/projects/:id/discovered-targets", async (req, res): Promise<void> => {
  const id = parseProjectId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  const outcome = await withOrg(orgContextFor(req), async (tx) => {
    // An unknown *or* another organisation's project is a 404, matching
    // `GET /projects/:id`. Returning an empty list instead would tell the
    // caller the project exists and has no discovered targets, which is a
    // different and false statement.
    const [parent] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, id));
    if (!parent) return null;
    return { rows: await targetsFor(tx, id), examined: await examinedPortsFor(tx, id) };
  });

  if (outcome === null) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const asOf = new Date();
  res.json({
    projectId: id,
    generatedAt: asOf.toISOString(),
    coverage: summariseDiscoveryCoverage({
      // Hostname-bearing targets only. `hostname` became nullable in stage 0
      // and this meter is keyed on a name it can match against
      // `assets.location`, so a target without one cannot be matched either
      // way. Today that filter removes nothing — certificate transparency is
      // the only writer and every row it produces has a name.
      //
      // It stops being a no-op the moment cloud enumeration lands, and the fix
      // is NOT to widen this call: a KMS key ring is not "unexamined", it is a
      // different kind of thing that this denominator was never counting.
      // Reshaping the meter to hold both is lane P4's work
      // (docs/Claude/17-discovery-design.md §5.2, §6.2) — deliberately not
      // stage 0's, because a meter that silently changes meaning is worse than
      // one that visibly does not cover a case yet.
      hostnames: outcome.rows.flatMap((r) => (r.hostname === null ? [] : [r.hostname])),
      examinedHostnames: outcome.examined.keys(),
    }),
    dns: dnsSummary(outcome.rows),
    targets: outcome.rows.map((row) => targetPayload(row, outcome.examined, asOf)),
    evidenceCaveat: DISCOVERY_EVIDENCE_CAVEAT,
  });
});

/**
 * D8 → B3 — `POST /api/projects/:id/discovered-targets/probe`.
 *
 * **Reads first, connects second**, which is the opposite ordering to B3's own
 * route and to the discovery route above, deliberately.
 *
 * Those two accept some wasted egress before the 404 because their outbound
 * work goes somewhere the caller already named (B3) or to a public log (D8).
 * Here the hostnames come out of *this database*, so probing before confirming
 * the ids are visible in the caller's organisation would let an unauthorised
 * caller make this server open sockets to another tenant's hosts by guessing
 * integers. They would learn nothing from the response — but the connection
 * would have happened, and it would appear in a third party's logs as coming
 * from us. So the scope is opened, the ids resolved, the scope closed, and
 * only then is anything connected to.
 *
 * Two sequential `withOrg` calls, not one wrapping the probe: `withOrg` holds a
 * transaction for its whole callback and the probe may take
 * `MAX_TLS_TARGETS_PER_SUBMISSION × TLS_PROBE_TIMEOUT_MS`. Sequential scopes
 * are fine — only *nesting* is forbidden.
 */
router.post("/projects/:id/discovered-targets/probe", async (req, res): Promise<void> => {
  const id = parseProjectId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }
  const body = ProbeDiscoveredTargetsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const requested = [...new Set(body.data.targetIds)];
  if (requested.length > MAX_TLS_TARGETS_PER_SUBMISSION) {
    res.status(400).json({ error: `At most ${MAX_TLS_TARGETS_PER_SUBMISSION} targets per call` });
    return;
  }
  const port = body.data.port;

  const ctx = orgContextFor(req);
  const resolved = await withOrg(ctx, async (tx) => {
    const [parent] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, id));
    if (!parent) return null;
    if (requested.length === 0) return { hostnames: [] as string[], found: [] as number[] };

    const rows = await tx
      .select({ id: discoveredTargetsTable.id, hostname: discoveredTargetsTable.hostname })
      .from(discoveredTargetsTable)
      .where(and(eq(discoveredTargetsTable.projectId, id), inArray(discoveredTargetsTable.id, requested)));

    // A target with no DNS name cannot be probed — you cannot open a TLS
    // socket to a KMS key ARN. Dropped from the host list rather than
    // coerced, while its id stays in `found` so the caller is told the
    // target existed and is not sent a 404 that would read as "no such
    // target". Empty today: certificate transparency writes only hostnames.
    return {
      hostnames: [...new Set(rows.flatMap((r) => (r.hostname === null ? [] : [r.hostname])))],
      found: rows.map((r) => r.id),
    };
  });

  if (resolved === null) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // An id belonging to another organisation and an id that does not exist are
  // indistinguishable here, matching `GET /projects/:id` — distinguishing them
  // would confirm the row is real.
  const notFound = requested.filter((targetId) => !resolved.found.includes(targetId));

  const outcomes = await probeTlsTargets(resolved.hostnames.map((host) => ({ host, port })));
  const probed = outcomes.filter(
    (o): o is Extract<(typeof outcomes)[number], { outcome: "probed" }> => o.outcome === "probed",
  );

  const repo = projectRepoId(id);
  const ingested = await withOrg(ctx, async (tx) => {
    const [parent] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, id));
    if (!parent) return null;
    // No completed handshake means nothing was examined. Writing a collection
    // run here would make the coverage meter report the tls surface as
    // "examined — nothing found", which is a different and false statement.
    if (probed.length === 0) return "no-handshakes" as const;
    return ingestTlsObservations(tx, {
      repo,
      probed: probed.map((p) => ({ host: p.host, port: p.port, handshake: p.handshake })),
      organizationId: ctx.organizationId,
    });
  });

  if (ingested === null) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const result =
    ingested === "no-handshakes"
      ? { collectionRunId: null, assetsCreated: 0, assetsUpdated: 0, observationsCreated: 0, assetsMarkedGone: 0 }
      : ingested;

  res.json({
    projectId: id,
    targetIdsRequested: requested.length,
    targetIdsNotFound: notFound,
    targetsSubmitted: resolved.hostnames.length,
    targetsProbed: probed.length,
    targets: outcomes.map((o) => ({ host: o.host, port: o.port, outcome: o.outcome })),
    collectionRunId: result.collectionRunId,
    assetsCreated: result.assetsCreated,
    assetsUpdated: result.assetsUpdated,
    observationsCreated: result.observationsCreated,
    assetsMarkedGone: result.assetsMarkedGone,
    evidenceCaveat: DISCOVERED_PROBE_EVIDENCE_CAVEAT,
  });
});

/**
 * What became of a credentialed enumeration, from what it enumerated and what
 * it could not.
 *
 * **`partial` is the value that did not exist anywhere in this product before
 * stage 0 and had to.** For certificate transparency a query is total or it
 * fails, so two states sufficed. For a cloud enumeration partial success is the
 * *normal* case, and a run that read two of three accounts is neither
 * `succeeded` — it did not do what it was asked — nor `failed`, because it
 * produced real leads. Collapsing it into either destroys the only fact a
 * report actually needs: the boundary of what we can speak for.
 *
 * `no_evidence` is separate from `failed` for the reason
 * `collection_schedule_runs` distinguishes them: an attempt that ran correctly
 * and found nothing is not a failure, and must not read as one. An account with
 * no buckets is a real and reportable answer.
 */
function discoveryRunStatus(enumeration: EnumerationRecord, leadCount: number): DiscoveryRunStatus {
  if (enumeration.enumerated.length === 0) return "failed";
  if (enumeration.refused.length > 0 || enumeration.truncated) return "partial";
  return leadCount > 0 ? "succeeded" : "no_evidence";
}

/**
 * P2 — `POST /api/projects/:id/discovery/cloud`.
 * docs/Claude/17-discovery-design.md §3.2, §1.2, §2.3.
 *
 * Enumerates an AWS account's storage with the customer's own read-only
 * credential and records what it found as **leads**, not assets.
 *
 * ## The invariant this route is mostly about
 *
 * D8's first, inherited by every source: **discovery writes no `assets`, no
 * `observations` and no `collection_runs` row.** It examines nothing — a bucket
 * name is a place B7 *could* look, and until it does, this product knows
 * nothing about the cryptography behind it. The e2e assertion that guards this
 * walks every surface after a discovery run and requires all of them to still
 * read `never-examined`.
 *
 * That is also why `discovery_runs` is a separate table from `collection_runs`
 * rather than a row in it: sharing would put a run that examined nothing into
 * the table the coverage meter counts.
 *
 * ## Consent is not implied by discovery
 *
 * D8's fifth invariant survives credentialing. The customer issuing us a
 * read-only key establishes that the account is theirs — which is more than
 * certificate transparency ever establishes — but it does not make connecting
 * to the resources inside it a thing they asked for. Enumerating is a
 * control-plane read; examining a bucket is a separate act on a separate route,
 * against target ids the caller names.
 */
router.post("/projects/:id/discovery/cloud", async (req, res): Promise<void> => {
  const id = parseProjectId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  const body = DiscoverCloudResourcesBody.safeParse(req.body);
  if (!body.success) {
    // Not `body.error.message`: it serialises the rejected input, and the
    // rejected input names a credential.
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const ctx = orgContextFor(req);
  const scope: DiscoveryScope = { kind: "cloud_account", provider: "aws", account: body.data.account, service: "s3" };

  const resolved = await withOrg(ctx, async (tx) => {
    const [parent] = await tx
      .select({ id: projectsTable.id, divisionId: projectsTable.divisionId })
      .from(projectsTable)
      .where(eq(projectsTable.id, id));
    if (!parent) return { kind: "no-project" as const };

    // A credential id in a request body is not subject to RLS any more than a
    // foreign key is, so it is resolved inside the scope before being acted on.
    const ref = await resolveCredentialRef(tx, body.data.credentialId, "cloud_readonly_inventory");
    if (ref === null) return { kind: "no-credential" as const };

    return { kind: "ok" as const, ref, divisionId: parent.divisionId };
  });

  if (resolved.kind === "no-project") {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (resolved.kind === "no-credential") {
    res.status(404).json({ error: "Credential not found" });
    return;
  }

  // Outside the transaction, for the reason every other egress in this file is:
  // holding a pooled connection open across a provider round trip pins it idle.
  const startedAt = new Date();
  let acquired;
  try {
    acquired = await withRedeemedCredential({ withOrg }, ctx, resolved.ref, (secret: SecretHandle) =>
      acquireS3Leads(secret, { scopes: [scope], maxItems: body.data.maxTargets ?? MAX_DISCOVERED_HOSTNAMES_PER_RUN }),
    );
  } catch (err: unknown) {
    if (err instanceof CredentialUnusableError) {
      res.status(409).json({ error: `Credential unusable: ${err.reason}` });
      return;
    }
    throw err;
  }

  const enumeration = enumerationRecordFor(acquired, resolved.ref.credentialId);
  const status = discoveryRunStatus(enumeration, acquired.input.length);

  const outcome = await withOrg(ctx, async (tx) => {
    // The run row is written whatever happened, including `failed`. An
    // enumeration that produced nothing and one that never ran are different
    // facts, and only a row can tell them apart — the same argument G-25 closed
    // one level down for collection runs.
    const [run] = await tx
      .insert(discoveryRunsTable)
      .values({
        organizationId: ctx.organizationId,
        divisionId: resolved.divisionId,
        projectId: id,
        discoveryMethod: "cloud_account_enumeration",
        credentialId: resolved.ref.credentialId,
        status,
        enumerated: enumeration.enumerated,
        refused: enumeration.refused,
        truncated: enumeration.truncated,
        targetsCreated: 0,
        targetsUpdated: 0,
        targetsRejected: 0,
        startedAt,
        finishedAt: new Date(),
      })
      .returning();

    if (acquired.input.length === 0) return { run, created: 0, updated: 0 };

    const before = await tx
      .select({ identity: discoveredTargetsTable.identity })
      .from(discoveredTargetsTable)
      .where(and(eq(discoveredTargetsTable.projectId, id), eq(discoveredTargetsTable.discoveryMethod, "cloud_account_enumeration")));
    const known = new Set(before.map((b) => b.identity));

    const now = new Date();
    await tx
      .insert(discoveredTargetsTable)
      .values(
        acquired.input.map((lead) => ({
          organizationId: ctx.organizationId,
          divisionId: resolved.divisionId,
          projectId: id,
          identity: lead.identity,
          targetKind: lead.targetKind,
          // Absent for a bucket, and that is the honest value: it has a DNS
          // name only if we construct one, and a constructed name is a name
          // nobody has evidence for.
          hostname: lead.hostname ?? null,
          sourceScope: scope,
          discoveryMethod: "cloud_account_enumeration" as const,
          evidence: lead.evidence as never,
          lastDiscoveredRunId: run.id,
          lastDiscoveredAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [
          discoveredTargetsTable.organizationId,
          discoveredTargetsTable.projectId,
          discoveredTargetsTable.identity,
          discoveredTargetsTable.discoveryMethod,
        ],
        // `firstDiscoveredAt` absent on purpose: re-running must not reset when
        // a resource was first seen.
        set: {
          evidence: sql`excluded.evidence`,
          sourceScope: sql`excluded.source_scope`,
          lastDiscoveredRunId: sql`excluded.last_discovered_run_id`,
          lastDiscoveredAt: sql`excluded.last_discovered_at`,
        },
      });

    const created = acquired.input.filter((l) => !known.has(l.identity)).length;
    const updated = acquired.input.length - created;

    await tx
      .update(discoveryRunsTable)
      .set({ targetsCreated: created, targetsUpdated: updated })
      .where(eq(discoveryRunsTable.id, run.id));

    return { run, created, updated };
  });

  logger.info(
    {
      projectId: id,
      status,
      enumerated: enumeration.enumerated.length,
      refused: enumeration.refused.length,
      truncated: enumeration.truncated,
      targetsCreated: outcome.created,
      route: "POST /projects/:id/discovery/cloud",
    },
    "cloud discovery complete",
  );

  res.json({
    projectId: id,
    discoveryRunId: outcome.run.id,
    status,
    targetsCreated: outcome.created,
    targetsUpdated: outcome.updated,
    enumeration,
    // Resolved on read from the method, never stored — a claim written into a
    // row is a claim that cannot be corrected.
    evidenceCaveat: DISCOVERY_METHOD_CAVEATS.cloud_account_enumeration,
  });
});

export default router;
