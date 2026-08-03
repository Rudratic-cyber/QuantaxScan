import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { withOrg, withPublicShare, sharedReportsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { orgContextFor } from "../lib/principal";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// GET /api/reports/:id is public by design (share links), so the ID is the only
// access control on it and must be unguessable. The previous Math.random()
// implementation was enumerable once V8's PRNG state was recovered — S2.
function generateId(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * How long a newly created share link stays reachable.
 *
 * `expires_at` is `NOT NULL` — a share link with no expiry is the S2 finding,
 * and closing it is the point of the column. But nothing yet lets a person see
 * or extend an expiry, so a short window would silently break links that work
 * today. A year is the honest interim: strictly stronger than the current
 * "never expires", and long enough that no existing use is disrupted before
 * the sharing interface exists to tighten it.
 *
 * Links created before this migration get 30 days instead, in `apply-tenancy`
 * — they carry weak `Math.random()` identifiers and are enumerable, so a
 * shorter bound is warranted there.
 */
const SHARE_LINK_TTL_DAYS = Number(process.env.SHARE_LINK_TTL_DAYS ?? 365);

router.post("/reports", async (req: Request, res: Response): Promise<void> => {
  // `owner` here is the GITHUB repository owner, not a user — see the note on
  // sharedReportsTable. The person is `created_by_user_id`, which stays null
  // for the shared API key because there is no person behind it.
  const { owner, repo, repoUrl, data } = req.body as {
    owner?: string; repo?: string; repoUrl?: string; data?: unknown;
  };
  if (!owner || !repo || !repoUrl || !data) {
    res.status(400).json({ error: "owner, repo, repoUrl, and data are required" });
    return;
  }

  const ctx = orgContextFor(req);

  try {
    const id = generateId();
    const expiresAt = new Date(Date.now() + SHARE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);

    // `visibility: "public"` is explicit, not inherited from the column
    // default of `'private'`. Every report created through this route is
    // shared by link today, and a private row is invisible through
    // `withPublicShare` below — defaulting it here would break the share link
    // the caller was just handed. Opt-in privacy arrives with the interface
    // that can express it.
    await withOrg(ctx, (tx) =>
      tx.insert(sharedReportsTable).values({
        id,
        organizationId: ctx.organizationId,
        owner,
        repo,
        repoUrl,
        data,
        visibility: "public",
        expiresAt,
      }),
    );
    logger.info({ id, owner, repo, expiresAt }, "Shared report created");
    res.json({ id, shareUrl: `/report/${id}` });
  } catch (err) {
    logger.error({ err }, "Failed to save shared report");
    res.status(500).json({ error: "Failed to save report" });
  }
});

/**
 * Public by design, and now conditionally so. The rule —
 * `visibility = 'public' AND revoked_at IS NULL AND expires_at > now()` —
 * lives in the `shared_reports` policy rather than in a `where` clause here,
 * so this anonymous route goes THROUGH the isolation choke point rather than
 * around it. A revoked or expired link is simply not visible to the query.
 */
router.get("/reports/:id", async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    const [row] = await withPublicShare((tx) =>
      tx.select().from(sharedReportsTable).where(eq(sharedReportsTable.id, id)),
    );
    if (!row) { res.status(404).json({ error: "Report not found" }); return; }
    res.json(row);
  } catch (err) {
    logger.error({ err }, "Failed to fetch shared report");
    res.status(500).json({ error: "Failed to fetch report" });
  }
});

export default router;
