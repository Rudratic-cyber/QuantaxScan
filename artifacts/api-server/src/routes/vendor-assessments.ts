import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { withOrg, vendorAssessmentsTable, type VendorAssessment } from "@workspace/db";
import { CreateVendorAssessmentBody, UpdateVendorAssessmentBody } from "@workspace/api-zod";
import { assessVendorPosture } from "../lib/vendor-posture";
import { orgContextFor } from "../lib/principal";

/**
 * B9 — the vendor / third-party register. docs/Claude/03-features.md §B9.
 *
 * A *form*, not a scanner, and the same shape as `routes/ot-fleets.ts`: every
 * handler runs inside `withOrg`, there is no collector, no fingerprint and no
 * `collection_runs` row anywhere in this file. No route here accepts a parent
 * id either, so there is no foreign-key-under-RLS confirmation to make — the
 * row is stamped with the caller's organisation and nothing else.
 *
 * `assessmentPayload()` is the one thing every response adds on top of the raw
 * row, and it is the reason this lane exists: `posture` carries the
 * `manual_attestation` modality, a confidence below every collector's (null
 * when the vendor has said nothing at all), the Q-Day verdicts against the
 * date the vendor *claims*, and a four-state contract-clause reading in which
 * "nobody read the contract" is not "there is no clause". All of it is derived
 * on read and never stored — see `lib/vendor-posture.ts`.
 */

const router: IRouter = Router();

function assessmentPayload(row: VendorAssessment) {
  return {
    ...row,
    posture: assessVendorPosture({
      respondedAt: row.respondedAt,
      pqcRoadmapStatus: row.pqcRoadmapStatus,
      statedPqcReadyDate: row.statedPqcReadyDate,
      cryptoDisclosed: row.cryptoDisclosed,
      contractPqcClause: row.contractPqcClause,
      contractRenewalDate: row.contractRenewalDate,
    }),
  };
}

function parseId(raw: unknown): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = parseInt(String(value), 10);
  return Number.isInteger(id) ? id : null;
}

/** Every editable column, in one place — both the insert and the patch read it. */
const EDITABLE_FIELDS = [
  "vendorName",
  "productOrService",
  "internalOwner",
  "questionnaireSentAt",
  "respondedAt",
  "pqcRoadmapStatus",
  "statedPqcReadyDate",
  "cryptoDisclosed",
  "contractPqcClause",
  "contractRenewalDate",
  "attestationEvidence",
  "notes",
] as const;

router.get("/vendor-assessments", async (req, res): Promise<void> => {
  const assessments = await withOrg(orgContextFor(req), (tx) =>
    tx.select().from(vendorAssessmentsTable).orderBy(desc(vendorAssessmentsTable.createdAt)),
  );
  res.json(assessments.map(assessmentPayload));
});

router.post("/vendor-assessments", async (req, res): Promise<void> => {
  const parsed = CreateVendorAssessmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const {
    vendorName,
    productOrService,
    internalOwner,
    questionnaireSentAt,
    respondedAt,
    pqcRoadmapStatus,
    statedPqcReadyDate,
    cryptoDisclosed,
    contractPqcClause,
    contractRenewalDate,
    attestationEvidence,
    notes,
  } = parsed.data;
  const ctx = orgContextFor(req);

  const [assessment] = await withOrg(ctx, (tx) =>
    tx
      .insert(vendorAssessmentsTable)
      .values({
        organizationId: ctx.organizationId,
        vendorName,
        productOrService,
        internalOwner,
        // The date fields arrive as `Date` already — the generated zod schemas
        // use `zod.coerce.date()`, so re-wrapping in `new Date(...)` would not
        // even typecheck (its single-argument overloads take `number | string`).
        questionnaireSentAt,
        respondedAt,
        pqcRoadmapStatus,
        statedPqcReadyDate,
        cryptoDisclosed,
        contractPqcClause,
        contractRenewalDate,
        attestationEvidence,
        notes,
      })
      .returning(),
  );

  res.status(201).json(assessmentPayload(assessment));
});

router.get("/vendor-assessments/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid vendor assessment ID" });
    return;
  }

  const [assessment] = await withOrg(orgContextFor(req), (tx) =>
    tx.select().from(vendorAssessmentsTable).where(eq(vendorAssessmentsTable.id, id)),
  );

  // Another organisation's assessment is indistinguishable from one that does
  // not exist, matching GET /projects/:id and GET /ot-fleets/:id — a 403 would
  // confirm it is real, and which suppliers a company assesses is itself
  // commercially sensitive.
  if (!assessment) {
    res.status(404).json({ error: "Vendor assessment not found" });
    return;
  }

  res.json(assessmentPayload(assessment));
});

/**
 * PATCH, not PUT, and for a sharper reason than B8's: this register is
 * *expected* to start almost entirely null and be filled in over months as a
 * questionnaire comes back. Presence in `parsed.data` — not truthiness —
 * decides what changes: `key in parsed.data` is false when the caller omitted
 * the field (leave the stored value, including a stored null, exactly as it
 * was) and true when the caller sent `null` explicitly (clear it back to "not
 * supplied"). Zod drops keys the input never mentioned from a `.safeParse()`
 * result on an object of optional fields, which is what makes the distinction
 * available at all.
 *
 * Being able to set a field *back* to null matters more here than anywhere
 * else in the product: withdrawing a `contractPqcClause: 'absent'` that turned
 * out to be a misreading has to leave "nobody has checked", not the opposite
 * finding.
 */
router.patch("/vendor-assessments/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid vendor assessment ID" });
    return;
  }

  const parsed = UpdateVendorAssessmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const data = parsed.data as Record<string, unknown>;
  const updates: Record<string, unknown> = {};
  for (const key of EDITABLE_FIELDS) {
    if (!(key in data)) continue;
    updates[key] = data[key];
  }

  if (Object.keys(updates).length > 0) updates.updatedAt = new Date();

  const assessment = await withOrg(orgContextFor(req), async (tx) => {
    if (Object.keys(updates).length === 0) {
      const [existing] = await tx.select().from(vendorAssessmentsTable).where(eq(vendorAssessmentsTable.id, id));
      return existing;
    }
    const [updated] = await tx
      .update(vendorAssessmentsTable)
      .set(updates)
      .where(eq(vendorAssessmentsTable.id, id))
      .returning();
    return updated;
  });

  if (!assessment) {
    res.status(404).json({ error: "Vendor assessment not found" });
    return;
  }

  res.json(assessmentPayload(assessment));
});

router.delete("/vendor-assessments/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid vendor assessment ID" });
    return;
  }

  await withOrg(orgContextFor(req), (tx) =>
    tx.delete(vendorAssessmentsTable).where(eq(vendorAssessmentsTable.id, id)),
  );
  res.sendStatus(204);
});

export default router;
