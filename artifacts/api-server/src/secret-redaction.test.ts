import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import supertest from "supertest";
import { randomBytes } from "node:crypto";

/**
 * F4 — redaction at the boundary.
 *
 * **What makes this suite worth anything.** A test that greps a JSON response
 * for a secret passes trivially, because nothing ever put it there. So this
 * file does four harder things:
 *
 *   1. It **captures the real logger's output stream** — the actual pino
 *      instance the routes call, built from the actual configuration in
 *      `lib/logger.ts` — across registration, listing, revocation and an
 *      *induced failure*, and greps every line. Error paths are where secrets
 *      leak; the happy path proves little.
 *   2. It **sweeps every text-ish column of every table** for the plaintext
 *      after a registration, rather than checking the columns it happens to
 *      know about.
 *   3. It pairs every ephemeral assertion with a **retained positive**. Without
 *      that pair, "the ephemeral scan stored no source" also passes when the
 *      write path is broken for both modes, which would be a green suite over
 *      a product that silently stopped recording evidence. That pair is the
 *      negative control of this lane.
 *   4. It asserts a **bad `retentionMode` is refused**, not quietly treated as
 *      ephemeral or as retained — a typo must never be able to promise a
 *      customer something the code then does not do.
 */

const API_KEY = "test-api-key-1234567890-super-secret-key-32bytes";

/** The registered credential. Long, unique and greppable — a real AWS key shape would be shorter and likelier to collide. */
const CREDENTIAL_SECRET = "qx-credential-plaintext-8f4e2a9c7b1d6e3f0a5c-NEVER-LOG-ME";
/** A secret embedded in submitted source, for the ephemeral half. */
const SOURCE_SECRET = "qx-source-body-marker-5d3b8e1f9a2c4d7e6b0f-NEVER-PERSIST";

const { testDb, testScope, closeTestDb, seedAsSuperuser, logLines } = await vi.hoisted(async () => {
  process.env.QUANTAXSCAN_API_KEYS = "test-api-key-1234567890-super-secret-key-32bytes";
  process.env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";
  process.env.QUANTAXSCAN_API_KEY_ORG_ID = "1";
  // Explicit rather than inherited: vitest isolates modules but not
  // `process.env`, and another suite in this project sets this to "2".
  delete process.env.QUANTAXSCAN_API_KEY_ORG_IDS;
  const { randomBytes: rb } = await import("node:crypto");
  process.env.QUANTAXSCAN_CREDENTIAL_KEYS = `ka:${rb(32).toString("base64")}`;
  const { createTestDb } = await import("@workspace/db/test-support");
  const { db, scope, close, seedAsSuperuser: asSuperuser } = await createTestDb({ asRole: "quantaxscan_app" });
  return { testDb: db, testScope: scope, closeTestDb: close, seedAsSuperuser: asSuperuser, logLines: [] as string[] };
});

vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  return { db: testDb, pool: {}, ...testScope, ...schema };
});

/**
 * The real logger configuration, over a stream this test can read.
 *
 * Not a stub: `loggerOptions` is the exact object `lib/logger.ts` builds its
 * production instance from, including the `redact` list. Only the pino-pretty
 * transport is dropped, because it runs in a worker thread and cannot write to
 * an in-process buffer. So this asserts on what the deployment's logger really
 * emits for these routes, and on what the route code really passes it.
 */
vi.mock("./lib/logger", async () => {
  const actual = await vi.importActual<typeof import("./lib/logger")>("./lib/logger");
  const { default: pino } = await import("pino");
  return {
    ...actual,
    logger: pino({ ...actual.loggerOptions, level: "trace" }, { write: (line: string) => void logLines.push(line) }),
  };
});

import { EPHEMERAL_SNIPPET_MARKER } from "@workspace/db/schema";
import app from "./app";

const request = supertest(app);
const auth = <T extends { set: (k: string, v: string) => T }>(r: T): T => r.set("X-API-Key", API_KEY);

/** Every string a response, its headers and the captured log stream contain, for one grep. */
function everythingLogged(): string {
  return logLines.join("\n");
}

