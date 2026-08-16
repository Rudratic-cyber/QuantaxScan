import { describe, expect, it, afterEach, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, and } from "drizzle-orm";
import { assetsTable, observationsTable, collectionRunsTable } from "@workspace/db/schema";
import type { ScopedTx } from "@workspace/db/org-scope";
import { createTestDb, type TestDb } from "@workspace/db/test-support";
import type { DataAtRestStoreInput, EndpointHostReport } from "@workspace/collectors";
import type { DataClassification } from "@workspace/db/classification";
import {
  ingestSourceObservations,
  ingestCertificateObservations,
  ingestDataAtRestObservations,
  ingestProtocolConfigObservations,
  ingestEndpointObservations,
} from "./asset-ingest";

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

  /**
   * M3 — the two lifecycle-stamp columns the drift feed reads.
   *
   * The bug this guards against is silent and would make the whole feature
   * lie: stamping `statusChangedAt` on every upsert rather than only on a real
   * transition. Nothing would fail, no count would change, and a nightly
   * schedule would report the entire estate as having changed every night —
   * which is indistinguishable from "we have no idea what changed".
   */
  it("stamps statusChangedAt only on a real transition, never on an unchanged re-observation", async () => {
    await start();

    const files = [{ path: "keys.py", content: "key = RSA.generate(2048)", language: "python" }];
    await ingest({ repo: "project:1", files });

    // A brand-new asset has never transitioned. Null, not `firstSeen`: an
    // asset that has never left the status it was created in has no change to
    // report, and a timestamp here would be a change that never happened.
    const [created] = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.algorithm, "RSA")));
    expect(created.statusChangedAt).toBeNull();
    expect(created.statusChangedByRunId).toBeNull();

    // Re-observing it unchanged moves `lastSeen` and nothing else.
    await ingest({ repo: "project:1", files });
    const [reobserved] = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.algorithm, "RSA")));
    expect(reobserved.statusChangedAt).toBeNull();
    expect(reobserved.statusChangedByRunId).toBeNull();
    expect(reobserved.lastSeen.getTime()).toBeGreaterThanOrEqual(created.lastSeen.getTime());
  });

  it("stamps the disappearance with the run that did not observe it, and the reappearance with the run that did", async () => {
    await start();

    const withRsa = [{ path: "keys.py", content: "key = RSA.generate(2048)\nh = hashlib.md5(x)", language: "python" }];
    const withoutRsa = [{ path: "keys.py", content: "h = hashlib.md5(x)", language: "python" }];

    await ingest({ repo: "project:1", files: withRsa });
    const removal = await ingest({ repo: "project:1", files: withoutRsa });
    expect(removal.assetsMarkedGone).toBe(1);

    const [gone] = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.algorithm, "RSA")));
    expect(gone.status).toBe("gone");
    expect(gone.statusChangedAt).not.toBeNull();
    // The run that *failed to find it*, which is the provenance a drift reader
    // follows to confirm a real examination happened. Without it an absence is
    // just an absence, and reporting that as remediation is the failure D4
    // exists to avoid.
    expect(gone.statusChangedByRunId).toBe(removal.collectionRunId);
    // `lastSeen` still records when it was last actually observed — never
    // advanced by the run that missed it.
    expect(gone.lastSeen.getTime()).toBeLessThan(gone.statusChangedAt!.getTime() + 1);

    // The asset that was there both times is untouched by its neighbour's
    // transition — the stamp is per asset, not per run.
    const [stayed] = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.algorithm, "MD5")));
    expect(stayed.statusChangedAt).toBeNull();

    const reappearance = await ingest({ repo: "project:1", files: withRsa });
    const [back] = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.algorithm, "RSA")));
    expect(back.status).toBe("active");
    expect(back.statusChangedByRunId).toBe(reappearance.collectionRunId);
    expect(back.statusChangedAt!.getTime()).toBeGreaterThanOrEqual(gone.statusChangedAt!.getTime());
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

/**
 * B7 — the data-at-rest ingest. These run against real migrations, real
 * `CHECK` constraints and real RLS through pglite, which is the only way the
 * `COALESCE` upsert below is actually exercised: it is SQL, not TypeScript, so
 * a mocked schema would prove nothing about it.
 */
