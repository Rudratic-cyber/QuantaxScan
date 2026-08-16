/**
 * B6 — the protocol-configuration collector, end to end against the real
 * stack: real Postgres, real API server, real row-level security. No
 * `page.route` appears in this file; every assertion is against the real HTTP
 * response from the real server (`tests/e2e/support/fixtures.ts`'s one rule).
 *
 * The configuration files below are written inline rather than committed as
 * fixtures because they are the *input under test*: what makes each assertion
 * meaningful is the exact directive, and a reader should not have to open
 * another file to see which line produced which finding. No key material is
 * real — the `authorized_keys` blobs are placeholder base64 that this
 * collector deliberately never decodes.
 *
 * The three states this suite exists to keep apart, which no other spec
 * covers, are one per project:
 *
 *   1. a recognised file that declares crypto → run + assets;
 *   2. a recognised file that declares none  → run, zero observations, and the
 *      coverage meter says `examined-nothing-found`;
 *   3. nothing recognised at all             → no run, and the config surface
 *      is absent from coverage entirely.
 *
 * Collapsing 2 into 3 would have the meter claim a surface was never looked at
 * when it was; collapsing 3 into 2 would claim it was looked at when nothing
 * readable was ever submitted. Both are the dishonesty D3 exists to prevent.
 */
import { test, expect } from "./support/fixtures";

interface ProtocolConfigDeclaration {
  path: string;
  format: string;
  directive: string;
  declaredValue: string;
  algorithm: string;
  keySize: number | null;
  strength: "permitted" | "materialised";
  condition: string | null;
  confidence: number;
}

interface ProtocolConfigIngestSummary {
  projectId: number;
  configFilesRecognised: number;
  configFiles: Array<{ path: string; format: string; declarationCount: number }>;
  collectionRunId: number | null;
  assetsCreated: number;
  assetsUpdated: number;
  observationsCreated: number;
  assetsMarkedGone: number;
  declarations: ProtocolConfigDeclaration[];
  evidenceCaveat: string;
}

const SSHD_PATH = "etc/ssh/sshd_config";

/**
 * A realistic hardened `sshd_config`. Three things in here are load-bearing:
 * the commented-out default (which must NOT be read), the hybrid post-quantum
 * key exchange OpenSSH now ships (which must NOT be reported as classical
 * ECDH), and the `Match` block (whose condition must travel with the finding).
 */
const HARDENED_SSHD = `# Managed by configuration management — do not edit by hand
Port 22
#Ciphers aes128-cbc,3des-cbc
HostKeyAlgorithms ssh-ed25519,rsa-sha2-512
KexAlgorithms sntrup761x25519-sha512@openssh.com,ecdh-sha2-nistp384
Ciphers aes256-ctr,aes128-ctr
MACs hmac-sha2-256,hmac-sha1

Match Address 10.0.0.0/8
    PubkeyAcceptedAlgorithms ssh-rsa
`;

async function createProject(api: import("@playwright/test").APIRequestContext, name: string): Promise<number> {
  const res = await api.post("/api/projects", { data: { name, language: "python", code: "" } });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { id: number };
  return body.id;
}

async function submit(
  api: import("@playwright/test").APIRequestContext,
  projectId: number,
  files: Array<{ path: string; content: string }>,
): Promise<ProtocolConfigIngestSummary> {
  const res = await api.post(`/api/projects/${projectId}/protocol-config`, { data: { files } });
  expect(res.status()).toBe(200);
  return (await res.json()) as ProtocolConfigIngestSummary;
}

