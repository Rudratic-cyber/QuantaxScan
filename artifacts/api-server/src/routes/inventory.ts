import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { ne, inArray } from "drizzle-orm";
import {
  withOrg,
  assetsTable,
  projectsTable,
  collectionRunsTable,
  observationsTable,
  projectRepoId,
} from "@workspace/db";
import { resolveSecrecyLifetime } from "@workspace/db/classification";
import { buildCbom, type CryptoAssetInput, type SoftwareComponentInput } from "@workspace/cbom";
import { orgContextFor } from "../lib/principal";
import { summarisePostureTimeline } from "../lib/posture-timeline";
import { summariseProjectCoverage } from "../lib/coverage";
import { summariseReadiness, type ReadinessAssetRow } from "../lib/readiness";
import { summariseInventoryAssets } from "../lib/inventory-assets";

const router: IRouter = Router();

/**
 * A5 — `GET /api/inventory/cbom`, the M1 exit criterion
 * (docs/Claude/02-roadmap.md): "returns a CycloneDX 1.7 document that passes
 * schema validation".
 *
 * The document is built by `@workspace/cbom`, which is pure and knows nothing
 * about the database; this route's whole job is the two reads and the
 * asset → project attribution. Schema conformance is proven in that package's
 * own suite against the vendored official schema, and again here against the
 * real HTTP response.
 *
 * **Not public.** A CBOM is a complete map of an organisation's cryptographic
 * weaknesses — the single most useful document an attacker could ask for — so
 * it is absent from `PUBLIC_ROUTES` (docs/Claude/13-auth-and-tenancy.md §6.2)
 * and reads through `withOrg` like every other scoped route. No
 * `where organization_id` appears below because the policies supply it.
 */

/** Official CycloneDX media type. A consumer content-negotiating on this must get it. */
const CBOM_MEDIA_TYPE = "application/vnd.cyclonedx+json; version=1.7";

router.get("/inventory/cbom", async (req, res): Promise<void> => {
  const { assets, projects } = await withOrg(orgContextFor(req), async (tx) => {
    const [assetRows, projectRows] = await Promise.all([
      // `gone` means "this run looked at the location and the crypto was no
      // longer there". A current-state inventory handed to an auditor must not
      // list it as present; the row stays in the database for drift history
      // (D4), which reads the table, not this export.
      tx.select().from(assetsTable).where(ne(assetsTable.status, "gone")).orderBy(assetsTable.fingerprint),
      tx.select().from(projectsTable).orderBy(projectsTable.id),
    ]);
    return { assets: assetRows, projects: projectRows };
  });

  // A project is the only software component this product currently knows
  // about. `projectRepoId()` owns the `project:<id>` convention on both sides:
  // it is the prefix `asset.location` was built from at ingest, and the
  // `bom-ref` here, so the join below is the same string on both ends rather
  // than a second spelling of the format.
  const softwareComponents: SoftwareComponentInput[] = projects.map((project) => ({
    bomRef: projectRepoId(project.id),
    name: project.name,
    type: "application",
  }));

  const containers = softwareComponents.map((component) => ({ bomRef: component.bomRef, prefix: `${component.bomRef}:` }));
  const cryptoAssets: CryptoAssetInput[] = assets.map((asset) => ({
    fingerprint: asset.fingerprint,
    surface: asset.surface,
    algorithm: asset.algorithm,
    // Straight through. Null here is the collector's determination that the
    // size is unknown, and the exporter is required to preserve that rather
    // than substitute a number — docs/Claude/09-open-gaps.md G-05.
    keySize: asset.keySize,
    location: asset.location,
    status: asset.status,
    firstSeen: asset.firstSeen,
    lastSeen: asset.lastSeen,
    containedIn: containers.find((c) => asset.location.startsWith(c.prefix))?.bomRef ?? null,
  }));

  const document = buildCbom(
    { softwareComponents, cryptoAssets },
    {
      serialNumber: `urn:uuid:${randomUUID()}`,
      timestamp: new Date(),
      // Optional and currently unwired: nothing in .env.example, the
      // Dockerfiles or CI sets this, so `metadata.tools` carries the tool name
      // with no version until a release process exists to stamp one. Left as a
      // read rather than a hardcoded "0.0.0", which would be a lie in an
      // auditor-facing document.
      toolVersion: process.env.QUANTAXSCAN_VERSION,
    },
  );

  res.type(CBOM_MEDIA_TYPE).json(document);
});

