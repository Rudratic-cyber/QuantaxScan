import { Router, type IRouter } from "express";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { withOrg, assetsTable, waiversTable } from "@workspace/db";
import { resolveWaiverStatus, waiverAttribution, type WaiverStatus } from "@workspace/db/waivers";
import { orgContextFor } from "../lib/principal";
import { logger } from "../lib/logger";

/**
 * C8 — the waivers / exceptions register. docs/Claude/03-features.md §C8.
 *
 * Three routes and no fourth. There is no `DELETE`: a register you can delete
 * from records only what nobody minded recording, so a waiver is *revoked*,
 * which closes it while leaving the row and the name on it.
 *
 * ## Who may grant one
 *
 * `POST /waivers` is `admin`, listed in `ROUTE_ROLE_OVERRIDES`. Accepting a
 * risk is the same class of act as publishing a report outside the tenant or
 * holding a cloud credential, and it has a specific failure the others do not:
 * the person best placed to silence an inconvenient finding is the member who
 * submitted the scan that raised it. Self-service risk acceptance is how an
 * inventory becomes fiction.
 *
 * `POST /waivers/:id/revoke` is left on the **default `member` gate**, and that
 * asymmetry is deliberate. Revoking restores a finding to the working list; it
 * is the fail-safe direction, and making un-silencing harder than silencing
 * would be the wrong way round. `GET /waivers` is a read, so `viewer`.
 *
 * ## What a waiver does to the numbers
 *
 * Nothing. Not "nothing much" — nothing. The inventory annotation added in
 * `summariseInventoryAssets()` attaches the active waiver to the asset row and
 * changes no count, no coverage figure, no readiness section and no CBOM
 * component. `tests/e2e/20-waivers.spec.ts` asserts those payloads are
 * byte-identical either side of a granted waiver. An accepted risk is still a
 * risk that was accepted, and a product that let one improve a score would be
 * selling the thing it was built to prevent.
 *
 * ## Not waiver-aware, deliberately
 *
 * The legacy `findings` read path — `routes/scans.ts`, `routes/projects.ts`,
 * `routes/stats.ts` — knows nothing about waivers. `findings` is pre-cutover
 * and dual-written pending the `observations` migration
 * (docs/Claude/04-architecture.md §"Migration path"); teaching a table that is
 * being deleted about a feature added today buys one release of consistency and
 * costs a second implementation of the expiry rule. Waivers attach to `assets`,
 * which is where the read is going.
 */

const router: IRouter = Router();

/** A waiver cannot outrun the conversation that would renew it. Two years is already generous. */
const MAX_WAIVER_DAYS = 730;
const MAX_JUSTIFICATION = 4000;

