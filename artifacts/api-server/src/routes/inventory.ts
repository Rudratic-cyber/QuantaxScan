import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { ne } from "drizzle-orm";
import { withOrg, assetsTable, projectsTable, projectRepoId } from "@workspace/db";
import { buildCbom, type CryptoAssetInput, type SoftwareComponentInput } from "@workspace/cbom";
import { orgContextFor } from "../lib/principal";

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

export default router;