/**
 * D7 — `GET /api/inventory/timeline`, the estate posture timeline.
 * docs/Claude/03-features.md §D7, docs/Claude/06-cisa-dashboard.md §"Row 5".
 *
 * Estate-wide by design, and therefore unlike D3's per-project coverage meter:
 * D3's own note says the estate-wide roll-up "belongs with D1, which needs an
 * asset model that spans projects". `assets` is that model — it is organisation-
 * scoped with no foreign key to a project — so this route reads the whole
 * organisation and attributes assets to projects through the `project:<id>:`
 * location prefix, the same convention `DELETE /projects/:id` reconciles on.
 *
 * Three notes on the reads below:
 *
 *  - **Every asset, including `gone` ones.** The CBOM export above filters
 *    `gone` out because it is a statement about the present. This is a
 *    statement about the past, and an inventory that forgets what it removed
 *    cannot show that anything was ever fixed.
 *  - **Every collection run, whatever its status.** The summariser needs the
 *    failed ones in order to say how many attempts are *not* being counted as
 *    examinations — the same rule `coverage.ts` applies.
 *  - **No `where organization_id`**, here as everywhere: the row-level-security
 *    policies supply it. Note that `collection_runs.target` and the
 *    `assets.location` prefix are attacker-controllable strings shared across
 *    tenants, so the policy — not a where clause — is what keeps another
 *    organisation's `project:7` out of this organisation's timeline.
 */
router.get("/inventory/timeline", async (req, res): Promise<void> => {
  // One clock read for the whole response. Two would let the observed half and
  // the projected half disagree about where "now" is, which is precisely the
  // boundary this payload exists to make unambiguous.
  const now = new Date();

  const timeline = await withOrg(orgContextFor(req), async (tx) => {
    const [assets, projects, runs] = await Promise.all([
      tx
        .select({
          id: assetsTable.id,
          surface: assetsTable.surface,
          algorithm: assetsTable.algorithm,
          location: assetsTable.location,
          status: assetsTable.status,
          firstSeen: assetsTable.firstSeen,
          lastSeen: assetsTable.lastSeen,
          dataClassification: assetsTable.dataClassification,
          secrecyLifetimeYears: assetsTable.secrecyLifetimeYears,
          effortHours: assetsTable.effortHours,
        })
        .from(assetsTable)
        .orderBy(assetsTable.firstSeen),
      tx
        .select({
          id: projectsTable.id,
          name: projectsTable.name,
          dataClassification: projectsTable.dataClassification,
          secrecyLifetimeYears: projectsTable.secrecyLifetimeYears,
        })
        .from(projectsTable),
      tx
        .select({
          id: collectionRunsTable.id,
          surface: collectionRunsTable.surface,
          status: collectionRunsTable.status,
          target: collectionRunsTable.target,
          startedAt: collectionRunsTable.startedAt,
          completedAt: collectionRunsTable.completedAt,
        })
        .from(collectionRunsTable),
    ]);

    // The aggregation itself is pure and lives in `lib/posture-timeline.ts`,
    // where every honesty rule in it is unit-tested without a database.
    return summarisePostureTimeline({ runs, assets, projects, now });
  });

  res.json(timeline);
});

/**
 * D1 — `GET /api/inventory/readiness`, the CISA quantum-readiness posture
 * tracker. docs/Claude/03-features.md §D1, docs/Claude/06-cisa-dashboard.md
 * §"Row 1" and §"Row 3".
 *
 * Bundles the readiness sections with the estate-wide coverage meter in one
 * payload rather than two, because Row 1's "cryptographic inventory" section
 * is *defined* as a function of the coverage numbers — a client that fetched
 * them separately could show a header that disagrees with the panel under it.
 *
 * The coverage block is genuinely estate-wide, not `/api/projects/:id/coverage`
 * called once per project and merged: that would double-count nothing (each
 * project's assets are disjoint) but would silently drop every asset with no
 * project at all — `assets` has no foreign key to `projects` (see
 * `posture-timeline.ts`), and TLS/certificate/KMS surfaces are exactly the
 * surfaces with no project prefix to attribute to. `summariseProjectCoverage`
 * is already project-agnostic (its output carries no `projectId`), so this
 * reuses the tested arithmetic verbatim over every run/asset/observation in
 * the organisation, with no `like location` filter at all.
 */
