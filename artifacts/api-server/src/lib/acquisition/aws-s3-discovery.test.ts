import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * P2's S3 enumeration, against a local stub.
 *
 * The assertions worth having here are about **what a lead claims**, which is
 * very little, and about the two ways an enumeration can quietly overclaim:
 * treating a partial read as complete, and inventing a hostname for a resource
 * that has none.
 */

const SECRET = { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "s3cr3t-do-not-leak-me", sessionToken: "tok-do-not-leak" };

const state: { xml: string; failWith: number | null; seen: number } = { xml: "", failWith: null, seen: 0 };
let server: Server;
let acquire: typeof import("./aws-s3-discovery").acquireS3Leads;
let parseBucketNames: typeof import("./aws-s3-discovery").parseBucketNames;

const handleFor = (plaintext: string) =>
  ({ reveal: () => plaintext }) as unknown as import("@workspace/db/credentials").SecretHandle;

const listBucketsXml = (names: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult><Buckets>${names
    .map((n) => `<Bucket><Name>${n}</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket>`)
    .join("")}</Buckets></ListAllMyBucketsResult>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    state.seen++;
    if (state.failWith !== null) {
      res.writeHead(state.failWith, { "content-type": "application/xml" });
      // A real S3 error body echoes the request. That is exactly what must not
      // reach a stored row or a response.
      res.end(`<Error><Code>AccessDenied</Code><Message>not authorised for ${req.headers.authorization}</Message></Error>`);
      return;
    }
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(state.xml);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.AWS_S3_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const mod = await import("./aws-s3-discovery");
  acquire = mod.acquireS3Leads;
  parseBucketNames = mod.parseBucketNames;
});

afterAll(async () => {
  delete process.env.AWS_S3_ENDPOINT;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function reset(names: string[], failWith: number | null = null): void {
  state.xml = listBucketsXml(names);
  state.failWith = failWith;
  state.seen = 0;
}

const account = { kind: "cloud_account" as const, provider: "aws", account: "111122223333", service: "s3" };

describe("enumerating S3 buckets as leads", () => {
  it("records every bucket as a lead and claims the account complete", async () => {
    reset(["reports-archive", "backups-eu"]);

    const result = await acquire(handleFor(JSON.stringify(SECRET)), { scopes: [account], maxItems: 100 });

    expect(result.input.map((l) => l.identity)).toEqual(["reports-archive", "backups-eu"]);
    expect(result.enumerated).toHaveLength(1);
    expect(result.refused).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("gives a bucket NO hostname, rather than constructing one", async () => {
    reset(["reports-archive"]);

    const result = await acquire(handleFor(JSON.stringify(SECRET)), { scopes: [account], maxItems: 100 });

    // `<bucket>.s3.amazonaws.com` is derivable and is deliberately not derived.
    // `normaliseHostname()`'s rule: a repaired name is a name nobody has
    // evidence for. This is the case stage 0 made `hostname` nullable for.
    expect(result.input[0]).not.toHaveProperty("hostname");
    expect(JSON.stringify(result.input[0])).not.toContain("s3.amazonaws.com");
  });

  it("claims the ACCOUNT, with no region, because ListBuckets never filtered on one", async () => {
    reset(["a"]);

    const result = await acquire(handleFor(JSON.stringify(SECRET)), { scopes: [account], maxItems: 100 });
    const scope = result.enumerated[0]?.scope;

    expect(scope).toMatchObject({ kind: "cloud_account", provider: "aws", account: "111122223333", service: "s3" });
    // Naming a region here would claim a boundary this call never established —
    // §4.5's corollary in the dangerous direction.
    expect(scope).not.toHaveProperty("region");
  });

  it("withholding a name withdraws the completeness claim rather than shrinking it", async () => {
    reset(["a", "b", "c"]);

    const result = await acquire(handleFor(JSON.stringify(SECRET)), { scopes: [account], maxItems: 2 });

    expect(result.input).toHaveLength(2);
    expect(result.truncated).toBe(true);
    // The important half: NOT enumerated. Reporting a ceiling-limited read as a
    // complete account is the lie `MAX_DISCOVERED_HOSTNAMES_PER_RUN`'s rule
    // exists to prevent.
    expect(result.enumerated).toEqual([]);
    expect(result.refused[0]?.reason).toBe("throttled");
  });

  it("records a denied account as refused, never as empty", async () => {
    reset([], 403);

    const result = await acquire(handleFor(JSON.stringify(SECRET)), { scopes: [account], maxItems: 100 });

    expect(result.enumerated).toEqual([]);
    expect(result.refused).toEqual([{ scope: account, reason: "access-denied" }]);
    // An account we could not read is not an account with no buckets.
    expect(result.input).toEqual([]);
  });

  it("leaks no part of the secret, including on the error path", async () => {
    for (const failWith of [null, 403]) {
      reset(["a"], failWith);
      const result = await acquire(handleFor(JSON.stringify(SECRET)), { scopes: [account], maxItems: 100 });
      const serialised = JSON.stringify(result);

      expect(serialised).not.toContain(SECRET.secretAccessKey);
      expect(serialised).not.toContain(SECRET.sessionToken);
      expect(serialised).not.toContain(SECRET.accessKeyId);
      expect(serialised.toLowerCase()).not.toContain("signature");
    }
  });

  it("produces no egress at all for an unparseable credential", async () => {
    reset(["a"]);

    const result = await acquire(handleFor("}{not json"), { scopes: [account], maxItems: 100 });

    expect(state.seen).toBe(0);
    expect(result.refused[0]?.reason).toBe("unauthenticated");
    expect(JSON.stringify(result)).not.toContain("}{not json");
  });

  it("refuses a non-AWS scope instead of enumerating the wrong thing", async () => {
    reset(["a"]);

    const result = await acquire(handleFor(JSON.stringify(SECRET)), {
      scopes: [{ kind: "cloud_account", provider: "gcp", account: "x" }],
      maxItems: 100,
    });

    expect(result.refused[0]?.reason).toBe("unsupported");
    expect(state.seen).toBe(0);
  });
});

describe("parsing the ListBuckets document", () => {
  it("reads every name and decodes the predefined entities", () => {
    expect(parseBucketNames(listBucketsXml(["plain", "with&amp;amp", "a&lt;b"]))).toEqual(["plain", "with&amp", "a<b"]);
  });

  it("does not decode recursively, so an encoded entity cannot become a different one", () => {
    // `&amp;lt;` must decode to the literal text `&lt;`, not to `<`.
    expect(parseBucketNames("<Name>&amp;lt;</Name>")).toEqual(["&lt;"]);
  });

  it("returns nothing for a document with no buckets, rather than a placeholder", () => {
    expect(parseBucketNames(listBucketsXml([]))).toEqual([]);
    expect(parseBucketNames("")).toEqual([]);
  });
});
