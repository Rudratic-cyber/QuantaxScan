/**
 * B4 — the certificate collector, end to end against the real stack: real
 * Postgres, real API server, real row-level security. This is what proves
 * the M2 exit criterion (docs/Claude/02-roadmap.md): "Certificate inventory
 * shows which certs outlive the conservative Q-Day scenario."
 *
 * Certificates are generated at test time with the system `openssl` binary
 * and never committed — see `tests/e2e/support/fixtures.ts`'s "no fixture
 * fabricates a response" rule; committing key material would be the input-
 * data equivalent of that sin. No `page.route` appears in this file: every
 * assertion below is against the real HTTP response from the real server.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./support/fixtures";

interface CertificateQDayVerdict {
  scenario: "conservative" | "central" | "aggressive";
  qDayYear: number;
  outlivesQDay: boolean;
}

interface CertificateIngestEntry {
  location: string;
  algorithm: string;
  keySize: number | null;
  issuer: string;
  serialNumber: string;
  subject: string | null;
  notBefore: string;
  notAfter: string;
  signatureAlgorithm: string | null;
  qDay: CertificateQDayVerdict[];
}

function generateSelfSignedCertPem(cn: string, days: number): string {
  const dir = mkdtempSync(join(tmpdir(), "qx-e2e-cert-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath,
        "-days", String(days), "-nodes", "-subj", `/CN=${cn}`,
      ],
      { stdio: "pipe" },
    );
    return readFileSync(certPath, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function createProject(api: import("@playwright/test").APIRequestContext, name: string): Promise<number> {
  const res = await api.post("/api/projects", { data: { name, language: "python", code: "" } });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { id: number };
  return body.id;
}

test.describe("the certificate collector (B4), end to end", () => {
  test("a certificate outliving the conservative Q-Day scenario is flagged, at ingest time and in the persisted inventory", async ({ api }) => {
    // ~25 years, which clears the *latest* scenario year with room to spare
    // without this test naming any of those years itself. The margin matters:
    // ~10 years was the first attempt and it is not enough — such a cert
    // outlives the two earlier scenarios and expires before the last one, so
    // "outlives every scenario" was false for a correct implementation.
    const longLivedCn = "long-lived.qx-e2e.invalid";
    const shortLivedCn = "short-lived.qx-e2e.invalid";
    const longLivedCert = generateSelfSignedCertPem(longLivedCn, 9125);
    const shortLivedCert = generateSelfSignedCertPem(shortLivedCn, 30);

    const projectId = await createProject(api, "cert-e2e-project");

    const res = await api.post(`/api/projects/${projectId}/certificates`, {
      data: {
        files: [
          { path: "long.pem", content: longLivedCert },
          { path: "short.pem", content: shortLivedCert },
        ],
      },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      certificatesRecognised: number;
      certificateFiles: Array<{ path: string; certificateCount: number }>;
      collectionRunId: number | null;
      assetsCreated: number;
      certificates: CertificateIngestEntry[];
      evidenceCaveat: string;
    };

    expect(body.certificatesRecognised).toBe(2);
    expect(body.certificateFiles).toEqual(
      expect.arrayContaining([
        { path: "long.pem", certificateCount: 1 },
        { path: "short.pem", certificateCount: 1 },
      ]),
    );
    expect(body.collectionRunId).not.toBeNull();
    expect(body.assetsCreated).toBe(2);
    expect(body.evidenceCaveat.length).toBeGreaterThan(0);

    const long = body.certificates.find((c) => c.subject?.includes(longLivedCn));
    const short = body.certificates.find((c) => c.subject?.includes(shortLivedCn));
    expect(long, "long-lived certificate missing from response").toBeTruthy();
    expect(short, "short-lived certificate missing from response").toBeTruthy();
    expect(long!.algorithm).toBe("RSA");
    expect(long!.keySize).toBe(2048);

    // The chart this feature exists to draw: the long-lived cert outlives
    // every Q-Day scenario — including the latest one, which is the hardest to
    // outlive, since a certificate has to survive *past* the Q-Day year to
    // count — and the short-lived one outlives none of them. Asserted without
    // this test naming a single scenario year.
    for (const verdict of long!.qDay) {
      expect(verdict.outlivesQDay, `long-lived cert should outlive the ${verdict.scenario} scenario`).toBe(true);
    }
    for (const verdict of short!.qDay) {
      expect(verdict.outlivesQDay, `short-lived cert should NOT outlive the ${verdict.scenario} scenario`).toBe(false);
    }
    // Scenario years strictly increase conservative -> central -> aggressive,
    // read from the response rather than hardcoded, so this test also proves
    // the endpoint isn't returning a single hardcoded verdict for all three.
    const years = long!.qDay.map((v) => v.qDayYear);
    expect(years).toEqual(["conservative", "central", "aggressive"].map((name) => long!.qDay.find((v) => v.scenario === name)!.qDayYear));
    expect(years[0]).toBeLessThan(years[1]);
    expect(years[1]).toBeLessThan(years[2]);

    // The actual "inventory shows" read — not the POST response, which is
    // ingest-time telemetry. This is what a caller who was not watching the
    // upload sees later.
    const inventoryRes = await api.get(`/api/projects/${projectId}/certificates`);
    expect(inventoryRes.status()).toBe(200);
    const inventory = (await inventoryRes.json()) as {
      projectId: number;
      certificates: Array<{ assetId: number; status: string; subject: string | null; qDay: CertificateQDayVerdict[] }>;
    };
    expect(inventory.projectId).toBe(projectId);
    expect(inventory.certificates).toHaveLength(2);

    const persistedLong = inventory.certificates.find((c) => c.subject?.includes(longLivedCn));
    expect(persistedLong).toBeTruthy();
    expect(persistedLong!.status).toBe("active");
    expect(persistedLong!.qDay.find((v) => v.scenario === "conservative")!.outlivesQDay).toBe(true);

    // The certificate surface now counts as examined for this project's D3
    // coverage meter — the ingest actually persisted, which is the same bar
    // `surface-catalogue.ts` requires before a surface may say `live`.
    const coverageRes = await api.get(`/api/projects/${projectId}/coverage`);
    expect(coverageRes.status()).toBe(200);
    const coverage = (await coverageRes.json()) as { surfaces: Array<{ surface: string; state: string }> };
    const certSurface = coverage.surfaces.find((s) => s.surface === "certificate");
    expect(certSurface, "certificate surface absent from coverage — the collector ran but coverage did not see it").toBeTruthy();
    expect(certSurface!.state).not.toBe("never-examined");
  });

  test("a submission with no certificate content examines nothing — no run is recorded, not a run that found zero", async ({ api }) => {
    const projectId = await createProject(api, "cert-e2e-empty");

    const res = await api.post(`/api/projects/${projectId}/certificates`, {
      data: { files: [{ path: "readme.md", content: "not a certificate, just prose" }] },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { certificatesRecognised: number; collectionRunId: number | null; certificates: unknown[] };
    expect(body.certificatesRecognised).toBe(0);
    expect(body.collectionRunId).toBeNull();
    expect(body.certificates).toEqual([]);

    // Un-examined, not examined-and-empty: the D3 honesty distinction this
    // whole "don't write a run" branch exists to preserve.
    const coverageRes = await api.get(`/api/projects/${projectId}/coverage`);
    const coverage = (await coverageRes.json()) as { surfaces: Array<{ surface: string }> };
    expect(coverage.surfaces.find((s) => s.surface === "certificate")).toBeUndefined();
  });

  test("reads every certificate in a submitted chain, not just the leaf", async ({ api }) => {
    const leafCn = "leaf.qx-e2e.invalid";
    const intermediateCn = "intermediate.qx-e2e.invalid";
    const leaf = generateSelfSignedCertPem(leafCn, 365);
    const intermediate = generateSelfSignedCertPem(intermediateCn, 365);

    const projectId = await createProject(api, "cert-e2e-chain");
    const res = await api.post(`/api/projects/${projectId}/certificates`, {
      data: { files: [{ path: "chain.pem", content: leaf + intermediate }] },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { certificatesRecognised: number; certificates: CertificateIngestEntry[] };
    expect(body.certificatesRecognised).toBe(2);
    expect(body.certificates.some((c) => c.subject?.includes(leafCn))).toBe(true);
    expect(body.certificates.some((c) => c.subject?.includes(intermediateCn))).toBe(true);
  });

  test("an unauthenticated caller is refused, not shown an empty inventory", async ({ publicApi, api }) => {
    const projectId = await createProject(api, "cert-e2e-auth");

    const postRes = await publicApi.post(`/api/projects/${projectId}/certificates`, { data: { files: [] } });
    expect(postRes.status()).toBe(401);

    const getRes = await publicApi.get(`/api/projects/${projectId}/certificates`);
    expect(getRes.status()).toBe(401);
  });

  test("naming a project id that does not exist is 404, not a silently empty result", async ({ api }) => {
    const cert = generateSelfSignedCertPem("nonexistent-project.qx-e2e.invalid", 30);
    const res = await api.post("/api/projects/999999999/certificates", { data: { files: [{ path: "c.pem", content: cert }] } });
    expect(res.status()).toBe(404);

    const getRes = await api.get("/api/projects/999999999/certificates");
    expect(getRes.status()).toBe(404);
  });
});

/**
 * G-22 — the same certificates, counted estate-wide on the posture timeline.
 *
 * The per-project route already answered "does this certificate outlive Q-Day?"
 * The timeline is where a CISO reads it for the whole estate, and until this
 * change it told them no certificate collector had shipped. This proves the
 * number is real: certificates generated by `openssl` here, submitted through
 * the real route, persisted as assets, and read back through
 * `GET /api/inventory/timeline`.
 */