/**
 * Grep every text-ish column of every table for a literal.
 *
 * Column-driven rather than table-driven so it keeps working as the schema
 * grows — a future "credential fingerprint" column is swept without anyone
 * remembering to add it here.
 *
 * Runs through `seedAsSuperuser`, i.e. the one connection in this harness that
 * bypasses row-level security. That is deliberate and is the opposite of the
 * usual rule: an RLS-scoped sweep would report a clean database simply because
 * it could not see the rows, which is precisely the vacuous pass this file
 * exists to avoid. The claim being made is "the plaintext is in NO row", and
 * only an unscoped reader can make it.
 */
async function columnsContaining(needle: string): Promise<string[]> {
  const hits: string[] = [];
  await seedAsSuperuser(async (client) => {
    const columns = await client.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = 'public'
          and data_type in ('text', 'character varying', 'json', 'jsonb')`,
    );
    for (const column of columns.rows) {
      const rows = await client.query<{ n: string }>(
        `select count(*)::text as n from "${column.table_name}" where "${column.column_name}"::text like $1`,
        [`%${needle}%`],
      );
      if (rows.rows[0]?.n !== "0") hits.push(`${column.table_name}.${column.column_name}`);
    }
  });
  return hits;
}

/** Read arbitrary rows past RLS, for the same reason as `columnsContaining`. */
async function readAsSuperuser<T>(query: string, params: unknown[] = []): Promise<T[]> {
  let rows: T[] = [];
  await seedAsSuperuser(async (client) => {
    rows = (await client.query<T>(query, params)).rows;
  });
  return rows;
}

let credentialId = 0;
let projectId = 0;

beforeAll(async () => {
  const project = await auth(request.post("/api/projects")).send({
    name: "redaction-fixture",
    language: "python",
    code: "import hashlib\n",
  });
  expect(project.status).toBe(201);
  projectId = project.body.id;
});

afterAll(async () => {
  delete process.env.QUANTAXSCAN_CREDENTIAL_KEYS;
  await closeTestDb();
});

describe("a registered credential never appears in a response, a log line or a column", () => {
  it("POST /api/credentials returns metadata and no secret", async () => {
    const res = await auth(request.post("/api/credentials")).send({
      name: "aws eu-west-1 kms",
      kind: "cloud_kms_readonly",
      secret: CREDENTIAL_SECRET,
      description: "read-only, account 1234",
    });

    expect(res.status).toBe(201);
    credentialId = res.body.id;
    expect(res.body.status).toBe("active");
    expect(res.body.keyId).toBe("ka");
    expect(res.body).not.toHaveProperty("secret");
    expect(res.body).not.toHaveProperty("ciphertext");
    expect(res.body).not.toHaveProperty("iv");
    expect(res.body).not.toHaveProperty("authTag");
    expect(res.text).not.toContain(CREDENTIAL_SECRET);
    expect(JSON.stringify(res.headers)).not.toContain(CREDENTIAL_SECRET);
  });

  it("GET /api/credentials lists it without the secret", async () => {
    const res = await auth(request.get("/api/credentials"));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("aws eu-west-1 kms");
    expect(res.text).not.toContain(CREDENTIAL_SECRET);
    for (const key of Object.keys(res.body[0])) {
      expect(["secret", "ciphertext", "iv", "authTag"]).not.toContain(key);
    }
  });

  it("the plaintext is in no text, varchar or jsonb column anywhere in the database", async () => {
    expect(await columnsContaining(CREDENTIAL_SECRET)).toEqual([]);

    // Control: the sweep can find things. Without it a broken query reports a
    // clean database forever.
    expect(await columnsContaining("read-only, account 1234")).toEqual(["credentials.description"]);
  });

  it("the stored ciphertext is not the plaintext in disguise", async () => {
    const rows = await readAsSuperuser<{ ciphertext: string; iv: string }>(
      "select ciphertext, iv from credentials where id = $1",
      [credentialId],
    );
    expect(rows[0].ciphertext).not.toContain(CREDENTIAL_SECRET);
    expect(Buffer.from(rows[0].ciphertext, "base64").toString("utf8")).not.toContain(CREDENTIAL_SECRET);
    expect(rows[0].iv.length).toBeGreaterThan(0);
  });

  it("an induced failure — a duplicate name — logs nothing containing the secret", async () => {
    // The error path is where a secret actually escapes: a rejected insert's
    // driver error carries the statement's bind parameters.
    const duplicate = await auth(request.post("/api/credentials")).send({
      name: "aws eu-west-1 kms",
      kind: "cloud_kms_readonly",
      secret: CREDENTIAL_SECRET,
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.text).not.toContain(CREDENTIAL_SECRET);
  });

  it("a rejected body does not echo the submitted secret back to the caller", async () => {
    // Every other route in this codebase returns `parsed.error.message`, which
    // zod builds from the rejected input. This one must not, and this is the
    // assertion that keeps it that way.
    const res = await auth(request.post("/api/credentials")).send({
      kind: "cloud_kms_readonly",
      secret: CREDENTIAL_SECRET,
    });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain(CREDENTIAL_SECRET);
  });

  it("the captured log stream — every line written by every request above — contains no secret", async () => {
    await auth(request.post(`/api/credentials/${credentialId}/revoke`));

    const logged = everythingLogged();
    // Control: the capture is actually wired up. A silent stream would make
    // every assertion in this test vacuous, which is precisely the shape of
    // mistake this whole file is about.
    expect(logged.length, "no log output was captured — the assertions below would be vacuous").toBeGreaterThan(0);
    expect(logged).toContain("credential registered");

    expect(logged).not.toContain(CREDENTIAL_SECRET);
  });

  it("revocation destroys the material and the credential can no longer be used", async () => {
    const res = await auth(request.get("/api/credentials"));
    expect(res.body[0].status).toBe("revoked");
    expect(res.body[0].keyId).toBeNull();

    const rows = await readAsSuperuser<{ ciphertext: string | null }>(
      "select ciphertext from credentials where id = $1",
      [credentialId],
    );
    expect(rows[0].ciphertext).toBeNull();
  });
});

describe("ephemeral retention — and the retained control that makes it mean something", () => {
  /**
   * The marker sits **inside the line the collector matches**, not in a comment
   * beside it. That is not cosmetic: `findings.code_snippet` and
   * `evidence.codeSnippet` are the matched line, so a marker on an adjacent
   * line would never be persisted in either mode and the database sweep below
   * would pass without proving anything. Verified by sabotage — with the
   * evidence stripping removed, the sweep goes red.
   */
  const vulnerableSource = (marker: string) =>
    `import hashlib\ndigest = hashlib.md5(b"${marker}").hexdigest()\nkey = rsa.generate_private_key(key_size=2048)\n`;

  let retainedScanId = 0;
  let ephemeralScanId = 0;

  it("a retained scan stores the source and the matched lines — the positive control", async () => {
    const res = await auth(request.post("/api/scans")).send({
      projectId,
      mode: "scan-only",
      language: "python",
      code: vulnerableSource(SOURCE_SECRET + "-RETAINED"),
    });

    expect(res.status).toBe(201);
    retainedScanId = res.body.id;
    expect(res.body.retentionMode).toBe("retained");
    expect(res.body.sourceDiscardedAt).toBeNull();

    const rows = await readAsSuperuser<{ code: string | null }>("select code from scans where id = $1", [
      retainedScanId,
    ]);
    // If this fails, the ephemeral assertion below proves nothing: it would be
    // passing because the write path is broken, not because it was suppressed.
    expect(rows[0].code).toContain(SOURCE_SECRET + "-RETAINED");
    expect(await columnsContaining(SOURCE_SECRET + "-RETAINED")).not.toEqual([]);
  });

  it("an ephemeral scan persists no fragment of the submitted source, anywhere", async () => {
    const res = await auth(request.post("/api/scans")).send({
      projectId,
      mode: "scan-only",
      language: "python",
      code: vulnerableSource(SOURCE_SECRET + "-EPHEMERAL"),
      retentionMode: "ephemeral",
    });

    expect(res.status).toBe(201);
    ephemeralScanId = res.body.id;
    expect(res.body.retentionMode).toBe("ephemeral");
    expect(res.body.sourceDiscardedAt).not.toBeNull();

    // The findings are still real — the mode drops the source, not the answer.
    expect(res.body.findings.length).toBeGreaterThan(0);

    // The whole-database sweep. This is the assertion that would catch the
    // failure mode the brief names: telling a customer "not retained" while
    // `observations.evidence.codeSnippet` still holds their line.
    expect(await columnsContaining(SOURCE_SECRET + "-EPHEMERAL")).toEqual([]);

    // And the same source in a *different* mode was found by the same sweep in
    // the test above, so the sweep is not passing because it cannot see.
    expect(await columnsContaining(SOURCE_SECRET + "-RETAINED")).not.toEqual([]);
  });

  it("the persisted findings of an ephemeral scan carry the marker, not a snippet", async () => {
    const res = await auth(request.get(`/api/scans/${ephemeralScanId}`));
    expect(res.status).toBe(200);
    expect(res.body.code).toBeNull();
    expect(res.body.retentionMode).toBe("ephemeral");
    expect(res.body.findings.length).toBeGreaterThan(0);
    for (const finding of res.body.findings) {
      expect(finding.codeSnippet).toBe(EPHEMERAL_SNIPPET_MARKER);
    }

    // The retained scan is untouched: reading it back still shows real lines.
    const retained = await auth(request.get(`/api/scans/${retainedScanId}`));
    expect(retained.body.retentionMode).toBe("retained");
    expect(retained.body.findings.some((f: { codeSnippet: string }) => f.codeSnippet.includes("md5"))).toBe(true);
  });

  it("evidence.codeSnippet is dropped for an ephemeral run and present for a retained one", async () => {
    const evidence = await readAsSuperuser<{ retention: string }>(
      `select case when o.evidence ? 'codeSnippet' then 'has-snippet' else 'no-snippet' end as retention
         from observations o
         join collection_runs r on r.id = o.collection_run_id
        where r.surface = 'source'`,
    );
    // Both scans dual-wrote, so both shapes must be present — one of each. A
    // suite where every observation lacked a snippet would also satisfy "the
    // ephemeral one has none".
    const shapes = evidence.map((e) => e.retention);
    expect(shapes).toContain("has-snippet");
    expect(shapes).toContain("no-snippet");
  });

  it("an unrecognised retentionMode is refused rather than guessed", async () => {
    const res = await auth(request.post("/api/scans/multi")).send({
      projectName: "typo",
      language: "python",
      files: [{ filename: "a.py", content: "import hashlib\n" }],
      retentionMode: "ephemerall",
    });
    // The dangerous reading is "unrecognised means ephemeral", which would let
    // a typo promise a customer something this code does not do. The other
    // dangerous reading is a silent fall back to `retained` after the caller
    // asked for ephemeral. Both are avoided by refusing.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/retentionMode/);
  });

  it("POST /api/scans/multi honours the mode across every file in the submission", async () => {
    const marker = "qx-multi-marker-1a2b3c4d5e6f-NEVER-PERSIST";
    const res = await auth(request.post("/api/scans/multi")).send({
      projectName: "multi-ephemeral",
      language: "python",
      files: [
        { filename: "a.py", content: vulnerableSource(marker + "-A") },
        { filename: "b.py", content: vulnerableSource(marker + "-B") },
      ],
      retentionMode: "ephemeral",
    });

    expect(res.status).toBe(201);
    expect(res.body.retentionMode).toBe("ephemeral");
    expect(res.body.filesScanned).toBe(2);
    expect(await columnsContaining(marker + "-A")).toEqual([]);
    expect(await columnsContaining(marker + "-B")).toEqual([]);
  });

  it("no source fragment reached the log stream either", () => {
    const logged = everythingLogged();
    expect(logged).not.toContain(SOURCE_SECRET + "-EPHEMERAL");
    expect(logged).not.toContain(CREDENTIAL_SECRET);
  });
});

describe("the credential store answers 503 rather than 500 when unconfigured", () => {
  it("registration without QUANTAXSCAN_CREDENTIAL_KEYS names the variable", async () => {
    const saved = process.env.QUANTAXSCAN_CREDENTIAL_KEYS;
    delete process.env.QUANTAXSCAN_CREDENTIAL_KEYS;
    try {
      const res = await auth(request.post("/api/credentials")).send({
        name: "unconfigured",
        kind: "cloud_kms_readonly",
        secret: randomBytes(24).toString("hex"),
      });
      expect(res.status).toBe(503);
      expect(res.body.error).toContain("QUANTAXSCAN_CREDENTIAL_KEYS");
    } finally {
      process.env.QUANTAXSCAN_CREDENTIAL_KEYS = saved;
    }
  });
});