describe("ingestDataAtRestObservations — B7", () => {
  let harness: TestDb | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function start(): Promise<void> {
    harness = await createTestDb({ asRole: "quantaxscan_app" });
  }

  function ingest(params: {
    repo?: string;
    stores: DataAtRestStoreInput[];
    classificationByStoreId?: Map<string, { dataClassification?: DataClassification | null; secrecyLifetimeYears?: number | null }>;
  }) {
    return harness!.scope.withOrg(ORG, (tx) =>
      ingestDataAtRestObservations(tx, {
        repo: params.repo ?? "project:1",
        stores: params.stores,
        organizationId: ORG_ID,
        classificationByStoreId: params.classificationByStoreId,
      }),
    );
  }

  function read<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    return harness!.scope.withOrg(ORG, fn);
  }

  const encryptedStore: DataAtRestStoreInput = {
    storeId: "billing",
    engine: "postgresql",
    storeKind: "database",
    encryptionState: "encrypted",
    evidenceSource: "configuration-report",
    dataEncryption: { algorithm: "AES-256-CBC" },
    keyProtection: { algorithm: "RSA-2048", source: "aws-kms" },
  };

  it("writes both halves of the key hierarchy as separate assets on the data-at-rest surface", async () => {
    await start();

    const result = await ingest({ stores: [encryptedStore] });
    expect(result.assetsCreated).toBe(2);

    const assets = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)));
    expect(assets.map((a) => a.surface)).toEqual(["data-at-rest", "data-at-rest"]);
    expect(assets.map((a) => a.algorithm).sort()).toEqual(["AES", "RSA"]);

    const [run] = await read((tx) => tx.select().from(collectionRunsTable).where(eq(collectionRunsTable.id, result.collectionRunId)));
    expect(run.surface).toBe("data-at-rest");
    expect(run.collector).toBe("data-at-rest-config");

    const obs = await read((tx) => tx.select().from(observationsTable).where(eq(observationsTable.collectionRunId, run.id)));
    expect(obs).toHaveLength(2);
    expect(obs.every((o) => o.discoveryModality === "configuration_information")).toBe(true);
  });

  it("persists a supplied classification on BOTH of a store's assets, which is what puts this surface in front of the risk engine", async () => {
    await start();

    await ingest({
      stores: [encryptedStore],
      classificationByStoreId: new Map([["billing", { dataClassification: "regulated", secrecyLifetimeYears: null }]]),
    });

    const assets = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)));
    expect(assets).toHaveLength(2);
    expect(assets.every((a) => a.dataClassification === "regulated")).toBe(true);

    // X itself stays null: the caller named a classification, not a year count,
    // and `resolveSecrecyLifetime()` derives 25 from the label at read time
    // rather than this ingest freezing a number onto the row.
    expect(assets.every((a) => a.secrecyLifetimeYears === null)).toBe(true);
  });

  it("leaves classification null when nobody supplied one, so an assumed X stays distinguishable from a stated one", async () => {
    await start();

    await ingest({ stores: [encryptedStore] });

    const assets = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)));
    expect(assets.every((a) => a.dataClassification === null)).toBe(true);
    expect(assets.every((a) => a.secrecyLifetimeYears === null)).toBe(true);
  });

  it("does NOT erase a previously supplied classification when a later submission omits it", async () => {
    await start();

    await ingest({
      stores: [encryptedStore],
      classificationByStoreId: new Map([["billing", { dataClassification: "regulated", secrecyLifetimeYears: 30 }]]),
    });
    // A nightly config export that carries the crypto but not the
    // classification. "Not supplied" is not "no longer classified".
    await ingest({ stores: [encryptedStore] });

    const assets = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)));
    expect(assets.every((a) => a.dataClassification === "regulated")).toBe(true);
    expect(assets.every((a) => a.secrecyLifetimeYears === 30)).toBe(true);
  });

  it("marks the superseded algorithm gone when a store migrates off it", async () => {
    await start();

    await ingest({ stores: [encryptedStore] });
    const result = await ingest({
      stores: [{ ...encryptedStore, keyProtection: { algorithm: "ECDH", source: "aws-kms" } }],
    });

    expect(result.assetsMarkedGone).toBe(1);
    const assets = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)));
    expect(assets.find((a) => a.algorithm === "RSA")!.status).toBe("gone");
    expect(assets.find((a) => a.algorithm === "ECDH")!.status).toBe("active");
    // The bulk cipher was resubmitted unchanged and is untouched.
    expect(assets.find((a) => a.algorithm === "AES")!.status).toBe("active");
  });

  it("does NOT mark a recorded cipher gone when a resubmission leaves the cipher field blank", async () => {
    await start();

    await ingest({ stores: [encryptedStore, { ...encryptedStore, storeId: "archive", storeKind: "archive" }] });

    // A real run — the archive is still fully described — in which `billing`
    // is still reported as encrypted but this export did not carry its
    // algorithm. Nothing was remediated; a field was left empty. Marking
    // billing's assets gone here would be a silent false remediation, which is
    // the failure `ReobservationScope` exists for, and it would happen inside
    // an otherwise perfectly ordinary run.
    const result = await ingest({
      stores: [
        { storeId: "billing", engine: "postgresql", encryptionState: "encrypted" },
        { ...encryptedStore, storeId: "archive", storeKind: "archive" },
      ],
    });

    expect(result.assetsMarkedGone).toBe(0);
    const assets = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)));
    expect(assets).toHaveLength(4);
    expect(assets.every((a) => a.status === "active")).toBe(true);
  });

  it("DOES mark a recorded cipher gone when a store is resubmitted as not encrypted", async () => {
    await start();

    await ingest({ stores: [encryptedStore] });
    const result = await ingest({
      stores: [{ storeId: "billing", engine: "postgresql", encryptionState: "not-encrypted" }],
    });

    // A positive statement of absence, unlike the blank field above.
    expect(result.assetsMarkedGone).toBe(2);
    const assets = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)));
    expect(assets.every((a) => a.status === "gone")).toBe(true);
  });

  it("leaves another store's assets alone — the reobservation scope is per store slot, never per surface", async () => {
    await start();

    await ingest({
      stores: [encryptedStore, { ...encryptedStore, storeId: "archive", storeKind: "archive" }],
    });
    const result = await ingest({
      stores: [{ storeId: "billing", engine: "postgresql", encryptionState: "not-encrypted" }],
    });

    expect(result.assetsMarkedGone).toBe(2);
    const assets = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)));
    const archive = assets.filter((a) => a.location.includes(":archive:"));
    expect(archive).toHaveLength(2);
    expect(archive.every((a) => a.status === "active")).toBe(true);
  });

  it("records a run for an all-not-encrypted submission — that is a real examination with a real result", async () => {
    await start();

    const result = await ingest({
      stores: [{ storeId: "billing", engine: "postgresql", encryptionState: "not-encrypted" }],
    });

    expect(result.observationsCreated).toBe(0);
    const [run] = await read((tx) => tx.select().from(collectionRunsTable).where(eq(collectionRunsTable.id, result.collectionRunId)));
    expect(run.surface).toBe("data-at-rest");
  });

  it("throws rather than recording a run when the submission states nothing reconcilable at all", async () => {
    await start();

    await expect(ingest({ stores: [{ storeId: "billing", engine: "postgresql" }] })).rejects.toThrow(
      /no store it could say anything about/,
    );

    const runs = await read((tx) => tx.select().from(collectionRunsTable).where(eq(collectionRunsTable.organizationId, ORG_ID)));
    expect(runs).toHaveLength(0);
  });

  it("records a null key size for a cipher named without one, rather than an assumed 256", async () => {
    await start();

    await ingest({
      stores: [{ storeId: "billing", engine: "postgresql", encryptionState: "encrypted", dataEncryption: { algorithm: "AES" } }],
    });

    const assets = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)));
    expect(assets).toHaveLength(1);
    expect(assets[0].keySize).toBeNull();
  });
});

