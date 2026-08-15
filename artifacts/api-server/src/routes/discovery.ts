import { Router, type IRouter } from "express";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import {
  withOrg,
  projectsTable,
  assetsTable,
  discoveredTargetsTable,
  projectRepoId,
  type DiscoveredTarget,
} from "@workspace/db";
import { RunProjectDiscoveryBody, ProbeDiscoveredTargetsBody } from "@workspace/api-zod";
import {
  certificateExpired,
  DISCOVERY_EVIDENCE_CAVEAT,
  type CtCertificateEvidence,
  type DnsResolution,
} from "@workspace/collectors";
import type { ScopedTx } from "@workspace/db/org-scope";
import { queryCertificateTransparency, CtQueryError } from "../lib/ct-log";
import { corroborateHostnames } from "../lib/dns-corroboration";
import { examinedHostPorts, summariseDiscoveryCoverage } from "../lib/discovery-coverage";
import { probeTlsTargets, MAX_TLS_TARGETS_PER_SUBMISSION } from "../lib/tls-probe";
import { ingestTlsObservations } from "../lib/asset-ingest";
import { orgContextFor } from "../lib/principal";
import { logger } from "../lib/logger";

/**
 * D7 — asset and host discovery. docs/Claude/03-features.md §D7.
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
 * observes) and D7's (what the name it was pointed at is evidence of).
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

/** Shape of one target as every response in this file returns it. `examined` and `certificateExpired` are derived here, never stored. */
function targetPayload(row: DiscoveredTarget, examinedPorts: Map<string, number[]>, asOf: Date) {
  const ports = examinedPorts.get(row.hostname) ?? [];
  return {
    id: row.id,
    hostname: row.hostname,
    sourceDomain: row.sourceDomain,
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
 * D7 — `POST /api/projects/:id/discovery`.
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
      .select({ hostname: discoveredTargetsTable.hostname })
      .from(discoveredTargetsTable)
      .where(eq(discoveredTargetsTable.projectId, id));
    const known = new Set(before.map((b) => b.hostname));

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
              hostname: found.hostname,
              sourceDomain: discovered.domain,
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
            discoveredTargetsTable.hostname,
            discoveredTargetsTable.discoveryMethod,
          ],
          // `firstDiscoveredAt` is deliberately absent: re-running discovery
          // must not reset when a name was first seen. Everything else is the
          // newer evidence and replaces what was there.
          set: {
            sourceDomain: sql`excluded.source_domain`,
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

/** D7 — `GET /api/projects/:id/discovered-targets`. */
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
      hostnames: outcome.rows.map((r) => r.hostname),
      examinedHostnames: outcome.examined.keys(),
    }),
    dns: dnsSummary(outcome.rows),
    targets: outcome.rows.map((row) => targetPayload(row, outcome.examined, asOf)),
    evidenceCaveat: DISCOVERY_EVIDENCE_CAVEAT,
  });
});

/**
 * D7 → B3 — `POST /api/projects/:id/discovered-targets/probe`.
 *
 * **Reads first, connects second**, which is the opposite ordering to B3's own
 * route and to the discovery route above, deliberately.
 *
 * Those two accept some wasted egress before the 404 because their outbound
 * work goes somewhere the caller already named (B3) or to a public log (D7).
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

    return { hostnames: [...new Set(rows.map((r) => r.hostname))], found: rows.map((r) => r.id) };
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

export default router;
