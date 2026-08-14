import { describe, expect, it, afterEach, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, and } from "drizzle-orm";
import { assetsTable, observationsTable, collectionRunsTable } from "@workspace/db/schema";
import type { ScopedTx } from "@workspace/db/org-scope";
import { createTestDb, type TestDb } from "@workspace/db/test-support";
import { ingestSourceObservations, ingestCertificateObservations } from "./asset-ingest";

const ORG_ID = 1;
const ORG = { organizationId: ORG_ID, userId: "" };

/**
 * Every test here runs as the runtime role, subject to row-level security —
 * not as pglite's default superuser, which has BYPASSRLS and would make the
 * organisation scoping in these assertions meaningless. See
 * `createTestDb`'s `asRole` option.
 */
describe("ingestSourceObservations — the A1/A2 dual-write path", () => {
  let harness: TestDb | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function start(): Promise<void> {
    harness = await createTestDb({ asRole: "quantaxscan_app" });
  }

  /** Ingest through the scope, the way a route does. */
  function ingest(params: { repo: string; files: Array<{ path: string; content: string; language: string }> }) {
    return harness!.scope.withOrg(ORG, (tx) => ingestSourceObservations(tx, { ...params, organizationId: ORG_ID }));
  }

  /** Read through the scope. An unscoped read would see nothing at all now. */
  function read<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    return harness!.scope.withOrg(ORG, fn);
  }

  it("creates one asset per distinct (repo, path, algorithm, symbol) and one observation per detection", async () => {
    await start();

    const code = ["from Crypto.PublicKey import RSA", "key = RSA.generate(2048)", "h = hashlib.md5(x)"].join("\n");
    const result = await ingest({
      repo: "project:1",
      files: [{ path: "keys.py", content: code, language: "python" }],
    });

    // Three lines match (two RSA, one MD5), but the two RSA lines share the
    // same (repo, path, algorithm, symbol) fingerprint — one asset, two
    // observations — while MD5 is a distinct asset. Three observations total.
    expect(result.observationsCreated).toBe(3);
    expect(result.assetsCreated).toBe(2);
    const assets = await read((tx) =>
      tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)),
    );
    const rsaAssets = assets.filter((a) => a.algorithm === "RSA");
    expect(rsaAssets).toHaveLength(1);
    expect(rsaAssets[0].keySize).toBe(2048); // the later (last-processed) RSA line has the literal key size

    const observationsForRsa = await read((tx) =>
      tx.select().from(observationsTable).where(eq(observationsTable.assetId, rsaAssets[0].id)),
    );
    expect(observationsForRsa).toHaveLength(2);
  });

  it("re-ingesting identical content does not create duplicate assets, only updates lastSeen (A1 acceptance: re-scanning an unchanged repo produces zero new assets)", async () => {
    await start();

    const files = [{ path: "keys.py", content: "key = RSA.generate(2048)", language: "python" }];
    const first = await ingest({ repo: "project:1", files });
    expect(first.assetsCreated).toBe(1);

    const second = await ingest({ repo: "project:1", files });
    expect(second.assetsCreated).toBe(0);
    expect(second.assetsUpdated).toBe(1);

    const assets = await read((tx) =>
      tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)),
    );
    expect(assets).toHaveLength(1);
  });

  it("keySize stays undetermined (null) end-to-end when the collector cannot determine it, and never regresses a determined value silently", async () => {
    await start();

    // Same fingerprint (repo/path/algorithm/symbol) but the line content
    // changes from a literal modulus to a variable — the new asset state
    // correctly reflects "no longer determinable from this line", it does
    // not retain the stale 2048.
    await ingest({
      repo: "project:1",
      files: [{ path: "keys.py", content: "key = RSA.generate(2048)", language: "python" }],
    });
    await ingest({
      repo: "project:1",
      files: [{ path: "keys.py", content: "key = RSA.generate(bits)", language: "python" }],
    });

    const [asset] = await read((tx) =>
      tx
        .select()
        .from(assetsTable)
        .where(and(eq(assetsTable.organizationId, ORG_ID), eq(assetsTable.algorithm, "RSA"))),
    );
    expect(asset.keySize).toBeNull();
  });

  it("marks an asset gone when a rescan of its file no longer finds it, and keeps it in history (A1 acceptance)", async () => {
    await start();

    const firstScan = ["key = RSA.generate(2048)", "h = hashlib.md5(x)"].join("\n");
    const first = await ingest({
      repo: "project:1",
      files: [{ path: "keys.py", content: firstScan, language: "python" }],
    });
    expect(first.assetsCreated).toBe(2);
    expect(first.assetsMarkedGone).toBe(0);

    // The RSA line is removed; MD5 remains.
    const secondScan = "h = hashlib.md5(x)";
    const second = await ingest({
      repo: "project:1",
      files: [{ path: "keys.py", content: secondScan, language: "python" }],
    });
    expect(second.assetsCreated).toBe(0);
    expect(second.assetsMarkedGone).toBe(1);

    const assets = await read((tx) =>
      tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)),
    );
    // Still 2 rows — the RSA asset is not deleted, only its status changed.
    expect(assets).toHaveLength(2);
    const rsaAsset = assets.find((a) => a.algorithm === "RSA")!;
    const md5Asset = assets.find((a) => a.algorithm === "MD5")!;
    expect(rsaAsset.status).toBe("gone");
    expect(md5Asset.status).toBe("active");

    // Its observation history from the first scan still exists.
    const rsaObservations = await read((tx) =>
      tx.select().from(observationsTable).where(eq(observationsTable.assetId, rsaAsset.id)),
    );
    expect(rsaObservations).toHaveLength(1);

    // If the line comes back in a later scan, the same asset row reactivates rather than a new one being created.
    const third = await ingest({
      repo: "project:1",
      files: [{ path: "keys.py", content: firstScan, language: "python" }],
    });
    expect(third.assetsCreated).toBe(0);
    const [reactivated] = await read((tx) =>
      tx.select().from(assetsTable).where(eq(assetsTable.id, rsaAsset.id)),
    );
    expect(reactivated.status).toBe("active");
    const assetsAfterReactivation = await read((tx) =>
      tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)),
    );
    expect(assetsAfterReactivation).toHaveLength(2); // still the same two rows, no duplicate created on reactivation
  });

  it("does not mark a file's assets gone when that file is simply absent from a later, narrower scan — reconciliation is scoped per scanned file, not per repo", async () => {
    await start();

    await ingest({
      repo: "project:1",
      files: [
        { path: "a.py", content: "key = RSA.generate(2048)", language: "python" },
        { path: "b.py", content: "h = hashlib.md5(x)", language: "python" },
      ],
    });

    // A later scan submits only a.py — b.py was not part of this run, so
    // its asset must be left alone, not marked gone.
    const second = await ingest({
      repo: "project:1",
      files: [{ path: "a.py", content: "key = RSA.generate(2048)", language: "python" }],
    });
    expect(second.assetsMarkedGone).toBe(0);

    const [md5Asset] = await read((tx) =>
      tx.select().from(assetsTable).where(eq(assetsTable.algorithm, "MD5")),
    );
    expect(md5Asset.status).toBe("active");
  });

  it("does not reset a waived or remediated asset to active when it is observed again — only gone reactivates", async () => {
    await start();

    const files = [{ path: "keys.py", content: "key = RSA.generate(2048)\nh = hashlib.md5(x)", language: "python" }];
    await ingest({ repo: "project:1", files });

    // A human accepts the RSA risk and marks the MD5 one fixed. Both are
    // decisions about the asset, not observations of it.
    const beforeRescan = await read(async (tx) => {
      await tx.update(assetsTable).set({ status: "waived" }).where(eq(assetsTable.algorithm, "RSA"));
      await tx.update(assetsTable).set({ status: "remediated" }).where(eq(assetsTable.algorithm, "MD5"));
      const [rsa] = await tx.select().from(assetsTable).where(eq(assetsTable.algorithm, "RSA"));
      return rsa;
    });

    await ingest({ repo: "project:1", files });

    const assets = await read((tx) =>
      tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)),
    );
    expect(assets.find((a) => a.algorithm === "RSA")!.status).toBe("waived");
    expect(assets.find((a) => a.algorithm === "MD5")!.status).toBe("remediated");
    // The re-observation is still recorded — only the human decision is left alone.
    expect(assets.find((a) => a.algorithm === "RSA")!.lastSeen.getTime()).toBeGreaterThanOrEqual(
      beforeRescan.lastSeen.getTime(),
    );
    const observations = await read((tx) =>
      tx.select().from(observationsTable).where(eq(observationsTable.assetId, beforeRescan.id)),
    );
    expect(observations).toHaveLength(2);
  });

  it("writes a collection_run and links every observation to it", async () => {
    await start();

    const result = await ingest({
      repo: "project:1",
      files: [{ path: "a.go", content: "rsa.GenerateKey(rand.Reader, 2048)", language: "go" }],
    });

    const [run] = await read((tx) =>
      tx.select().from(collectionRunsTable).where(eq(collectionRunsTable.id, result.collectionRunId)),
    );
    expect(run.surface).toBe("source");
    expect(run.collector).toBe("source-regex");

    const obs = await read((tx) =>
      tx.select().from(observationsTable).where(eq(observationsTable.collectionRunId, run.id)),
    );
    expect(obs).toHaveLength(1);
    expect(obs[0].discoveryModality).toBe("static_artifact_analysis");
  });

  it("cannot write into another organisation, even when handed one explicitly", async () => {
    await start();

    // The scope is org 1; the ingest is told org 2. RLS rejects it rather than
    // trusting the parameter — which is why `organizationId` having no default
    // is safe rather than fragile.
    let thrown: unknown;
    try {
      await harness!.scope.withOrg(ORG, (tx) =>
        ingestSourceObservations(tx, {
          repo: "project:1",
          files: [{ path: "keys.py", content: "key = RSA.generate(2048)", language: "python" }],
          organizationId: 2,
        }),
      );
    } catch (err) {
      thrown = err;
    }

    const messages: string[] = [];
    for (let err = thrown; err instanceof Error; err = err.cause) messages.push(err.message);
    expect(messages.join("\n")).toMatch(/row-level security policy/);
  });
});

