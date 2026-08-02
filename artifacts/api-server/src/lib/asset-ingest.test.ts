import { describe, expect, it, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { assetsTable, observationsTable, collectionRunsTable } from "@workspace/db/schema";
import { createTestDb } from "@workspace/db/test-support";
import { ingestSourceObservations, DEFAULT_ORGANIZATION_ID } from "./asset-ingest";

describe("ingestSourceObservations — the A1/A2 dual-write path", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("creates one asset per distinct (repo, path, algorithm, symbol) and one observation per detection", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const code = ["from Crypto.PublicKey import RSA", "key = RSA.generate(2048)", "h = hashlib.md5(x)"].join("\n");
    const result = await ingestSourceObservations(db, {
      repo: "project:1",
      files: [{ path: "keys.py", content: code, language: "python" }],
    });

    // Three lines match (two RSA, one MD5), but the two RSA lines share the
    // same (repo, path, algorithm, symbol) fingerprint — one asset, two
    // observations — while MD5 is a distinct asset. Three observations total.
    expect(result.observationsCreated).toBe(3);
    expect(result.assetsCreated).toBe(2);
    const assets = await db.select().from(assetsTable).where(eq(assetsTable.organizationId, DEFAULT_ORGANIZATION_ID));
    const rsaAssets = assets.filter((a) => a.algorithm === "RSA");
    expect(rsaAssets).toHaveLength(1);
    expect(rsaAssets[0].keySize).toBe(2048); // the later (last-processed) RSA line has the literal key size

    const observationsForRsa = await db
      .select()
      .from(observationsTable)
      .where(eq(observationsTable.assetId, rsaAssets[0].id));
    expect(observationsForRsa).toHaveLength(2);
  });

  it("re-ingesting identical content does not create duplicate assets, only updates lastSeen (A1 acceptance: re-scanning an unchanged repo produces zero new assets)", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const files = [{ path: "keys.py", content: "key = RSA.generate(2048)", language: "python" }];
    const first = await ingestSourceObservations(db, { repo: "project:1", files });
    expect(first.assetsCreated).toBe(1);

    const second = await ingestSourceObservations(db, { repo: "project:1", files });
    expect(second.assetsCreated).toBe(0);
    expect(second.assetsUpdated).toBe(1);

    const assets = await db.select().from(assetsTable).where(eq(assetsTable.organizationId, DEFAULT_ORGANIZATION_ID));
    expect(assets).toHaveLength(1);
  });

  it("keySize stays undetermined (null) end-to-end when the collector cannot determine it, and never regresses a determined value silently", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    // Same fingerprint (repo/path/algorithm/symbol) but the line content
    // changes from a literal modulus to a variable — the new asset state
    // correctly reflects "no longer determinable from this line", it does
    // not retain the stale 2048.
    await ingestSourceObservations(db, {
      repo: "project:1",
      files: [{ path: "keys.py", content: "key = RSA.generate(2048)", language: "python" }],
    });
    await ingestSourceObservations(db, {
      repo: "project:1",
      files: [{ path: "keys.py", content: "key = RSA.generate(bits)", language: "python" }],
    });

    const [asset] = await db
      .select()
      .from(assetsTable)
      .where(and(eq(assetsTable.organizationId, DEFAULT_ORGANIZATION_ID), eq(assetsTable.algorithm, "RSA")));
    expect(asset.keySize).toBeNull();
  });

  it("marks an asset gone when a rescan of its file no longer finds it, and keeps it in history (A1 acceptance)", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const firstScan = ["key = RSA.generate(2048)", "h = hashlib.md5(x)"].join("\n");
    const first = await ingestSourceObservations(db, {
      repo: "project:1",
      files: [{ path: "keys.py", content: firstScan, language: "python" }],
    });
    expect(first.assetsCreated).toBe(2);
    expect(first.assetsMarkedGone).toBe(0);

    // The RSA line is removed; MD5 remains.
    const secondScan = "h = hashlib.md5(x)";
    const second = await ingestSourceObservations(db, {
      repo: "project:1",
      files: [{ path: "keys.py", content: secondScan, language: "python" }],
    });
    expect(second.assetsCreated).toBe(0);
    expect(second.assetsMarkedGone).toBe(1);

    const assets = await db.select().from(assetsTable).where(eq(assetsTable.organizationId, DEFAULT_ORGANIZATION_ID));
    // Still 2 rows — the RSA asset is not deleted, only its status changed.
    expect(assets).toHaveLength(2);
    const rsaAsset = assets.find((a) => a.algorithm === "RSA")!;
    const md5Asset = assets.find((a) => a.algorithm === "MD5")!;
    expect(rsaAsset.status).toBe("gone");
    expect(md5Asset.status).toBe("active");

    // Its observation history from the first scan still exists.
    const rsaObservations = await db.select().from(observationsTable).where(eq(observationsTable.assetId, rsaAsset.id));
    expect(rsaObservations).toHaveLength(1);

    // If the line comes back in a later scan, the same asset row reactivates rather than a new one being created.
    const third = await ingestSourceObservations(db, {
      repo: "project:1",
      files: [{ path: "keys.py", content: firstScan, language: "python" }],
    });
    expect(third.assetsCreated).toBe(0);
    const [reactivated] = await db.select().from(assetsTable).where(eq(assetsTable.id, rsaAsset.id));
    expect(reactivated.status).toBe("active");
    const assetsAfterReactivation = await db.select().from(assetsTable).where(eq(assetsTable.organizationId, DEFAULT_ORGANIZATION_ID));
    expect(assetsAfterReactivation).toHaveLength(2); // still the same two rows, no duplicate created on reactivation
  });

  it("does not mark a file's assets gone when that file is simply absent from a later, narrower scan — reconciliation is scoped per scanned file, not per repo", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    await ingestSourceObservations(db, {
      repo: "project:1",
      files: [
        { path: "a.py", content: "key = RSA.generate(2048)", language: "python" },
        { path: "b.py", content: "h = hashlib.md5(x)", language: "python" },
      ],
    });

    // A later scan submits only a.py — b.py was not part of this run, so
    // its asset must be left alone, not marked gone.
    const second = await ingestSourceObservations(db, {
      repo: "project:1",
      files: [{ path: "a.py", content: "key = RSA.generate(2048)", language: "python" }],
    });
    expect(second.assetsMarkedGone).toBe(0);

    const [md5Asset] = await db.select().from(assetsTable).where(eq(assetsTable.algorithm, "MD5"));
    expect(md5Asset.status).toBe("active");
  });

  it("does not reset a waived or remediated asset to active when it is observed again — only gone reactivates", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const files = [{ path: "keys.py", content: "key = RSA.generate(2048)\nh = hashlib.md5(x)", language: "python" }];
    await ingestSourceObservations(db, { repo: "project:1", files });

    // A human accepts the RSA risk and marks the MD5 one fixed. Both are
    // decisions about the asset, not observations of it.
    await db.update(assetsTable).set({ status: "waived" }).where(eq(assetsTable.algorithm, "RSA"));
    await db.update(assetsTable).set({ status: "remediated" }).where(eq(assetsTable.algorithm, "MD5"));
    const [beforeRescan] = await db.select().from(assetsTable).where(eq(assetsTable.algorithm, "RSA"));

    await ingestSourceObservations(db, { repo: "project:1", files });

    const assets = await db.select().from(assetsTable).where(eq(assetsTable.organizationId, DEFAULT_ORGANIZATION_ID));
    expect(assets.find((a) => a.algorithm === "RSA")!.status).toBe("waived");
    expect(assets.find((a) => a.algorithm === "MD5")!.status).toBe("remediated");
    // The re-observation is still recorded — only the human decision is left alone.
    expect(assets.find((a) => a.algorithm === "RSA")!.lastSeen.getTime()).toBeGreaterThanOrEqual(
      beforeRescan.lastSeen.getTime(),
    );
    const observations = await db.select().from(observationsTable).where(eq(observationsTable.assetId, beforeRescan.id));
    expect(observations).toHaveLength(2);
  });

  it("writes a collection_run and links every observation to it", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const result = await ingestSourceObservations(db, {
      repo: "project:1",
      files: [{ path: "a.go", content: "rsa.GenerateKey(rand.Reader, 2048)", language: "go" }],
    });

    const [run] = await db.select().from(collectionRunsTable).where(eq(collectionRunsTable.id, result.collectionRunId));
    expect(run.surface).toBe("source");
    expect(run.collector).toBe("source-regex");

    const obs = await db.select().from(observationsTable).where(eq(observationsTable.collectionRunId, run.id));
    expect(obs).toHaveLength(1);
    expect(obs[0].discoveryModality).toBe("static_artifact_analysis");
  });
});
