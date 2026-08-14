import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { withOrg, otFleetsTable, type OtFleet } from "@workspace/db";
import { CreateOtFleetBody, UpdateOtFleetBody } from "@workspace/api-zod";
import { assessOtExposure } from "../lib/ot-exposure";
import { ingestOtObservations } from "../lib/asset-ingest";
import type { ScopedTx } from "@workspace/db/org-scope";
import { orgContextFor } from "../lib/principal";

const router: IRouter = Router();

/**
 * Re-derives the `ot` surface from the whole register, inside the caller's
 * scope. Called after every write, because the register is edited one row at a
 * time but *is* the complete enumeration of the OT estate — so a deletion, or
 * an edit that clears a stated algorithm, has to be able to retire the asset it
 * previously produced. Passing only the changed row could never do that.
 *
 * Runs on the same `ScopedTx` as the write it follows: one transaction, so the
 * register and the surface derived from it cannot disagree if the request fails
 * part-way.
 */
async function reingestRegister(tx: ScopedTx, organizationId: number): Promise<void> {
  const fleets = await tx.select().from(otFleetsTable);
  await ingestOtObservations(tx, {
    fleets: fleets.map((fleet) => ({
      id: fleet.id,
      name: fleet.name,
      vendor: fleet.vendor,
      model: fleet.model,
      site: fleet.site,
      deviceCount: fleet.deviceCount,
      cryptoInUse: fleet.cryptoInUse,
      cryptoAlgorithm: fleet.cryptoAlgorithm,
      cryptoKeySize: fleet.cryptoKeySize,
    })),
    organizationId,
  });
}


/**
 * B8 — the manual OT/embedded register. docs/Claude/03-features.md §B8,
 * docs/Claude/02-roadmap.md "Phase 5 — Long-lead surfaces".
 *
 * A *form*, not a scanner: every handler here runs inside `withOrg` exactly
 * like `routes/projects.ts`, and there is no collector, no fingerprint and no
 * `collection_runs` row anywhere in this file — a human enters and edits
 * fleets by hand. `fleetPayload()` is the one thing every response adds on
 * top of the raw `ot_fleets` row: the computed exposure (B8's payoff), which
 * is derived on read from `@workspace/risk`'s Q-Day scenarios and never
 * stored, so a scenario change or a corrected date is reflected immediately
 * with no backfill — the same discipline A4's Mosca verdicts and C1's
 * mappings follow.
 */

function fleetPayload(row: OtFleet) {
  return {
    ...row,
    exposure: assessOtExposure({ nextProcurementDate: row.nextProcurementDate }),
  };
}

function parseId(raw: unknown): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = parseInt(String(value), 10);
  return Number.isInteger(id) ? id : null;
}

router.get("/ot-fleets", async (req, res): Promise<void> => {
  const fleets = await withOrg(orgContextFor(req), (tx) =>
    tx.select().from(otFleetsTable).orderBy(desc(otFleetsTable.createdAt)),
  );
  res.json(fleets.map(fleetPayload));
});

router.post("/ot-fleets", async (req, res): Promise<void> => {
  const parsed = CreateOtFleetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, vendor, model, deviceCount, site, owner, cryptoInUse, refreshCycleYears, nextProcurementDate, cryptoAlgorithm, cryptoKeySize } =
    parsed.data;
  const ctx = orgContextFor(req);

  const [fleet] = await withOrg(ctx, async (tx) => {
    const inserted = await tx
      .insert(otFleetsTable)
      .values({
        organizationId: ctx.organizationId,
        name,
        vendor,
        model,
        deviceCount,
        site,
        owner,
        cryptoInUse,
        refreshCycleYears,
        // Already a `Date` — `CreateOtFleetBody.nextProcurementDate` is
        // `zod.coerce.date()`, so re-wrapping it in `new Date(...)` here
        // would not even typecheck (the Date constructor's single-argument
        // overloads take `number | string`, not `Date`).
        nextProcurementDate,
        cryptoAlgorithm,
        cryptoKeySize,
      })
      .returning();
    await reingestRegister(tx, ctx.organizationId);
    return inserted;
  });

  res.status(201).json(fleetPayload(fleet));
});

router.get("/ot-fleets/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid fleet ID" });
    return;
  }

  const [fleet] = await withOrg(orgContextFor(req), (tx) =>
    tx.select().from(otFleetsTable).where(eq(otFleetsTable.id, id)),
  );

  // Another organisation's fleet is indistinguishable from one that does not
  // exist, matching GET /projects/:id — a 403 would confirm it is real.
  if (!fleet) {
    res.status(404).json({ error: "Fleet not found" });
    return;
  }

  res.json(fleetPayload(fleet));
});

/**
 * PATCH, not PUT: a register gets corrected field by field as a customer
 * learns more, and `UpdateOtFleetBody` makes every field optional. Presence
 * in `parsed.data` — not truthiness — decides what changes: `key in
 * parsed.data` is false when the caller omitted the field (leave the stored
 * value, including a stored null, exactly as it was) and true when the
 * caller sent `null` explicitly (clear it back to "not supplied"). Zod
 * drops keys the input never mentioned from a `.safeParse()` result on an
 * object of optional fields, which is what makes the distinction available
 * at all — collapsing "omitted" and "sent as null" into the same update
 * would make it impossible to correct a field back to unknown.
 */
router.patch("/ot-fleets/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid fleet ID" });
    return;
  }

  const parsed = UpdateOtFleetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // `zod.coerce.date()` has already turned a supplied `nextProcurementDate`
  // string into a `Date`, so every field here is copied through as-is —
  // no `new Date(...)` re-wrap, which would not typecheck against a `Date`
  // input in the first place (see the same note in POST /ot-fleets).
  const data = parsed.data as Record<string, unknown>;
  const updates: Record<string, unknown> = {};
  for (const key of [
    "name",
    "vendor",
    "model",
    "deviceCount",
    "site",
    "owner",
    "cryptoInUse",
    "refreshCycleYears",
    "nextProcurementDate",
    "cryptoAlgorithm",
    "cryptoKeySize",
  ]) {
    if (!(key in data)) continue;
    updates[key] = data[key];
  }

  if (Object.keys(updates).length > 0) updates.updatedAt = new Date();

  const ctx = orgContextFor(req);
  const fleet = await withOrg(ctx, async (tx) => {
    if (Object.keys(updates).length === 0) {
      const [existing] = await tx.select().from(otFleetsTable).where(eq(otFleetsTable.id, id));
      return existing;
    }
    const [updated] = await tx
      .update(otFleetsTable)
      .set(updates)
      .where(eq(otFleetsTable.id, id))
      .returning();
    // Only when something actually changed. An edit that clears
    // `cryptoAlgorithm` retires the asset it produced, which is the case this
    // re-derivation exists for.
    if (updated) await reingestRegister(tx, ctx.organizationId);
    return updated;
  });

  if (!fleet) {
    res.status(404).json({ error: "Fleet not found" });
    return;
  }

  res.json(fleetPayload(fleet));
});

router.delete("/ot-fleets/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid fleet ID" });
    return;
  }

  const deleteCtx = orgContextFor(req);
  await withOrg(deleteCtx, async (tx) => {
    await tx.delete(otFleetsTable).where(eq(otFleetsTable.id, id));
    // The deleted fleet's location is no longer in the register, so the
    // prefix-scoped reobservation marks its asset `gone` rather than deleting
    // it — the row stays in history, as A1 requires.
    await reingestRegister(tx, deleteCtx.organizationId);
  });
  res.sendStatus(204);
});

export default router;
