import { Router, type IRouter, type Request, type Response } from "express";
import { inArray } from "drizzle-orm";
import {
  withOrg,
  assetsTable,
  projectsTable,
  collectionRunsTable,
  observationsTable,
  type ScopedTx,
} from "@workspace/db";
import { orgContextFor } from "../lib/principal";
import { logger } from "../lib/logger";
import { summariseProjectCoverage } from "../lib/coverage";
import { summariseInventoryAssets } from "../lib/inventory-assets";
import { contentDigest, type ReportInput } from "../lib/report-common";
import { summariseBoardPack, type BoardPack } from "../lib/board-pack";
import { summariseRegulatorSubmission, type RegulatorSubmission } from "../lib/regulator-submission";
import { renderBoardPackHtml, renderRegulatorSubmissionHtml } from "../lib/report-html";
import { renderHtmlToPdf, PdfUnavailableError } from "../lib/pdf";

/**
 * E1 and E2 — the board pack and the regulator submission, generated from the
 * real inventory. docs/Claude/07-reports.md.
 *
 * **Why `/report-packs` and not `/reports/board`.** `GET /reports/:id` is a
 * public share link, and `PUBLIC_ROUTES` matches it with `/^\/reports\/[^/]+$/`.
 * A route at `/reports/board` would be matched by that regex and served to
 * anonymous callers — a complete map of an organisation's cryptographic
 * weaknesses, handed out without a credential. The prefix is different so that
 * cannot happen by accident, for the same reason `GET /inventory/cbom` is
 * deliberately absent from the public allowlist.
 *
 * Three representations per pack, one document: `<pack>` is the JSON the
 * document was built from, `<pack>.html` is the rendering, `<pack>.pdf` is that
 * same HTML printed. There is one renderer, per doc 07 §Rendering.
 *
 * **One scope, one clock.** Both packs are built from a single `withOrg`
 * transaction and a single `now`, so the exposure half and the deadline half of
 * a document can never land on opposite sides of a deadline. No
 * `where organization_id` appears below: the row-level-security policies supply
 * it, and `assets.location`/`collection_runs.target` are attacker-controllable
 * strings shared across tenants, so a where clause would be the wrong control
 * even if it were present.
 */

const router: IRouter = Router();

/**
 * The blended hourly rate the cost figure is quoted at, and its currency.
 * Unset by default, in which case `report-common.ts` uses the product's
 * documented consultant rate and marks the figure assumed. A currency without a
 * rate is ignored there rather than relabelling a USD number.
 */
function configuredRate(): { hourlyRate?: number; currency?: string } {
  const raw = process.env.QUANTAXSCAN_BLENDED_HOURLY_RATE;
  if (raw === undefined) return {};
  const hourlyRate = Number(raw);
  if (!Number.isFinite(hourlyRate) || hourlyRate <= 0) {
    logger.warn({ raw }, "QUANTAXSCAN_BLENDED_HOURLY_RATE is not a positive number; falling back to the documented default rate");
    return {};
  }
  return { hourlyRate, currency: process.env.QUANTAXSCAN_REPORT_CURRENCY ?? "USD" };
}

/**
 * The one read. Everything both packs say comes from here, through the same
 * pure summarisers the dashboard reads — a pack assembled from a second set of
 * queries could disagree with the screen it is supposed to summarise.
 */