/** Generated once for the whole file with the system `openssl` binary — never committed, per the lane brief's "no key material in the repo" rule. */
function generateSelfSignedCertPem(cn: string, days = 365): string {
  const dir = mkdtempSync(join(tmpdir(), "qx-asset-ingest-cert-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath, "-days", String(days), "-nodes", "-subj", `/CN=${cn}`],
      { stdio: "pipe" },
    );
    return readFileSync(certPath, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("ingestCertificateObservations — B4", () => {
  let harness: TestDb | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function start(): Promise<void> {
    harness = await createTestDb({ asRole: "quantaxscan_app" });
  }

  function ingest(params: { repo: string; files: Array<{ path: string; content: string }> }) {
    return harness!.scope.withOrg(ORG, (tx) => ingestCertificateObservations(tx, { ...params, organizationId: ORG_ID }));
  }

  function read<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    return harness!.scope.withOrg(ORG, fn);
  }

  let certA: string;
  let certB: string;

  beforeAll(() => {
    certA = generateSelfSignedCertPem("cert-a.example.invalid");
    certB = generateSelfSignedCertPem("cert-b.example.invalid");
  });

  it("creates one asset per certificate, attributed to the submitting project via the location prefix", async () => {
    await start();

    const result = await ingest({ repo: "project:1", files: [{ path: "server.pem", content: certA }] });
    expect(result.assetsCreated).toBe(1);
    expect(result.observationsCreated).toBe(1);
    expect(result.certificateFiles).toEqual([{ path: "server.pem", certificateCount: 1 }]);

    const assets = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)));
    expect(assets).toHaveLength(1);
    expect(assets[0].surface).toBe("certificate");
    expect(assets[0].algorithm).toBe("RSA");
    expect(assets[0].keySize).toBe(2048);
    expect(assets[0].location.startsWith("project:1:cert:")).toBe(true);
  });

  it("reads every certificate in a submitted chain bundle, not just the leaf", async () => {
    await start();

    const result = await ingest({ repo: "project:1", files: [{ path: "chain.pem", content: certA + certB }] });
    expect(result.assetsCreated).toBe(2);
    expect(result.certificateFiles).toEqual([{ path: "chain.pem", certificateCount: 2 }]);
  });

  it("re-ingesting the identical certificate does not create a duplicate asset, only updates lastSeen", async () => {
    await start();

    const files = [{ path: "server.pem", content: certA }];
    const first = await ingest({ repo: "project:1", files });
    expect(first.assetsCreated).toBe(1);

    const second = await ingest({ repo: "project:1", files });
    expect(second.assetsCreated).toBe(0);
    expect(second.assetsUpdated).toBe(1);

    const assets = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)));
    expect(assets).toHaveLength(1);
  });

  it("does NOT mark a certificate gone when a later submission simply omits it — renewal mints a new identity, not a slot update", async () => {
    await start();

    await ingest({ repo: "project:1", files: [{ path: "server.pem", content: certA }] });

    // A later submission carries only a different (e.g. renewed) certificate.
    // certA's asset must be left exactly as it was: there is no shared "slot"
    // between an old certificate and a new one the way there is for a source
    // file path or a dependency's ecosystem prefix — see the reobservation-
    // scope comment in asset-ingest.ts.
    const second = await ingest({ repo: "project:1", files: [{ path: "server.pem", content: certB }] });
    expect(second.assetsMarkedGone).toBe(0);

    const assets = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)));
    expect(assets).toHaveLength(2);
    expect(assets.every((a) => a.status === "active")).toBe(true);
  });

  it("throws rather than recording a run when no submitted file is a parseable certificate", async () => {
    await start();

    await expect(
      ingest({ repo: "project:1", files: [{ path: "notes.txt", content: "not a certificate" }] }),
    ).rejects.toThrow(/no parseable certificate/);

    const runs = await read((tx) => tx.select().from(collectionRunsTable).where(eq(collectionRunsTable.organizationId, ORG_ID)));
    expect(runs).toHaveLength(0);
  });

  it("writes a collection_run on the certificate surface and links the observation to it", async () => {
    await start();

    const result = await ingest({ repo: "project:1", files: [{ path: "server.pem", content: certA }] });

    const [run] = await read((tx) => tx.select().from(collectionRunsTable).where(eq(collectionRunsTable.id, result.collectionRunId)));
    expect(run.surface).toBe("certificate");
    expect(run.collector).toBe("certificate-x509");

    const obs = await read((tx) => tx.select().from(observationsTable).where(eq(observationsTable.collectionRunId, run.id)));
    expect(obs).toHaveLength(1);
    expect(obs[0].discoveryModality).toBe("static_artifact_analysis");
  });

  it("returns a per-certificate summary the route can build a response from without re-parsing", async () => {
    await start();

    const result = await ingest({ repo: "project:1", files: [{ path: "server.pem", content: certA }] });
    expect(result.certificates).toHaveLength(1);
    expect(result.certificates[0]).toMatchObject({ algorithm: "RSA", keySize: 2048 });
    expect(result.certificates[0].issuer).toContain("cert-a.example.invalid");
    expect(new Date(result.certificates[0].notAfter).getTime()).toBeGreaterThan(Date.now());
  });
});
