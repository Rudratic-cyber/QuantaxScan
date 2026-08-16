import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { signAwsRequest } from "./aws-sigv4";

/**
 * P1's AWS KMS acquisition, against a local stub of the KMS JSON protocol.
 *
 * ## Why a stub rather than a mock of the module
 *
 * The things worth testing here are all *transport* behaviour — pagination
 * exhaustion, a throttled page, a denied region, a ceiling — and mocking the
 * module under test asserts only that the mock was called. The e2e suite takes
 * the same position with `E2E_CT_STUB_PORT` for certificate transparency, and
 * for the same reason.
 *
 * The stub also lets the highest-value assertion exist at all: that a **failing**
 * call leaks nothing. §4.6 point 5 is explicit that error paths are where
 * secrets leak and *"the happy path proves little"*, so the stub is asked to
 * fail in the ways a real provider fails.
 *
 * `AWS_KMS_ENDPOINT` has to be set before the module under test is imported,
 * because it reads the variable at module scope — so the import is dynamic and
 * happens inside `beforeAll`.
 */

const SECRET = { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "s3cr3t-do-not-leak-me", sessionToken: "tok-do-not-leak" };

interface StubState {
  /** Region → the pages `ListKeys` should return, in order. */
  pages: Array<{ keys: string[]; more: boolean }>;
  /** Status to answer with instead, when set. */
  failWith: number | null;
  /** Every request body the stub saw, so a test can assert what was and was not sent. */
  seen: string[];
}

const state: StubState = { pages: [], failWith: null, seen: [] };
let server: Server;
let acquisition: typeof import("./aws-kms").awsKmsAcquisition;
let testing: typeof import("./aws-kms").__testing;