async function readInventory(tx: ScopedTx, now: Date): Promise<ReportInput> {
  const [allAssets, projects, runs] = await Promise.all([
    tx
      .select({
        id: assetsTable.id,
        fingerprint: assetsTable.fingerprint,
        surface: assetsTable.surface,
        algorithm: assetsTable.algorithm,
        keySize: assetsTable.keySize,
        location: assetsTable.location,
        status: assetsTable.status,
        firstSeen: assetsTable.firstSeen,
        lastSeen: assetsTable.lastSeen,
        ownerId: assetsTable.ownerId,
        dataClassification: assetsTable.dataClassification,
        secrecyLifetimeYears: assetsTable.secrecyLifetimeYears,
        effortHours: assetsTable.effortHours,
      })
      .from(assetsTable)
      .orderBy(assetsTable.fingerprint),
    tx
      .select({
        id: projectsTable.id,
        name: projectsTable.name,
        dataClassification: projectsTable.dataClassification,
        secrecyLifetimeYears: projectsTable.secrecyLifetimeYears,
      })
      .from(projectsTable)
      .orderBy(projectsTable.id),
    tx
      .select({
        id: collectionRunsTable.id,
        collector: collectionRunsTable.collector,
        collectorVersion: collectionRunsTable.collectorVersion,
        surface: collectionRunsTable.surface,
        status: collectionRunsTable.status,
        target: collectionRunsTable.target,
        observationCount: collectionRunsTable.observationCount,
        startedAt: collectionRunsTable.startedAt,
        completedAt: collectionRunsTable.completedAt,
      })
      .from(collectionRunsTable),
  ]);

  // Present assets only. `gone` means a later run looked at the location and
  // the cryptography was no longer there — a current-state document must not
  // list it, and `statusCounts` below keeps the exclusion checkable.
  const present = allAssets.filter((a) => a.status !== "gone");
  const presentIds = present.map((a) => a.id);

  const observations =
    presentIds.length === 0
      ? []
      : await tx
          .select({
            id: observationsTable.id,
            assetId: observationsTable.assetId,
            collectionRunId: observationsTable.collectionRunId,
            collector: observationsTable.collector,
            collectorVersion: observationsTable.collectorVersion,
            confidence: observationsTable.confidence,
            discoveryModality: observationsTable.discoveryModality,
            observedAt: observationsTable.observedAt,
          })
          .from(observationsTable)
          .where(inArray(observationsTable.assetId, presentIds));

  const enriched = summariseInventoryAssets({
    assets: present,
    allAssetsStatus: allAssets.map((a) => a.status),
    projects,
    observations,
    now,
  });

  const coverage = summariseProjectCoverage({
    runs,
    assets: present.map((a) => ({ id: a.id, surface: a.surface, status: a.status })),
    observations,
  });

  return {
    now,
    assets: enriched.assets,
    statusCounts: enriched.statusCounts,
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    runs,
    observations,
    coverage,
    productVersion: process.env.QUANTAXSCAN_VERSION ?? null,
    ...configuredRate(),
  };
}

async function buildBoardPack(req: Request): Promise<BoardPack> {
  const now = new Date();
  const input = await withOrg(orgContextFor(req), (tx) => readInventory(tx, now));
  return summariseBoardPack(input);
}

async function buildRegulatorSubmission(req: Request): Promise<RegulatorSubmission> {
  const now = new Date();
  const input = await withOrg(orgContextFor(req), (tx) => readInventory(tx, now));
  const submission = summariseRegulatorSubmission(input);
  // The digest covers the document with an empty digest field, which is the
  // form a recipient can recompute from what they were given.
  return { ...submission, integrity: { ...submission.integrity, digest: contentDigest(submission) } };
}

function filenameFor(kind: string, extension: string, at: string): string {
  return `quantaxscan-${kind}-${at.slice(0, 10)}.${extension}`;
}

async function servePdf(res: Response, html: string, filename: string): Promise<void> {
  try {
    const pdf = await renderHtmlToPdf(html);
    res.type("application/pdf").setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdf);
  } catch (err) {
    if (err instanceof PdfUnavailableError) {
      // 503, not 500: the document generated fine and the same content is
      // available as HTML. Saying "internal error" would send a caller looking
      // for a defect in their inventory.
      logger.warn({ reason: err.reason }, "PDF rendering unavailable");
      res.status(503).json({ error: err.message });
      return;
    }
    throw err;
  }
}

// ── E1 — board pack ──────────────────────────────────────────────────────────

router.get("/report-packs/board", async (req: Request, res: Response): Promise<void> => {
  res.json(await buildBoardPack(req));
});

router.get("/report-packs/board.html", async (req: Request, res: Response): Promise<void> => {
  const pack = await buildBoardPack(req);
  res.type("text/html; charset=utf-8").send(renderBoardPackHtml(pack));
});

router.get("/report-packs/board.pdf", async (req: Request, res: Response): Promise<void> => {
  const pack = await buildBoardPack(req);
  await servePdf(res, renderBoardPackHtml(pack), filenameFor("board-pack", "pdf", pack.header.generatedAt));
});

// ── E2 — regulator submission ────────────────────────────────────────────────

router.get("/report-packs/regulator", async (req: Request, res: Response): Promise<void> => {
  res.json(await buildRegulatorSubmission(req));
});

router.get("/report-packs/regulator.html", async (req: Request, res: Response): Promise<void> => {
  const submission = await buildRegulatorSubmission(req);
  res.type("text/html; charset=utf-8").send(renderRegulatorSubmissionHtml(submission));
});

router.get("/report-packs/regulator.pdf", async (req: Request, res: Response): Promise<void> => {
  const submission = await buildRegulatorSubmission(req);
  await servePdf(
    res,
    renderRegulatorSubmissionHtml(submission),
    filenameFor("inventory-submission", "pdf", submission.header.generatedAt),
  );
});

export default router;