test.describe("the protocol-configuration collector (B6), end to end", () => {
  test("reads what SSH, IPsec and JOSE configuration declares, and persists it as config assets", async ({ api }) => {
    const projectId = await createProject(api, "protocol-config-e2e");

    // A 2048-bit modulus is 256 bytes of base64url — the one key size in this
    // submission that is genuinely readable off the file.
    const modulus = Buffer.alloc(256, 0xab).toString("base64url");

    const body = await submit(api, projectId, [
      { path: SSHD_PATH, content: HARDENED_SSHD },
      { path: "home/deploy/.ssh/authorized_keys", content: "no-pty ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 deploy@host\n" },
      { path: "etc/ipsec.conf", content: "conn site-to-site\n  ike=aes256-sha256-modp2048!\n" },
      { path: "well-known/jwks.json", content: JSON.stringify({ keys: [{ kty: "RSA", alg: "RS256", n: modulus, e: "AQAB" }] }) },
      { path: "README.md", content: "Prose that mentions sshd_config but is not one." },
    ]);

    expect(body.configFilesRecognised).toBe(4);
    expect(body.collectionRunId).not.toBeNull();
    expect(body.evidenceCaveat.length).toBeGreaterThan(0);
    // The README is not a configuration and is absent, not an empty entry.
    expect(body.configFiles.map((f) => f.path)).not.toContain("README.md");

    const declaration = (directive: string, token: string): ProtocolConfigDeclaration | undefined =>
      body.declarations.find((d) => d.directive === directive && d.declaredValue === token);

    // ── The commented-out default is documentation, not a declaration. A stock
    // sshd_config is almost entirely these lines; reading them would turn every
    // untouched OpenSSH install into findings the administrator never made.
    expect(body.declarations.some((d) => d.declaredValue === "aes128-cbc")).toBe(false);

    // ── The assertion this whole collector's token matching exists for. Modern
    // OpenSSH offers hybrid post-quantum key exchange by default; reporting it
    // as classical `ECDH` would be a false positive on the exact axis this
    // product measures, so it is absent rather than wrong.
    expect(body.declarations.some((d) => d.declaredValue.includes("sntrup761"))).toBe(false);
    // ...while the classical entry on the same line IS read, which is what
    // proves the line was parsed rather than skipped wholesale.
    expect(declaration("KexAlgorithms", "ecdh-sha2-nistp384")).toMatchObject({ algorithm: "ECDH", keySize: 384 });

    // ── Two ciphers from one directive stay two findings with their own sizes.
    expect(declaration("Ciphers", "aes256-ctr")).toMatchObject({ algorithm: "AES", keySize: 256 });
    expect(declaration("Ciphers", "aes128-ctr")).toMatchObject({ algorithm: "AES", keySize: 128 });

    // ── A conditional directive carries its condition rather than reading as a
    // global declaration.
    expect(declaration("PubkeyAcceptedAlgorithms", "ssh-rsa")).toMatchObject({
      algorithm: "RSA",
      condition: "Match Address 10.0.0.0/8",
      // No modulus is stated and the blob is not decoded — undetermined, not
      // a guessed default (G-05).
      keySize: null,
    });
    expect(declaration("HostKeyAlgorithms", "ssh-ed25519")?.condition).toBeNull();

    // ── The other three formats.
    expect(declaration("ike", "modp2048")).toMatchObject({ algorithm: "DH", keySize: 2048, format: "ipsec-config" });
    expect(declaration("alg", "RS256")).toMatchObject({ algorithm: "RSA", keySize: 2048, strength: "materialised" });

    // ── A permitted list and a materialised key are different claims, and the
    // confidence reflects that. Neither approaches an observed handshake's 1.0.
    const permitted = declaration("Ciphers", "aes256-ctr")!;
    const materialised = body.declarations.find((d) => d.directive === "authorized_keys")!;
    expect(materialised).toMatchObject({ algorithm: "EdDSA", keySize: 256, strength: "materialised" });
    expect(permitted.strength).toBe("permitted");
    expect(permitted.confidence).toBeLessThan(materialised.confidence);
    expect(materialised.confidence).toBeLessThan(1);

    // ── Persisted, not just reported. This is the bar `surface-catalogue.ts`
    // requires before a surface may say `live`.
    expect(body.assetsCreated).toBe(body.declarations.length);

    const coverageRes = await api.get(`/api/projects/${projectId}/coverage`);
    expect(coverageRes.status()).toBe(200);
    const coverage = (await coverageRes.json()) as { surfaces: Array<{ surface: string; state: string }> };
    const configSurface = coverage.surfaces.find((s) => s.surface === "config");
    expect(configSurface, "config surface absent from coverage — the collector ran but coverage did not see it").toBeTruthy();
    expect(configSurface!.state).toBe("examined");

    // ── The estate inventory read a caller who was not watching the upload
    // gets later, filtered server-side to this surface.
    const inventoryRes = await api.get("/api/inventory/assets?surface=config");
    expect(inventoryRes.status()).toBe(200);
    const inventory = (await inventoryRes.json()) as { assets: Array<{ surface: string; algorithm: string; location: string; latestConfidence: number | null }> };
    const mine = inventory.assets.filter((a) => a.location.startsWith(`project:${projectId}:config:`));
    expect(mine.length).toBe(body.declarations.length);
    expect(mine.every((a) => a.surface === "config")).toBe(true);
    // `SHA-1` is in here because `MACs hmac-sha1` really does declare it — the
    // hygiene half of the estate, which the mappings data separates from the
    // post-quantum track rather than this collector doing so.
    expect(new Set(mine.map((a) => a.algorithm))).toEqual(new Set(["AES", "DH", "ECDH", "RSA", "EdDSA", "SHA-1"]));
    expect(mine.every((a) => a.latestConfidence !== null && a.latestConfidence < 1)).toBe(true);
  });

  test("removing a directive and resubmitting marks that declaration gone, and leaves the rest alone", async ({ api }) => {
    const projectId = await createProject(api, "protocol-config-e2e-lifecycle");

    const first = await submit(api, projectId, [
      { path: SSHD_PATH, content: "HostKeyAlgorithms ssh-rsa,ssh-ed25519\n" },
      { path: "etc/ipsec.conf", content: "conn site\n  ike=aes256-modp2048\n" },
    ]);
    expect(first.assetsCreated).toBe(4);

    // The administrator drops RSA host keys. Only the ssh file is resubmitted.
    const second = await submit(api, projectId, [{ path: SSHD_PATH, content: "HostKeyAlgorithms ssh-ed25519\n" }]);
    expect(second.assetsMarkedGone).toBe(1);
    expect(second.assetsUpdated).toBe(1);

    // `GET /inventory/assets` returns present assets only, so the removed
    // declaration is gone from it while the IPsec declarations — which this
    // submission said nothing about — are untouched. A run that marked those
    // gone would be a silent false remediation.
    const inventoryRes = await api.get("/api/inventory/assets?surface=config");
    const inventory = (await inventoryRes.json()) as { assets: Array<{ algorithm: string; location: string }> };
    const mine = inventory.assets.filter((a) => a.location.startsWith(`project:${projectId}:config:`));
    expect(mine.map((a) => a.algorithm).sort()).toEqual(["AES", "ECDH", "EdDSA"]);

    // Emptying the file of algorithm directives entirely still retires the
    // last one — the case a reobservation scope derived from observations
    // rather than from the files read would silently miss.
    const third = await submit(api, projectId, [{ path: SSHD_PATH, content: "Port 2222\n" }]);
    expect(third.observationsCreated).toBe(0);
    expect(third.assetsMarkedGone).toBe(1);
    expect(third.collectionRunId).not.toBeNull();
  });

  test("a readable config that declares no crypto is examined-and-found-nothing, not un-examined", async ({ api }) => {
    const projectId = await createProject(api, "protocol-config-e2e-empty-config");

    const body = await submit(api, projectId, [{ path: SSHD_PATH, content: "Port 2222\nPermitRootLogin no\n" }]);
    expect(body.configFilesRecognised).toBe(1);
    expect(body.configFiles).toEqual([{ path: SSHD_PATH, format: "sshd-config", declarationCount: 0 }]);
    expect(body.observationsCreated).toBe(0);
    // A run WAS recorded: the file was read and it configures no crypto, which
    // is a real answer and not the same as never having looked.
    expect(body.collectionRunId).not.toBeNull();

    const coverageRes = await api.get(`/api/projects/${projectId}/coverage`);
    const coverage = (await coverageRes.json()) as { surfaces: Array<{ surface: string; state: string }> };
    expect(coverage.surfaces.find((s) => s.surface === "config")?.state).toBe("examined-nothing-found");
  });

  test("a submission with no recognisable configuration examines nothing — no run is recorded", async ({ api }) => {
    const projectId = await createProject(api, "protocol-config-e2e-unrecognised");

    const body = await submit(api, projectId, [
      { path: "README.md", content: "prose about ssh_config and JWT signing" },
      { path: "package.json", content: '{"name":"app","dependencies":{}}' },
    ]);
    expect(body.configFilesRecognised).toBe(0);
    expect(body.collectionRunId).toBeNull();
    expect(body.declarations).toEqual([]);

    // Un-examined, not examined-and-empty — the other side of the distinction
    // the previous test asserts.
    const coverageRes = await api.get(`/api/projects/${projectId}/coverage`);
    const coverage = (await coverageRes.json()) as { surfaces: Array<{ surface: string }> };
    expect(coverage.surfaces.find((s) => s.surface === "config")).toBeUndefined();
  });

  test("an unauthenticated caller is refused, not silently given an empty result", async ({ publicApi, api }) => {
    const projectId = await createProject(api, "protocol-config-e2e-auth");
    const res = await publicApi.post(`/api/projects/${projectId}/protocol-config`, { data: { files: [] } });
    expect(res.status()).toBe(401);
  });

  test("naming a project id that does not exist is 404, not a silently empty result", async ({ api }) => {
    const res = await api.post("/api/projects/999999999/protocol-config", {
      data: { files: [{ path: SSHD_PATH, content: "HostKeyAlgorithms ssh-rsa\n" }] },
    });
    expect(res.status()).toBe(404);
  });
});
