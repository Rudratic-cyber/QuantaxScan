import { describe, expect, it, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  assetsTable,
  collectionRunsTable,
  collectionSchedulesTable,
  collectionScheduleRunsTable,
  projectsTable,
} from "@workspace/db/schema";
import type { ScopedTx } from "@workspace/db/org-scope";
import { createTestDb, type TestDb } from "@workspace/db/test-support";
import type { TlsHandshakeResult } from "@workspace/collectors";
import { runDueSchedules, type ScheduleRunnerDeps } from "./schedule-runner";
import { summariseProjectCoverage } from "./coverage";
import type { TlsProbeOutcome } from "./tls-probe";

/**
 * M3 — the runner, against the real schema and the real row-level-security
 * policies (pglite as the runtime role), with only the socket faked.
 *
 * **Faking the probe rather than the ingest is the point.** Everything below
 * the probe — the reobservation scope, the `gone` reconciliation, the lifecycle
 * stamps the drift feed reads — is the real code path, so the assertions about
 * what an unreachable host does and does not do are assertions about
 * production. `tests/e2e/17-continuity.spec.ts` closes the loop with a genuine
 * TLS server on loopback.
 */

const ORG_ID = 1;
const ORG = { organizationId: ORG_ID, userId: "" };
const HOST = "watched.test";
const OTHER_HOST = "other.test";

function handshake(host: string, port: number, modulusBits: number): TlsHandshakeResult {
  return {
    host,
    port,
    protocolVersion: "TLSv1.3",
    cipherSuiteName: "TLS_AES_256_GCM_SHA384",
    keyExchange: { type: "ECDH" },
    peerCertificatePublicKey: { keyType: "rsa", modulusBits },
  };
}

const probed = (host: string, port: number, bits = 2048): TlsProbeOutcome => ({
  host,
  port,
  outcome: "probed",
  handshake: handshake(host, port, bits),
});

const unreachable = (host: string, port: number): TlsProbeOutcome => ({ host, port, outcome: "unreachable" });

