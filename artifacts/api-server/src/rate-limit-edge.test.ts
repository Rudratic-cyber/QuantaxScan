import { describe, it, expect, vi } from "vitest";
import supertest from "supertest";

/**
 * S6, layer 1 — the IP-keyed limiter that runs *before* `requireApiKey`.
 *
 * Separate file because it needs a tiny edge budget, and vitest gives each
 * file its own module registry and therefore its own in-memory stores. In
 * `rate-limit.test.ts` the edge budget is deliberately huge for the opposite
 * reason.
 *
 * Two properties are under test:
 *
 *  1. the 401 path is itself bounded — without this, an attacker can hammer
 *     the auth middleware for free, which is the one route guaranteed to be
 *     reachable without a credential;
 *  2. a 429 says nothing about whether the presented key was valid.
 */

const { VALID_KEY } = vi.hoisted(() => {
  const key = "edge-test-key-1234567890-abcdefghijkl";
  process.env.QUANTAXSCAN_API_KEYS = key;
  process.env.QUANTAXSCAN_API_KEY_ORG_ID = "1";
  process.env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";
  process.env.RATE_LIMIT_EDGE_MAX = "4";
  process.env.RATE_LIMIT_DEFAULT_MAX = "10000";
  process.env.RATE_LIMIT_SCAN_MAX = "10000";
  process.env.RATE_LIMIT_CHAT_MAX = "10000";
  process.env.RATE_LIMIT_GITHUB_MAX = "10000";
  return { VALID_KEY: key };
});

vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  const unused = () => {
    throw new Error("rate-limit-edge.test.ts must not reach the database");
  };
  return { db: {}, pool: {}, withOrg: unused, withPublicShare: unused, withoutOrgScope: unused, ...schema };
});

import app from "./app";

const request = supertest(app);

describe("S6 — the pre-auth edge limiter", () => {
  it("bounds the 401 path and then answers identically regardless of the key", async () => {
    // RATE_LIMIT_EDGE_MAX = 4. The first four unauthenticated requests to a
    // protected route are refused by the auth middleware, as before.
    const unauthenticated = [];
    for (let i = 0; i < 4; i++) {
      unauthenticated.push((await request.get("/api/projects")).status);
    }
    expect(unauthenticated).toEqual([401, 401, 401, 401]);

    // The fifth never reaches the auth middleware at all.
    const noKey = await request.get("/api/projects");
    const wrongKey = await request.get("/api/projects").set("X-API-Key", "not-a-real-key-at-all-0000000000");
    const rightKey = await request.get("/api/projects").set("Authorization", `Bearer ${VALID_KEY}`);

    for (const res of [noKey, wrongKey, rightKey]) {
      expect(res.status).toBe(429);
      expect(res.body).toEqual({ error: "Too many requests" });
      // A `WWW-Authenticate` header here would be the tell: it is what the
      // auth middleware adds, so its presence would mark the requests that
      // got past the limiter.
      expect(res.headers["www-authenticate"]).toBeUndefined();
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    }

    // Byte-for-byte the same answer, valid key or not.
    expect(noKey.text).toEqual(wrongKey.text);
    expect(wrongKey.text).toEqual(rightKey.text);
  });
});