describe("ingestProtocolConfigObservations — B6", () => {
  let harness: TestDb | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function start(): Promise<void> {
    harness = await createTestDb({ asRole: "quantaxscan_app" });
  }

  function ingest(params: { repo: string; files: Array<{ path: string; content: string }> }) {
    return harness!.scope.withOrg(ORG, (tx) => ingestProtocolConfigObservations(tx, { ...params, organizationId: ORG_ID }));
  }

  function read<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    return harness!.scope.withOrg(ORG, fn);
  }

  const SSHD_PATH = "etc/ssh/sshd_config";

  it("creates one asset per declaration, on the config surface, attributed by the location prefix", async () => {
    await start();

    const result = await ingest({
      repo: "project:1",
      files: [{ path: SSHD_PATH, content: "HostKeyAlgorithms ssh-rsa,ssh-ed25519\nKexAlgorithms curve25519-sha256\n" }],
    });
    expect(result.assetsCreated).toBe(3);
    expect(result.observationsCreated).toBe(3);
    expect(result.configFiles).toEqual([{ path: SSHD_PATH, format: "sshd-config", declarationCount: 3 }]);

    const assets = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)));
    expect(assets).toHaveLength(3);
    expect(assets.every((a) => a.surface === "config")).toBe(true);
    expect(assets.every((a) => a.location === `project:1:config:${SSHD_PATH}`)).toBe(true);
    expect(assets.find((a) => a.algorithm === "EdDSA")?.keySize).toBe(256);
    // `ssh-rsa` states no modulus and this collector does not decode the blob
    // to guess one — undetermined, not defaulted (G-05).
    expect(assets.find((a) => a.algorithm === "RSA")?.keySize).toBeNull();
  });

  /**
   * The reason `reobserved` is built from the recognised FILES rather than from
   * the observations. Delete the last algorithm directive and resubmit: the
   * file produces zero observations, so a scope derived from observations would
   * never cover its location and the old asset would stay `active` forever —
   * exactly the edit this feature exists to detect.
   */
  it("marks a declaration gone when the directive is removed from a resubmitted file", async () => {
    await start();

    await ingest({ repo: "project:1", files: [{ path: SSHD_PATH, content: "HostKeyAlgorithms ssh-rsa,ssh-ed25519\n" }] });

    const second = await ingest({ repo: "project:1", files: [{ path: SSHD_PATH, content: "HostKeyAlgorithms ssh-ed25519\n" }] });
    expect(second.assetsMarkedGone).toBe(1);

    const assets = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)));
    expect(assets.find((a) => a.algorithm === "RSA")?.status).toBe("gone");
    expect(assets.find((a) => a.algorithm === "EdDSA")?.status).toBe("active");

    // ...and emptying the file entirely still marks the rest gone, which a
    // scope derived from observations could not have done.
    const third = await ingest({ repo: "project:1", files: [{ path: SSHD_PATH, content: "Port 22\n" }] });
    expect(third.assetsMarkedGone).toBe(1);
    expect(third.observationsCreated).toBe(0);
  });

  it("records a run for a recognised file that declares nothing — examined and empty is not un-examined", async () => {
    await start();

    const result = await ingest({ repo: "project:1", files: [{ path: SSHD_PATH, content: "Port 2222\nPermitRootLogin no\n" }] });
    expect(result.observationsCreated).toBe(0);
    expect(result.configFiles).toEqual([{ path: SSHD_PATH, format: "sshd-config", declarationCount: 0 }]);

    const runs = await read((tx) => tx.select().from(collectionRunsTable).where(eq(collectionRunsTable.organizationId, ORG_ID)));
    expect(runs).toHaveLength(1);
    expect(runs[0].surface).toBe("config");
    expect(runs[0].collector).toBe("protocol-config");
  });

  it("throws rather than recording a run when no submitted file is a configuration it understands", async () => {
    await start();

    await expect(
      ingest({ repo: "project:1", files: [{ path: "README.md", content: "prose about sshd_config" }] }),
    ).rejects.toThrow(/no recognised configuration file/);

    const runs = await read((tx) => tx.select().from(collectionRunsTable).where(eq(collectionRunsTable.organizationId, ORG_ID)));
    expect(runs).toHaveLength(0);
  });

  it("leaves another file's declarations alone — the scope is the files this submission read", async () => {
    await start();

    await ingest({
      repo: "project:1",
      files: [
        { path: SSHD_PATH, content: "HostKeyAlgorithms ssh-rsa\n" },
        { path: "etc/ipsec.conf", content: "conn site\n  ike=aes256-modp2048\n" },
      ],
    });

    // Only the ssh file is resubmitted, now empty. The IPsec declarations were
    // not observed by this run and must not be inferred as removed.
    const second = await ingest({ repo: "project:1", files: [{ path: SSHD_PATH, content: "Port 22\n" }] });
    expect(second.assetsMarkedGone).toBe(1);

    const assets = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)));
    expect(assets.filter((a) => a.status === "active")).toHaveLength(2);
    expect(assets.filter((a) => a.status === "gone")).toHaveLength(1);
  });

  it("records configuration_information at a confidence below the TLS handshake's, split by declaration strength", async () => {
    await start();

    const result = await ingest({
      repo: "project:1",
      files: [
        { path: SSHD_PATH, content: "HostKeyAlgorithms ssh-ed25519\n" },
        { path: "home/deploy/.ssh/authorized_keys", content: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 deploy@host\n" },
      ],
    });
    expect(result.observationsCreated).toBe(2);

    const obs = await read((tx) => tx.select().from(observationsTable).where(eq(observationsTable.organizationId, ORG_ID)));
    expect(obs.every((o) => o.discoveryModality === "configuration_information")).toBe(true);
    expect(obs.every((o) => o.confidence < 1)).toBe(true);
    const permitted = result.declarations.find((d) => d.strength === "permitted");
    const materialised = result.declarations.find((d) => d.strength === "materialised");
    expect(permitted?.confidence).toBeLessThan(materialised!.confidence);
  });

  it("returns a per-declaration summary the route can build a response from without re-parsing", async () => {
    await start();

    const result = await ingest({
      repo: "project:1",
      files: [{ path: SSHD_PATH, content: "Match Address 10.0.0.0/8\n  Ciphers aes128-ctr\n" }],
    });
    expect(result.declarations).toEqual([
      {
        path: SSHD_PATH,
        format: "sshd-config",
        directive: "Ciphers",
        declaredValue: "aes128-ctr",
        algorithm: "AES",
        keySize: 128,
        strength: "permitted",
        condition: "Match Address 10.0.0.0/8",
        confidence: 0.6,
      },
    ]);
  });
});

