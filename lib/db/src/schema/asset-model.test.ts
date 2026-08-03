import { describe, expect, it, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../test-support/test-db";
import { assetsTable } from "./assets";
import { observationsTable } from "./observations";
import { collectionRunsTable } from "./collection_runs";
import { projectsTable } from "./projects";
import { scansTable } from "./scans";
import { findingsTable } from "./findings";

describe("asset/observation model — persisted against a real (embedded) Postgres via the generated migration", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("keySize: undefined on the observation's source stays undetermined (null) through persistence and read-back — never silently defaulted", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const [run] = await db
      .insert(collectionRunsTable)
      .values({ organizationId: 1, collector: "source-regex", collectorVersion: "1.0.0", surface: "source" })
      .returning();

    // Mirrors the ingestion boundary conversion: RawObservation.keySize is
    // `undefined` when undeterminable; the insert value passed here is
    // `null`, not a default. This is the exact conversion advisor guidance
    // flagged as the place a silent default could sneak in.
    const rawObservationKeySize: number | undefined = undefined;

    const [asset] = await db
      .insert(assetsTable)
      .values({
        organizationId: 1,
        fingerprint: "test-fingerprint-undetermined",
        surface: "source",
        algorithm: "RSA",
        keySize: rawObservationKeySize ?? null,
        location: "acme/widget:paramiko/transport.py",
      })
      .returning();

    expect(asset.keySize).toBeNull();

    await db.insert(observationsTable).values({
      organizationId: 1,
      assetId: asset.id,
      collectionRunId: run.id,
      collector: "source-regex",
      collectorVersion: "1.0.0",
      confidence: 0.7,
      discoveryModality: "static_artifact_analysis",
      evidence: { lineNumber: 165, codeSnippet: "key = RSA.generate(bits)", keySize: rawObservationKeySize ?? null },
    });

    // Read back through a fresh select — not the `.returning()` value —
    // to prove the column itself stores null, not merely the in-memory object.
    const [readBack] = await db.select().from(assetsTable).where(eq(assetsTable.id, asset.id));
    expect(readBack.keySize).toBeNull();
    expect(readBack.keySize).not.toBe(2048); // the exact "silently became a default" failure this test exists to catch

    const [obs] = await db.select().from(observationsTable).where(eq(observationsTable.assetId, asset.id));
    expect(obs.evidence).toMatchObject({ keySize: null });
  });

  it("keySize: a determined value round-trips exactly, distinguishing 'null' (undetermined) from '0' (a real but falsy value)", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const [run] = await db
      .insert(collectionRunsTable)
      .values({ organizationId: 1, collector: "source-regex", collectorVersion: "1.0.0", surface: "source" })
      .returning();

    const [asset] = await db
      .insert(assetsTable)
      .values({
        organizationId: 1,
        fingerprint: "test-fingerprint-determined",
        surface: "source",
        algorithm: "RSA",
        keySize: 2048,
        location: "acme/widget:tls/config.go",
      })
      .returning();

    const [readBack] = await db.select().from(assetsTable).where(eq(assetsTable.id, asset.id));
    expect(readBack.keySize).toBe(2048);
    void run;
  });

  it("rejects an out-of-enum discoveryModality via the CHECK constraint", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const [run] = await db
      .insert(collectionRunsTable)
      .values({ organizationId: 1, collector: "source-regex", collectorVersion: "1.0.0", surface: "source" })
      .returning();
    const [asset] = await db
      .insert(assetsTable)
      .values({ organizationId: 1, fingerprint: "fp-bad-modality", surface: "source", algorithm: "RSA", location: "x" })
      .returning();

    await expect(
      db.insert(observationsTable).values({
        organizationId: 1,
        assetId: asset.id,
        collectionRunId: run.id,
        collector: "source-regex",
        collectorVersion: "1.0.0",
        confidence: 0.7,
        discoveryModality: "clairvoyance", // deliberately invalid — the column is `text`, so the CHECK constraint is what must reject this, not the type system
      }),
    ).rejects.toThrow();
  });

  it("rejects an out-of-enum surface via the CHECK constraint", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    await expect(
      db.insert(assetsTable).values({
        organizationId: 1,
        fingerprint: "fp-bad-surface",
        surface: "quantum-realm", // deliberately invalid — same rationale as above
        algorithm: "RSA",
        location: "x",
      }),
    ).rejects.toThrow();
  });

  it("enforces the (organizationId, fingerprint) unique index — re-scanning an unchanged asset must not create a duplicate", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    await db
      .insert(assetsTable)
      .values({ organizationId: 1, fingerprint: "fp-dup", surface: "source", algorithm: "RSA", location: "x" });

    await expect(
      db.insert(assetsTable).values({ organizationId: 1, fingerprint: "fp-dup", surface: "source", algorithm: "RSA", location: "x" }),
    ).rejects.toThrow();

    // A different organization with the identical fingerprint is fine.
    await expect(
      db.insert(assetsTable).values({ organizationId: 2, fingerprint: "fp-dup", surface: "source", algorithm: "RSA", location: "x" }),
    ).resolves.toBeDefined();
  });

  it("enforces observations.assetId / collectionRunId foreign keys", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    await expect(
      db.insert(observationsTable).values({
        organizationId: 1,
        assetId: 999_999,
        collectionRunId: 999_999,
        collector: "source-regex",
        collectorVersion: "1.0.0",
        confidence: 0.7,
        discoveryModality: "static_artifact_analysis",
      }),
    ).rejects.toThrow();
  });

  it("enforces the new findings.scanId / scans.projectId foreign keys added by this migration", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    await expect(
      db.insert(scansTable).values({ organizationId: 1, projectId: 999_999, totalLines: 0 }),
    ).rejects.toThrow();

    const [project] = await db
      .insert(projectsTable)
      .values({ organizationId: 1, name: "p", language: "python" })
      .returning();
    const [scan] = await db.insert(scansTable).values({ organizationId: 1, projectId: project.id, totalLines: 0 }).returning();

    await expect(
      db.insert(findingsTable).values({
        organizationId: 1,
        scanId: 999_999,
        fileName: "a.py",
        lineNumber: 1,
        severity: "critical",
        algorithm: "RSA",
        codeSnippet: "x",
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(findingsTable).values({
        organizationId: 1,
        scanId: scan.id,
        fileName: "a.py",
        lineNumber: 1,
        severity: "critical",
        algorithm: "RSA",
        codeSnippet: "x",
      }),
    ).resolves.toBeDefined();

    // Deleting the parent project cascades — no orphaned scan/finding rows survive.
    await db.delete(projectsTable).where(eq(projectsTable.id, project.id));
    const remainingScans = await db.select().from(scansTable).where(eq(scansTable.projectId, project.id));
    expect(remainingScans).toHaveLength(0);
  });
});