describe("the scheduled re-collection runner", () => {
  let harness: TestDb | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function start(): Promise<void> {
    harness = await createTestDb({ asRole: "quantaxscan_app" });
  }

  function read<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    return harness!.scope.withOrg(ORG, fn);
  }

  /** A project and a schedule pointed at one host, due now. */
  async function seed(targets: Array<{ host: string; port: number }>): Promise<{ projectId: number; scheduleId: number }> {
    return read(async (tx) => {
      const [project] = await tx
        .insert(projectsTable)
        .values({ organizationId: ORG_ID, name: "watched", language: "python" })
        .returning();
      const [schedule] = await tx
        .insert(collectionSchedulesTable)
        .values({
          organizationId: ORG_ID,
          projectId: project.id,
          targetKind: "tls",
          target: { targets },
          intervalMinutes: 60,
          nextRunAt: new Date(Date.now() - 60_000),
        })
        .returning();
      return { projectId: project.id, scheduleId: schedule.id };
    });
  }

  function deps(probe: ScheduleRunnerDeps["probe"]): ScheduleRunnerDeps {
    return { probe, now: () => new Date() };
  }

  it("replays a schedule's stored targets through the existing collector and records the run", async () => {
    await start();
    const { projectId, scheduleId } = await seed([{ host: HOST, port: 443 }]);

    const result = await runDueSchedules(harness!.scope, ORG, deps(async () => [probed(HOST, 443)]));

    expect(result.due).toBe(1);
    expect(result.executed).toHaveLength(1);
    expect(result.executed[0].status).toBe("succeeded");
    // Two observations from one handshake — the key exchange and the peer
    // certificate's public key. No new collector was written for any of this.
    expect(result.executed[0].observationsCreated).toBe(2);

    const assets = await read((tx) => tx.select().from(assetsTable));
    expect(assets.map((a) => a.location)).toEqual([`project:${projectId}:${HOST}:443`, `project:${projectId}:${HOST}:443`]);

    const runs = await read((tx) => tx.select().from(collectionRunsTable));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("completed");

    const [schedule] = await read((tx) =>
      tx.select().from(collectionSchedulesTable).where(eq(collectionSchedulesTable.id, scheduleId)),
    );
    expect(schedule.lastRunAt).not.toBeNull();
    expect(schedule.lastSucceededAt).not.toBeNull();
    // Advanced, so the next poll does not re-run it immediately.
    expect(schedule.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("re-running an unchanged target creates no new asset and stamps no status change", async () => {
    await start();
    await seed([{ host: HOST, port: 443 }]);

    await runDueSchedules(harness!.scope, ORG, deps(async () => [probed(HOST, 443)]));
    // Force it due again rather than waiting an hour.
    await read((tx) => tx.update(collectionSchedulesTable).set({ nextRunAt: new Date(Date.now() - 1000) }));
    const second = await runDueSchedules(harness!.scope, ORG, deps(async () => [probed(HOST, 443)]));

    expect(second.executed[0].assetsCreated).toBe(0);
    expect(second.executed[0].assetsMarkedGone).toBe(0);

    const assets = await read((tx) => tx.select().from(assetsTable));
    expect(assets).toHaveLength(2);
    // The drift feed windows on this column. If a routine re-collection stamped
    // it, every schedule would report the whole estate as changed on every run.
    for (const a of assets) expect(a.statusChangedAt).toBeNull();
  });

  /**
   * The test the whole lane turns on.
   */
  it("an attempt where nothing answered marks NOTHING gone, writes no collection run, and is still recorded as an attempt", async () => {
    await start();
    await seed([{ host: HOST, port: 443 }]);

    // First, a real observation, so there is something that could wrongly be
    // declared remediated.
    await runDueSchedules(harness!.scope, ORG, deps(async () => [probed(HOST, 443)]));
    const before = await read((tx) => tx.select().from(assetsTable));
    expect(before).toHaveLength(2);

    await read((tx) => tx.update(collectionSchedulesTable).set({ nextRunAt: new Date(Date.now() - 1000) }));
    const result = await runDueSchedules(harness!.scope, ORG, deps(async () => [unreachable(HOST, 443)]));

    expect(result.executed[0].status).toBe("no_evidence");
    expect(result.executed[0].collectionRunId).toBeNull();
    expect(result.executed[0].assetsMarkedGone).toBe(0);

    // A firewall rule, a restart or a dropped packet is not evidence that
    // RSA-2048 stopped being served there. Both assets stay active with no
    // transition stamped, so `GET /api/drift` has nothing to report as gone.
    const after = await read((tx) => tx.select().from(assetsTable));
    expect(after.every((a) => a.status === "active")).toBe(true);
    expect(after.every((a) => a.statusChangedAt === null)).toBe(true);

    // Still exactly one collection run — the second attempt examined nothing,
    // so recording one would make the D3 meter claim the tls surface was
    // examined and found empty.
    const runs = await read((tx) => tx.select().from(collectionRunsTable));
    expect(runs).toHaveLength(1);

    // But the attempt itself IS on the record. Without this row a week of
    // unreachable hosts is indistinguishable from a quiet week.
    const attempts = await read((tx) => tx.select().from(collectionScheduleRunsTable));
    expect(attempts.map((a) => a.status)).toEqual(["succeeded", "no_evidence"]);
    expect(attempts[1].targetsAttempted).toBe(1);
    expect(attempts[1].targetsObserved).toBe(0);
  });

  it("does not advance lastSucceededAt for an attempt that observed nothing, so the gap since real evidence stays visible", async () => {
    await start();
    const { scheduleId } = await seed([{ host: HOST, port: 443 }]);

    await runDueSchedules(harness!.scope, ORG, deps(async () => [probed(HOST, 443)]));
    const [afterSuccess] = await read((tx) =>
      tx.select().from(collectionSchedulesTable).where(eq(collectionSchedulesTable.id, scheduleId)),
    );

    await read((tx) => tx.update(collectionSchedulesTable).set({ nextRunAt: new Date(Date.now() - 1000) }));
    await runDueSchedules(harness!.scope, ORG, deps(async () => [unreachable(HOST, 443)]));

    const [afterFailure] = await read((tx) =>
      tx.select().from(collectionSchedulesTable).where(eq(collectionSchedulesTable.id, scheduleId)),
    );
    expect(afterFailure.lastRunAt!.getTime()).toBeGreaterThanOrEqual(afterSuccess.lastRunAt!.getTime());
    expect(afterFailure.lastSucceededAt!.getTime()).toBe(afterSuccess.lastSucceededAt!.getTime());
  });

  it("marks gone only the targets that were actually reached and did not serve it — a partial outage reconciles nothing", async () => {
    await start();
    await seed([
      { host: HOST, port: 443 },
      { host: OTHER_HOST, port: 443 },
    ]);

    await runDueSchedules(
      harness!.scope,
      ORG,
      deps(async () => [probed(HOST, 443), probed(OTHER_HOST, 443)]),
    );
    expect(await read((tx) => tx.select().from(assetsTable))).toHaveLength(4);

    // One host answers, one has gone silent. Only the silent host's crypto is
    // at risk of a false remediation, and it must not happen.
    await read((tx) => tx.update(collectionSchedulesTable).set({ nextRunAt: new Date(Date.now() - 1000) }));
    const result = await runDueSchedules(
      harness!.scope,
      ORG,
      deps(async () => [probed(HOST, 443), unreachable(OTHER_HOST, 443)]),
    );

    expect(result.executed[0].status).toBe("succeeded");
    expect(result.executed[0].targetsObserved).toBe(1);
    expect(result.executed[0].assetsMarkedGone).toBe(0);

    const assets = await read((tx) => tx.select().from(assetsTable));
    expect(assets.every((a) => a.status === "active")).toBe(true);
  });

  it("records a failed attempt when the probe itself throws, and carries on", async () => {
    await start();
    await seed([{ host: HOST, port: 443 }]);

    const result = await runDueSchedules(
      harness!.scope,
      ORG,
      deps(async () => {
        throw new Error("resolver exploded");
      }),
    );

    expect(result.executed[0].status).toBe("failed");
    expect(result.executed[0].error).toContain("resolver exploded");

    // This assertion used to read `toHaveLength(0)`, and it was pinning a
    // defect rather than a decision: `collection_runs` had exactly one
    // production writer and it hardcoded `status: "completed"`, so a failed
    // collection had nowhere to be written at all. `coverage.ts` carried a
    // `failed` branch that no execution could reach.
    const runs = await read((tx) => tx.select().from(collectionRunsTable));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    // Zero, and it matters: the count is what the run observed, and a run that
    // crashed observed nothing.
    expect(runs[0].observationCount).toBe(0);

    // The reason the row exists. A failed attempt is not coverage — it must
    // count as an attempt without ever making the surface look examined.
    const coverage = summariseProjectCoverage({
      runs: runs.map((r) => ({
        surface: r.surface,
        status: r.status,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
      })),
      assets: [],
      observations: [],
    });
    const tls = coverage.surfaces.find((s) => s.surface === "tls");
    expect(tls?.failedRuns).toBe(1);
    expect(tls?.completedRuns).toBe(0);
    expect(tls?.state).not.toBe("examined");

    // Still nothing reconciled. A crash saw no target, so it may not decide
    // any asset is gone — the failure this stays separate from `ingest` for.
    expect(await read((tx) => tx.select().from(assetsTable))).toHaveLength(0);

    const attempts = await read((tx) => tx.select().from(collectionScheduleRunsTable));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("failed");
  });

  it("does not execute a disabled schedule, however far past due it is", async () => {
    await start();
    await seed([{ host: HOST, port: 443 }]);
    await read((tx) =>
      tx.update(collectionSchedulesTable).set({ enabled: false, nextRunAt: new Date("2020-01-01T00:00:00Z") }),
    );

    let probeCalls = 0;
    const result = await runDueSchedules(
      harness!.scope,
      ORG,
      deps(async () => {
        probeCalls += 1;
        return [];
      }),
    );

    expect(result.due).toBe(0);
    expect(probeCalls).toBe(0);
  });

  it("does not execute a schedule that is not yet due", async () => {
    await start();
    await seed([{ host: HOST, port: 443 }]);
    await read((tx) => tx.update(collectionSchedulesTable).set({ nextRunAt: new Date(Date.now() + 60 * 60_000) }));

    const result = await runDueSchedules(harness!.scope, ORG, deps(async () => [probed(HOST, 443)]));
    expect(result.due).toBe(0);
    expect(result.executed).toEqual([]);
  });

  it("does mark an asset gone when the host is reached and genuinely no longer serves it — the feed is not vacuously empty", async () => {
    await start();
    await seed([{ host: HOST, port: 443 }]);

    await runDueSchedules(harness!.scope, ORG, deps(async () => [probed(HOST, 443)]));
    const [rsaBefore] = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.algorithm, "RSA")));
    expect(rsaBefore.keySize).toBe(2048);

    // The host answers, and now presents an EC certificate. `RSA` at that
    // host:port is a distinct fingerprint from `ECDSA` (fingerprint.ts's `tls`
    // variant is repo + host + port + algorithm), so the RSA asset genuinely
    // was not observed by a run that DID reach the host — the one case where
    // an absence is real. Without this test the suite would pass with a runner
    // that could never mark anything gone at all.
    await read((tx) => tx.update(collectionSchedulesTable).set({ nextRunAt: new Date(Date.now() - 1000) }));
    const result = await runDueSchedules(
      harness!.scope,
      ORG,
      deps(async () => [
        {
          host: HOST,
          port: 443,
          outcome: "probed",
          handshake: {
            ...handshake(HOST, 443, 2048),
            peerCertificatePublicKey: { keyType: "ec", namedCurve: "prime256v1" },
          },
        },
      ]),
    );

    expect(result.executed[0].status).toBe("succeeded");
    expect(result.executed[0].assetsMarkedGone).toBe(1);

    const [rsaAfter] = await read((tx) => tx.select().from(assetsTable).where(eq(assetsTable.id, rsaBefore.id)));
    expect(rsaAfter.status).toBe("gone");
    expect(rsaAfter.statusChangedByRunId).toBe(result.executed[0].collectionRunId);
    // And it is the run that ran, not an unexplained flip.
    expect(rsaAfter.statusChangedByRunId).not.toBeNull();
  });
});