/**
 * EP — the endpoint/host ingest. Against real migrations, the real `surface`
 * `CHECK` (which is what proves `'endpoint'` is actually a storable value and
 * not merely a TypeScript literal) and real RLS through pglite.
 */
describe("ingestEndpointObservations — EP", () => {
  let harness: TestDb | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function start(): Promise<void> {
    harness = await createTestDb({ asRole: "quantaxscan_app" });
  }

  function ingest(hosts: EndpointHostReport[], repo = "project:1") {
    return harness!.scope.withOrg(ORG, (tx) => ingestEndpointObservations(tx, { repo, hosts, organizationId: ORG_ID }));
  }

  function read<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    return harness!.scope.withOrg(ORG, fn);
  }

  const MACHINE = "9f5a1e2c-4b6d-4f21-9c11-6a7b8c9d0e1f";

  const dc01: EndpointHostReport = {
    machineId: MACHINE,
    machineIdSource: "windows-machine-guid",
    hostname: "DC-01",
    os: { family: "windows", name: "Windows Server 2022 Datacenter", build: "20348.2402" },
    certificateStores: [
      { store: "LocalMachine\\My", certificates: [{ thumbprint: "AA11", publicKeyAlgorithm: "RSA", keySize: 2048 }] },
    ],
    tlsPolicy: {
      provider: "schannel",
      protocols: [{ name: "TLS 1.0", role: "Server", enabled: false }],
      cipherSuites: [{ name: "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384", enabled: true }],
    },
    providers: [{ name: "Microsoft Platform Crypto Provider", kind: "cng-ksp", loaded: true }],
  };

  it("persists a host's certificates and enabled suites on the endpoint surface", async () => {
    await start();

    const result = await ingest([dc01]);
    // One certificate (RSA) plus the suite's three algorithms.
    expect(result.assetsCreated).toBe(4);

    const assets = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)));
    expect(assets.every((a) => a.surface === "endpoint")).toBe(true);
    expect(assets.every((a) => a.location.startsWith(`project:1:endpoint:${MACHINE}:`))).toBe(true);
    expect(assets.map((a) => a.algorithm).sort()).toEqual(["AES", "ECDH", "RSA", "RSA"]);
    expect(assets.find((a) => a.algorithm === "AES")?.keySize).toBe(256);

    const [run] = await read((tx) => tx.select().from(collectionRunsTable).where(eq(collectionRunsTable.id, result.collectionRunId)));
    expect(run.surface).toBe("endpoint");
    expect(run.collector).toBe("endpoint-host-report");
    expect(run.status).toBe("completed");

    const obs = await read((tx) => tx.select().from(observationsTable).where(eq(observationsTable.collectionRunId, run.id)));
    // The first collector in the product to use the modality SP 1800-38B
    // defined for cryptography read off the host itself.
    expect(obs.every((o) => o.discoveryModality === "endpoint_monitoring")).toBe(true);
    expect(obs.every((o) => Number(o.confidence) < 1)).toBe(true);
  });

  it("retires a certificate removed from a store, and leaves a section the agent did not re-read alone", async () => {
    await start();

    await ingest([
      {
        ...dc01,
        certificateStores: [
          {
            store: "LocalMachine\\My",
            certificates: [
              { thumbprint: "AA11", publicKeyAlgorithm: "RSA", keySize: 2048 },
              { thumbprint: "BB22", publicKeyAlgorithm: "ECC", keySize: 384 },
            ],
          },
        ],
      },
    ]);

    // The agent re-reads only the store, and one certificate has been removed.
    const second = await ingest([
      {
        machineId: MACHINE,
        certificateStores: [
          { store: "LocalMachine\\My", certificates: [{ thumbprint: "AA11", publicKeyAlgorithm: "RSA", keySize: 2048 }] },
        ],
      },
    ]);
    expect(second.assetsMarkedGone).toBe(1);

    const assets = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)));
    expect(assets.find((a) => a.algorithm === "ECDSA")?.status).toBe("gone");
    // The suite list was NOT re-read, so its assets must be untouched. Marking
    // them gone because a partial agent run omitted them would be a silent
    // false remediation.
    expect(assets.filter((a) => a.algorithm === "AES").every((a) => a.status === "active")).toBe(true);
    expect(assets.find((a) => a.algorithm === "ECDH")?.status).toBe("active");
  });

  it("retires a suite pruned from a registry that now declares nothing this product reports", async () => {
    await start();

    await ingest([
      {
        machineId: MACHINE,
        tlsPolicy: { provider: "schannel", cipherSuites: [{ name: "TLS_RSA_WITH_AES_128_CBC_SHA", enabled: true }] },
      },
    ]);

    // The administrator prunes the list to a suite naming nothing this product
    // catalogues beyond its key exchange and signature. A scope built from
    // observations rather than from the slot that was read would leave the old
    // assets active forever.
    const second = await ingest([
      {
        machineId: MACHINE,
        tlsPolicy: { provider: "schannel", cipherSuites: [{ name: "TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256", enabled: true }] },
      },
    ]);
    expect(second.observationsCreated).toBe(2);
    // RSA, AES-128 and SHA-1 retire; ECDH and ECDSA are the new suite's.
    expect(second.assetsMarkedGone).toBe(3);
    expect(second.collectionRunId).toBeGreaterThan(0);
  });

  it("records a run for a host that was read and declares nothing reportable", async () => {
    await start();

    // Examined and found nothing — the state `collection_runs` exists to make
    // sayable, and the opposite of never having looked.
    const result = await ingest([
      {
        machineId: MACHINE,
        certificateStores: [{ store: "LocalMachine\\My", certificates: [] }],
        tlsPolicy: { provider: "schannel", cipherSuites: [] },
      },
    ]);
    expect(result.observationsCreated).toBe(0);
    expect(result.collectionRunId).toBeGreaterThan(0);
    expect(result.hosts[0].skipped).toBeUndefined();
  });

  it("refuses to record a run when no host could be identified", async () => {
    await start();

    // Examined nothing. Writing a `completed` run here would make the D3 meter
    // report the endpoint surface as "examined, nothing found".
    await expect(
      ingest([
        { machineId: "00000000-0000-0000-0000-000000000000", tlsPolicy: { provider: "schannel", cipherSuites: [] } },
        { machineId: "CLONE", tlsPolicy: { provider: "schannel", cipherSuites: [] } },
        { machineId: "clone", tlsPolicy: { provider: "schannel", cipherSuites: [] } },
      ]),
    ).rejects.toThrow(/no host it could identify/);

    const runs = await read((tx) => tx.select().from(collectionRunsTable));
    expect(runs).toHaveLength(0);
  });

  it("writes nothing for a refused host while ingesting the rest of the submission", async () => {
    await start();

    const suite = { provider: "schannel" as const, cipherSuites: [{ name: "TLS_AES_256_GCM_SHA384", enabled: true }] };
    const result = await ingest([
      { machineId: "CLONE", hostname: "vm-a", tlsPolicy: suite },
      { machineId: "CLONE", hostname: "vm-b", tlsPolicy: suite },
      { machineId: "REAL", hostname: "vm-c", tlsPolicy: suite },
    ]);

    expect(result.hosts.map((h) => h.skipped)).toEqual(["duplicate-machine-id", "duplicate-machine-id", undefined]);
    const assets = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.organizationId, ORG_ID)));
    expect(assets).toHaveLength(1);
    expect(assets[0].location).toBe("project:1:endpoint:REAL:tls-cipher-suites");
  });
});
