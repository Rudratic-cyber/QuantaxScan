import { Router, type IRouter, type Request, type Response } from "express";
import { db, sharedReportsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function generateId(len = 10): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < len; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

router.post("/reports", async (req: Request, res: Response): Promise<void> => {
  const { owner, repo, repoUrl, data } = req.body as {
    owner?: string; repo?: string; repoUrl?: string; data?: unknown;
  };
  if (!owner || !repo || !repoUrl || !data) {
    res.status(400).json({ error: "owner, repo, repoUrl, and data are required" });
    return;
  }
  try {
    const id = generateId(10);
    await db.insert(sharedReportsTable).values({ id, owner, repo, repoUrl, data });
    logger.info({ id, owner, repo }, "Shared report created");
    res.json({ id, shareUrl: `/report/${id}` });
  } catch (err) {
    logger.error({ err }, "Failed to save shared report");
    res.status(500).json({ error: "Failed to save report" });
  }
});

router.get("/reports/:id", async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    const [row] = await db.select().from(sharedReportsTable).where(eq(sharedReportsTable.id, id));
    if (!row) { res.status(404).json({ error: "Report not found" }); return; }
    res.json(row);
  } catch (err) {
    logger.error({ err }, "Failed to fetch shared report");
    res.status(500).json({ error: "Failed to fetch report" });
  }
});

export default router;