router.get("/inventory/readiness", async (req, res): Promise<void> => {
  const now = new Date();

  const payload = await withOrg(orgContextFor(req), async (tx) => {
    const [runs, assets, projects] = await Promise.all([
      tx
        .select({
          surface: collectionRunsTable.surface,
          status: collectionRunsTable.status,
          startedAt: collectionRunsTable.startedAt,
          completedAt: collectionRunsTable.completedAt,
        })
        .from(collectionRunsTable),
      tx
        .select({
          id: assetsTable.id,
          surface: assetsTable.surface,
          status: assetsTable.status,
          location: assetsTable.location,
          dataClassification: assetsTable.dataClassification,
          secrecyLifetimeYears: assetsTable.secrecyLifetimeYears,
        })
        .from(assetsTable),
      tx
        .select({
          id: projectsTable.id,
          dataClassification: projectsTable.dataClassification,
          secrecyLifetimeYears: projectsTable.secrecyLifetimeYears,
        })
        .from(projectsTable),
    ]);

    const assetIds = assets.map((a) => a.id);
    const observations = assetIds.length === 0
      ? []
      : await tx
          .select({
            id: observationsTable.id,
            assetId: observationsTable.assetId,
            confidence: observationsTable.confidence,
            observedAt: observationsTable.observedAt,
          })
          .from(observationsTable)
          .where(inArray(observationsTable.assetId, assetIds));

    const coverage = summariseProjectCoverage({ runs, assets, observations });

    const projectById = new Map(projects.map((p) => [p.id, p] as const));
    const projectIdPattern = /^project:(\d+):/;
    const presentAssets: ReadinessAssetRow[] = assets
      .filter((a) => a.status !== "gone")
      .map((a) => {
        const match = projectIdPattern.exec(a.location);
        const project = match ? projectById.get(Number(match[1])) : undefined;
        const lifetime = resolveSecrecyLifetime({
          assetClassification: a.dataClassification,
          assetSecrecyLifetimeYears: a.secrecyLifetimeYears,
          projectClassification: project?.dataClassification ?? null,
          projectSecrecyLifetimeYears: project?.secrecyLifetimeYears ?? null,
        });
        return { status: a.status, classificationSource: lifetime.classificationSource };
      });

    const dependencyAssetCount = assets.filter((a) => a.surface === "dependency" && a.status !== "gone").length;

    const readiness = summariseReadiness({ coverage, presentAssets, dependencyAssetCount }, now);
    return { ...readiness, coverage };
  });

  res.json(payload);
});

/**
 * D1 — `GET /api/inventory/assets`, the estate inventory table (Row 4) and
 * Row 2/5 drill-down. docs/Claude/06-cisa-dashboard.md §"Row 4".
 *
 * Present assets only (`status !== "gone"`), same reasoning as the CBOM route:
 * a current-state inventory must not list crypto a later run proved absent.
 * `?surface=` filters server-side (the spec's cert-expiry panel reads this
 * with `surface=certificate`); every other client-facing filter — algorithm,
 * status, owner, confidence — is small enough at this stage to filter
 * client-side over the one response, matching how the rest of this UI already
 * treats a project's findings.
 *
 * `statusCounts` covers **every** asset regardless of status, gone included,
 * so Row 6 (drift) can report how many were remediated/waived/removed since
 * the last collection without those rows ever appearing in `assets` as if
 * still present.
 */
router.get("/inventory/assets", async (req, res): Promise<void> => {
  const now = new Date();
  const surfaceFilter = typeof req.query.surface === "string" ? req.query.surface : undefined;

  const payload = await withOrg(orgContextFor(req), async (tx) => {
    const [allAssets, projects] = await Promise.all([
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
        .from(assetsTable),
      tx
        .select({
          id: projectsTable.id,
          dataClassification: projectsTable.dataClassification,
          secrecyLifetimeYears: projectsTable.secrecyLifetimeYears,
        })
        .from(projectsTable),
    ]);

    const allAssetsStatus = allAssets.map((a) => a.status);
    const present = allAssets.filter((a) => a.status !== "gone" && (surfaceFilter === undefined || a.surface === surfaceFilter));
    const presentIds = present.map((a) => a.id);

    const observations = presentIds.length === 0
      ? []
      : await tx
          .select({
            id: observationsTable.id,
            assetId: observationsTable.assetId,
            confidence: observationsTable.confidence,
            observedAt: observationsTable.observedAt,
          })
          .from(observationsTable)
          .where(inArray(observationsTable.assetId, presentIds));

    return summariseInventoryAssets({ assets: present, allAssetsStatus, projects, observations, now });
  });

  res.json(payload);
});

export default router;