function parseId(raw: unknown): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = parseInt(String(value), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

interface WaiverRow {
  id: number;
  assetId: number;
  divisionId: number | null;
  justification: string;
  signedOffBy: string;
  signedOffByUserId: string | null;
  signedOffAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedByUserId: string | null;
}

/**
 * The wire shape. `status` is computed here rather than stored, for the same
 * reason a resolved obligation is never written to a row: a stored status is a
 * second source of truth that goes stale at a moment nobody is watching — in
 * this case, precisely at the expiry the whole feature turns on.
 */
interface PresentedWaiver {
  id: number;
  assetId: number;
  divisionId: number | null;
  justification: string;
  signedOffBy: string;
  attribution: "authenticated" | "asserted";
  signedOffAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: WaiverStatus;
  daysRemaining: number;
}

function present(row: WaiverRow, now: Date): PresentedWaiver {
  const status: WaiverStatus = resolveWaiverStatus(row, now);
  return {
    id: row.id,
    assetId: row.assetId,
    divisionId: row.divisionId,
    justification: row.justification,
    signedOffBy: row.signedOffBy,
    // Whether the platform verified that name or is only repeating it. Reported
    // rather than hidden — see `waiverAttribution`.
    attribution: waiverAttribution(row.signedOffByUserId),
    signedOffAt: row.signedOffAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
    status,
    /** Negative once expired. The client never recomputes this from `expiresAt` and a local clock. */
    daysRemaining: Math.ceil((row.expiresAt.getTime() - now.getTime()) / 86_400_000),
  };
}

const WAIVER_COLUMNS = {
  id: waiversTable.id,
  assetId: waiversTable.assetId,
  divisionId: waiversTable.divisionId,
  justification: waiversTable.justification,
  signedOffBy: waiversTable.signedOffBy,
  signedOffByUserId: waiversTable.signedOffByUserId,
  signedOffAt: waiversTable.signedOffAt,
  expiresAt: waiversTable.expiresAt,
  revokedAt: waiversTable.revokedAt,
  revokedByUserId: waiversTable.revokedByUserId,
} as const;

/**
 * GET /api/waivers — the register.
 *
 * Returns **every** waiver, expired and revoked included, with its status. No
 * `where expires_at > now()` appears anywhere: an exceptions register that
 * forgets the exceptions that lapsed cannot answer "what have we been
 * accepting?", which is the only question an auditor asks it. `?status=` filters
 * for a caller that wants the working subset, and defaults to everything.
 */
router.get("/waivers", async (req, res): Promise<void> => {
  const now = new Date();
  const requested = typeof req.query.status === "string" ? req.query.status : undefined;

  const rows = await withOrg(orgContextFor(req), async (tx) => {
    const waivers = await tx
      .select(WAIVER_COLUMNS)
      .from(waiversTable)
      .orderBy(desc(waiversTable.signedOffAt), desc(waiversTable.id));

    // The asset each waiver names, so the register reads as a list of accepted
    // risks rather than a list of integers.
    const assets = await tx
      .select({
        id: assetsTable.id,
        fingerprint: assetsTable.fingerprint,
        surface: assetsTable.surface,
        algorithm: assetsTable.algorithm,
        location: assetsTable.location,
        status: assetsTable.status,
      })
      .from(assetsTable)
      .orderBy(asc(assetsTable.id));

    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    return waivers.map((row) => ({ ...present(row, now), asset: assetById.get(row.assetId) ?? null }));
  });

  const filtered = requested === undefined ? rows : rows.filter((row) => row.status === requested);

  res.json({
    generatedAt: now.toISOString(),
    waivers: filtered,
    // Counts over the whole register, never over the filtered slice: a caller
    // asking for the active ones still needs to know how many lapsed.
    counts: {
      active: rows.filter((row) => row.status === "active").length,
      expired: rows.filter((row) => row.status === "expired").length,
      revoked: rows.filter((row) => row.status === "revoked").length,
    },
  });
});

/**
 * POST /api/waivers — accept a risk, in writing, with an end date.
 *
 * `expiresAt` is required and has no "never" spelling. Every validation below
 * refuses at the edge rather than storing something the register would later
 * have to explain.
 */
router.post("/waivers", async (req, res): Promise<void> => {
  const { assetId, justification, signedOffBy, expiresAt } = (req.body ?? {}) as Record<string, unknown>;
  const now = new Date();

  const parsedAssetId = parseId(assetId);
  if (parsedAssetId === null) {
    res.status(400).json({ error: "`assetId` must be the id of an asset in this organisation." });
    return;
  }
  if (typeof justification !== "string" || justification.trim().length === 0) {
    res.status(400).json({
      error: "`justification` is required. A risk accepted for no stated reason has not been accepted, it has been ignored.",
    });
    return;
  }
  if (justification.length > MAX_JUSTIFICATION) {
    res.status(400).json({ error: `\`justification\` must be at most ${MAX_JUSTIFICATION} characters.` });
    return;
  }
  if (typeof signedOffBy !== "string" || signedOffBy.trim().length === 0) {
    res.status(400).json({
      error: "`signedOffBy` is required. A waiver attributed to nobody is an anonymous suppression.",
    });
    return;
  }
  if (typeof expiresAt !== "string") {
    res.status(400).json({
      error: "`expiresAt` is required — an ISO 8601 timestamp. A waiver that does not expire is not an exception.",
    });
    return;
  }

  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) {
    res.status(400).json({ error: "`expiresAt` is not a valid ISO 8601 timestamp." });
    return;
  }
  if (expiry.getTime() <= now.getTime()) {
    // The database's CHECK would reject this too. Answering here makes it a 400
    // with a sentence rather than a 500 with a constraint name.
    res.status(400).json({ error: "`expiresAt` must be in the future. A waiver that has already expired suppresses nothing." });
    return;
  }
  const days = (expiry.getTime() - now.getTime()) / 86_400_000;
  if (days > MAX_WAIVER_DAYS) {
    res.status(400).json({
      error: `A waiver may run for at most ${MAX_WAIVER_DAYS} days. Longer than that and nobody who signed it will still be here to renew it — grant a shorter one and revisit it.`,
    });
    return;
  }

  const ctx = orgContextFor(req);
  const outcome = await withOrg(ctx, async (tx) => {
    // The parent, confirmed *inside* the scope. A foreign key is checked with
    // row-level security bypassed, so PostgreSQL would happily accept another
    // organisation's asset id here and the waiver would be written against a
    // row this tenant cannot see.
    const [asset] = await tx
      .select({ id: assetsTable.id, divisionId: assetsTable.divisionId })
      .from(assetsTable)
      .where(eq(assetsTable.id, parsedAssetId));
    if (!asset) return null;

    const [row] = await tx
      .insert(waiversTable)
      .values({
        organizationId: ctx.organizationId,
        // Copied from the asset, never taken from the caller: a waiver whose
        // division disagrees with its asset's is visible to people who cannot
        // see what it waives.
        divisionId: asset.divisionId,
        assetId: asset.id,
        justification: justification.trim(),
        signedOffBy: signedOffBy.trim(),
        // Null for the API-key principal, which has no person behind it. The
        // read reports that as `attribution: "asserted"` rather than dressing a
        // shared credential up as a signature.
        signedOffByUserId: ctx.userId === "" ? null : ctx.userId,
        expiresAt: expiry,
      })
      .returning(WAIVER_COLUMNS);
    return row;
  });

  if (outcome === null) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }

  logger.info(
    { waiverId: outcome.id, assetId: outcome.assetId, expiresAt: outcome.expiresAt, route: "POST /waivers" },
    "risk accepted — waiver granted",
  );
  res.status(201).json(present(outcome, now));
});