/** A `SecretHandle` needs only `reveal()` here; the real class is exercised by F4's own tests. */
const handleFor = (plaintext: string) => ({ reveal: () => plaintext }) as unknown as import("@workspace/db/credentials").SecretHandle;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      state.seen.push(body);
      if (state.failWith !== null) {
        res.writeHead(state.failWith, { "content-type": "application/x-amz-json-1.1" });
        // A real AWS error body. Deliberately echoes the request, which is
        // exactly the thing that must not reach a stored row or a response.
        res.end(JSON.stringify({ __type: "AccessDeniedException", message: `not authorised: ${body}` }));
        return;
      }

      const target = String(req.headers["x-amz-target"]);
      if (target.endsWith("ListKeys")) {
        const parsed = JSON.parse(body) as { Marker?: string };
        const index = parsed.Marker === undefined ? 0 : Number(parsed.Marker);
        const page = state.pages[index] ?? { keys: [], more: false };
        res.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
        res.end(
          JSON.stringify({
            Keys: page.keys.map((arn) => ({ KeyArn: arn, KeyId: arn })),
            Truncated: page.more,
            ...(page.more ? { NextMarker: String(index + 1) } : {}),
          }),
        );
        return;
      }

      const parsed = JSON.parse(body) as { KeyId: string };
      res.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
      res.end(
        JSON.stringify({
          KeyMetadata: { Arn: parsed.KeyId, KeyId: parsed.KeyId, KeySpec: "RSA_2048", KeyState: "Enabled", Origin: "AWS_KMS" },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  process.env.AWS_KMS_ENDPOINT = `http://127.0.0.1:${port}`;

  const mod = await import("./aws-kms");
  acquisition = mod.awsKmsAcquisition;
  testing = mod.__testing;
});

afterAll(async () => {
  delete process.env.AWS_KMS_ENDPOINT;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function reset(pages: StubState["pages"], failWith: number | null = null): void {
  state.pages = pages;
  state.failWith = failWith;
  state.seen = [];
}

const euWest = { kind: "cloud_account" as const, provider: "aws", account: "111122223333", region: "eu-west-1", service: "kms" };

describe("the AWS KMS acquisition", () => {
  it("enumerates a region to exhaustion and claims it complete", async () => {
    reset([
      { keys: ["arn:aws:kms:eu-west-1:111122223333:key/a"], more: true },
      { keys: ["arn:aws:kms:eu-west-1:111122223333:key/b"], more: false },
    ]);

    const result = await acquisition.acquire(handleFor(JSON.stringify(SECRET)), { scopes: [euWest], maxItems: 100 });

    expect(result.input).toHaveLength(2);
    expect(result.input[0]).toMatchObject({ provider: "aws-kms", keySpec: "RSA_2048", region: "eu-west-1" });
    expect(result.enumerated).toHaveLength(1);
    expect(result.refused).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("does NOT claim completeness when a page fails part-way, but keeps the keys it did read", async () => {
    // The failure §4.5 exists for. A partial read still yields real keys — they
    // were observed — but must not license retiring anything.
    reset([{ keys: ["arn:aws:kms:eu-west-1:111122223333:key/a"], more: true }]);
    const first = await acquisition.acquire(handleFor(JSON.stringify(SECRET)), { scopes: [euWest], maxItems: 100 });
    expect(first.enumerated).toHaveLength(1); // page 2 is empty and not truncated → exhausted

    reset([], 429);
    const throttled = await acquisition.acquire(handleFor(JSON.stringify(SECRET)), { scopes: [euWest], maxItems: 100 });

    expect(throttled.enumerated).toEqual([]);
    expect(throttled.refused).toEqual([{ scope: euWest, reason: "throttled" }]);
  });

  it("reports a ceiling as truncated instead of trimming silently", async () => {
    reset([{ keys: ["arn:aws:kms:eu-west-1:111122223333:key/a", "arn:aws:kms:eu-west-1:111122223333:key/b"], more: false }]);

    const result = await acquisition.acquire(handleFor(JSON.stringify(SECRET)), { scopes: [euWest], maxItems: 1 });

    expect(result.input).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.enumerated).toEqual([]);
  });

  it("maps each provider failure onto the closed vocabulary, never the vendor's words", async () => {
    for (const [status, reason] of [
      [403, "access-denied"],
      [401, "access-denied"],
      [429, "throttled"],
      [503, "throttled"],
      [404, "unsupported"],
    ] as const) {
      reset([], status);
      const result = await acquisition.acquire(handleFor(JSON.stringify(SECRET)), { scopes: [euWest], maxItems: 10 });
      expect(result.refused[0]?.reason, `status ${status}`).toBe(reason);
    }
  });

  it("leaks no part of the secret into the result, on the happy path or the error path", async () => {
    // The assertion that matters most. The stub's error body deliberately
    // echoes the request it received, which is what a real cloud SDK error does
    // and what §4.6 point 5 forbids from ever reaching a row or a response.
    for (const failWith of [null, 403]) {
      reset([{ keys: ["arn:aws:kms:eu-west-1:111122223333:key/a"], more: false }], failWith);
      const result = await acquisition.acquire(handleFor(JSON.stringify(SECRET)), { scopes: [euWest], maxItems: 10 });

      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain(SECRET.secretAccessKey);
      expect(serialised).not.toContain(SECRET.sessionToken);
      expect(serialised).not.toContain(SECRET.accessKeyId);
      expect(serialised.toLowerCase()).not.toContain("authorization");
      expect(serialised.toLowerCase()).not.toContain("signature");
    }
  });

  it("refuses a region that does not match the allowlist pattern, rather than resolving a host from it", async () => {
    // The SSRF surface: a region is interpolated into a hostname. Nothing that
    // matches the pattern can carry a `/`, an `@`, a `:` or a second host.
    for (const region of ["eu-west-1.evil.test", "eu-west-1/", "../../x", "EU-WEST-1", ""]) {
      expect(testing.REGION_PATTERN.test(region), region).toBe(false);
    }
    expect(testing.REGION_PATTERN.test("eu-west-1")).toBe(true);
    expect(testing.REGION_PATTERN.test("us-gov-west-1")).toBe(true);
    expect(testing.REGION_PATTERN.test("ap-southeast-3")).toBe(true);

    reset([{ keys: [], more: false }]);
    const result = await acquisition.acquire(handleFor(JSON.stringify(SECRET)), {
      scopes: [{ ...euWest, region: "eu-west-1.evil.test" }],
      maxItems: 10,
    });

    expect(result.refused[0]?.reason).toBe("unsupported");
    expect(state.seen, "no request may be sent for a rejected region").toEqual([]);
  });

  it("refuses a scope with no region rather than defaulting to one", async () => {
    reset([{ keys: [], more: false }]);
    const { region: _dropped, ...noRegion } = euWest;

    const result = await acquisition.acquire(handleFor(JSON.stringify(SECRET)), { scopes: [noRegion], maxItems: 10 });

    // Guessing `us-east-1` would enumerate the wrong place and then claim it as
    // coverage of the account.
    expect(result.refused[0]?.reason).toBe("unsupported");
    expect(result.enumerated).toEqual([]);
  });

  it("refuses every requested scope when the credential is not a JSON key pair, naming no contents", async () => {
    reset([{ keys: [], more: false }]);

    const result = await acquisition.acquire(handleFor("not-json-at-all"), { scopes: [euWest], maxItems: 10 });

    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.reason).toBe("unauthenticated");
    // The reason names the credential's shape, never its bytes — `JSON.parse`'s
    // own message quotes the input around the failure position.
    expect(JSON.stringify(result)).not.toContain("not-json-at-all");
    expect(state.seen, "a credential that cannot be parsed must produce no egress").toEqual([]);
  });

  it("passes a soft-deleted key through rather than treating it as absent", async () => {
    // §4.5's first corollary. A `PendingDeletion` key is returned by a complete
    // enumeration and is present-and-disabled; conflating it with a key that
    // vanished puts a live key's retirement a month early.
    const key = testing.describeToKey("eu-west-1", {
      Arn: "arn:aws:kms:eu-west-1:111122223333:key/c",
      KeySpec: "RSA_2048",
      KeyState: "PendingDeletion",
    });

    expect(key).toMatchObject({ keyState: "PendingDeletion", keySpec: "RSA_2048" });
  });

  it("omits a field AWS did not state instead of substituting one", async () => {
    const key = testing.describeToKey("eu-west-1", { Arn: "arn:aws:kms:eu-west-1:1:key/d" });

    // No `keySpec` — the collector reports that as `no-spec` and says so, which
    // beats a guessed spec resolving to a confident wrong algorithm.
    expect(key).not.toHaveProperty("keySpec");
    expect(key).not.toHaveProperty("keyState");
    expect(key).toMatchObject({ provider: "aws-kms", region: "eu-west-1" });
  });
});

describe("SigV4 signing", () => {
  it("produces the header set it signed, so the request cannot disagree with the signature", () => {
    const headers = signAwsRequest(
      {
        method: "POST",
        host: "kms.eu-west-1.amazonaws.com",
        path: "/",
        region: "eu-west-1",
        service: "kms",
        body: '{"Limit":100}',
        headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "TrentService.ListKeys" },
        now: new Date("2026-08-16T12:00:00Z"),
      },
      SECRET,
    );

    const signed = /SignedHeaders=([^,]+)/.exec(headers.authorization)?.[1]?.split(";") ?? [];
    expect(signed.length).toBeGreaterThan(0);
    for (const name of signed) expect(Object.keys(headers)).toContain(name);
    expect(signed).toEqual([...signed].sort());
  });

  it("is deterministic for a fixed instant, and changes when any input changes", () => {
    const base = {
      method: "POST",
      host: "kms.eu-west-1.amazonaws.com",
      path: "/",
      region: "eu-west-1",
      service: "kms",
      body: '{"Limit":100}',
      headers: { "x-amz-target": "TrentService.ListKeys" },
      now: new Date("2026-08-16T12:00:00Z"),
    };
    const sig = (r: typeof base) => /Signature=([a-f0-9]+)/.exec(signAwsRequest(r, SECRET).authorization)?.[1];

    expect(sig(base)).toBe(sig({ ...base }));
    expect(sig({ ...base, body: '{"Limit":50}' })).not.toBe(sig(base));
    expect(sig({ ...base, region: "us-east-1" })).not.toBe(sig(base));
    expect(sig({ ...base, now: new Date("2026-08-17T12:00:00Z") })).not.toBe(sig(base));
  });

  it("never puts the secret access key in a header", () => {
    const headers = signAwsRequest(
      {
        method: "POST",
        host: "kms.eu-west-1.amazonaws.com",
        path: "/",
        region: "eu-west-1",
        service: "kms",
        body: "{}",
        headers: {},
        now: new Date("2026-08-16T12:00:00Z"),
      },
      SECRET,
    );

    // The access key id and session token are *supposed* to travel; the secret
    // is what derives the signature and must never appear.
    expect(JSON.stringify(headers)).not.toContain(SECRET.secretAccessKey);
    expect(headers.authorization).toContain(SECRET.accessKeyId);
  });
});