test.describe("G-22 — certificates counted against Q-Day estate-wide", () => {
  interface CertificateExpiryOutlook {
    certificates: number;
    withKnownExpiry: number;
    undetermined: number;
    perScenario: Array<{
      scenario: string;
      qDayYear: number;
      outlivesQDay: number;
      expiresBeforeQDay: number;
      undetermined: number;
    }>;
    caveat: string;
  }

  test("a long-lived certificate reaches the estate timeline as outliving Q-Day", async ({ api }) => {
    const before = (await (await api.get("/api/inventory/timeline")).json()) as {
      certificateExpiry: CertificateExpiryOutlook;
    };

    const projectId = await createProject(api, `cert-timeline-${Date.now()}`);
    // Same reasoning as the ingest test above: ~25 years clears the latest
    // scenario year, so "outlives every scenario" is true without this spec
    // naming a single year of its own.
    const longLived = generateSelfSignedCertPem(`timeline-long.${Date.now()}.qx-e2e.invalid`, 9125);
    const shortLived = generateSelfSignedCertPem(`timeline-short.${Date.now()}.qx-e2e.invalid`, 30);

    const submitted = await api.post(`/api/projects/${projectId}/certificates`, {
      data: {
        files: [
          { path: "long.pem", content: longLived },
          { path: "short.pem", content: shortLived },
        ],
      },
    });
    expect(submitted.status()).toBe(200);

    const after = (await (await api.get("/api/inventory/timeline")).json()) as {
      certificateExpiry: CertificateExpiryOutlook;
      notCollected: Array<{ id: string }>;
    };
    const outlook = after.certificateExpiry;

    // Two more certificates than before, and both datable — `notAfter` comes
    // off a real X.509 structure, so nothing here should be undetermined.
    expect(outlook.certificates).toBe(before.certificateExpiry.certificates + 2);
    expect(outlook.withKnownExpiry).toBe(before.certificateExpiry.withKnownExpiry + 2);
    expect(outlook.undetermined).toBe(before.certificateExpiry.undetermined);

    // One row per scenario, and every row's buckets account for every datable
    // certificate — a count that does not sum is a count with a silent drop.
    expect(outlook.perScenario.length).toBeGreaterThan(0);
    for (const row of outlook.perScenario) {
      expect(row.outlivesQDay + row.expiresBeforeQDay).toBe(outlook.withKnownExpiry);
      expect(row.undetermined).toBe(outlook.undetermined);
      // The 25-year certificate outlives every scenario, so each row must have
      // gained at least one.
      const previous = before.certificateExpiry.perScenario.find((r) => r.scenario === row.scenario);
      expect(row.outlivesQDay).toBeGreaterThanOrEqual((previous?.outlivesQDay ?? 0) + 1);
    }

    // And the refusal this replaced is gone from the payload rather than left
    // beside a working figure that contradicts it.
    expect(after.notCollected.map((n) => n.id)).not.toContain("certificate-expiry");
    expect(outlook.caveat).toMatch(/never as expiring safely/i);
  });
});