/**
 * POST /api/waivers/:id/revoke — withdraw an acceptance early.
 *
 * Idempotent-ish by refusal: revoking an already-revoked waiver is a 409 rather
 * than a silent success, because the second caller believed they were changing
 * something and the first revocation's timestamp and author are the record.
 * Revoking an *expired* waiver is allowed and is not a no-op — it says the
 * acceptance was withdrawn rather than merely lapsed, which is a different
 * sentence in an audit.
 */
router.post("/waivers/:id/revoke", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid waiver ID" });
    return;
  }

  const now = new Date();
  const ctx = orgContextFor(req);
  const outcome = await withOrg(ctx, async (tx) => {
    const [existing] = await tx.select({ id: waiversTable.id, revokedAt: waiversTable.revokedAt })
      .from(waiversTable)
      .where(eq(waiversTable.id, id));
    if (!existing) return { error: "not-found" as const };
    if (existing.revokedAt !== null) return { error: "already-revoked" as const };

    const [row] = await tx
      .update(waiversTable)
      .set({ revokedAt: now, revokedByUserId: ctx.userId === "" ? null : ctx.userId })
      // `isNull(revokedAt)` as well as the id: two concurrent revocations would
      // otherwise both succeed and the second would overwrite the first's
      // timestamp and author.
      .where(and(eq(waiversTable.id, id), isNull(waiversTable.revokedAt)))
      .returning(WAIVER_COLUMNS);
    return row ? { waiver: row } : { error: "already-revoked" as const };
  });

  if ("error" in outcome) {
    if (outcome.error === "already-revoked") {
      res.status(409).json({ error: "That waiver has already been revoked." });
      return;
    }
    res.status(404).json({ error: "Waiver not found" });
    return;
  }

  logger.info({ waiverId: id, route: "POST /waivers/:id/revoke" }, "waiver revoked");
  res.json(present(outcome.waiver, now));
});

export default router;
