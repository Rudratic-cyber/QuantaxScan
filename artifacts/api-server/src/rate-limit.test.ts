import { describe, it, expect, vi } from "vitest";
import supertest from "supertest";

/**
 * S6 — per-route budgets, keyed on the principal.
 *
 * Budgets are read from the environment at import time, so they are set here
 * before `app` is imported. The edge (IP) budget is left large: this file
 * exercises the *per-route* layer, and every supertest request comes from
 * 127.0.0.1, so a small edge budget would 429 everything for the wrong reason.
 * The edge layer has its own file.
 */

const { KEY_A, KEY_B } = vi.hoisted(() => {
  const keyA = "test-key-a-1234567890-abcdefghijklmnop";
  const keyB = "test-key-b-1234567890-abcdefghijklmnop";
  process.env.QUANTAXSCAN_API_KEYS = `${keyA},${keyB}`;
  process.env.QUANTAXSCAN_API_KEY_ORG_ID = "1";
  process.env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";
  process.env.RATE_LIMIT_EDGE_MAX = "10000";
  process.env.RATE_LIMIT_DEFAULT_MAX = "10000";
  process.env.RATE_LIMIT_SCAN_MAX = "3";
  process.env.RATE_LIMIT_CHAT_MAX = "2";
  process.env.RATE_LIMIT_GITHUB_MAX = "1";
  return { KEY_A: keyA, KEY_B: keyB };
});

// Nothing here reaches a database: the routes used are either public and
// in-memory (`/healthz`, the demo scan) or rejected before any query.
vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  const unused = () => {
    throw new Error("rate-limit.test.ts must not reach the database");
  };
  return { db: {}, pool: {}, withOrg: unused, withPublicShare: unused, withoutOrgScope: unused, ...schema };
});

import app from "./app";

const request = supertest(app);

describe("S6 — per-route rate limits", () => {
  it("gives a scan its own budget and answers over it with 429 + Retry-After", async () => {
    // RATE_LIMIT_SCAN_MAX = 3, and this route is public so it keys on the IP.
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await request.post("/api/demo/repos/paramiko-ssh/scan");
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 3).every((status) => status === 200)).toBe(true);

    const limited = await request.post("/api/demo/repos/paramiko-ssh/scan");
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: "Too many requests" });

    const retryAfter = Number(limited.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it("does not share that budget with the health check", async () => {
    // The scan budget above is already exhausted for this IP. `/healthz` is
    // exempt from the per-route layer entirely — a load balancer polling it
    // must never consume a scan's allowance.
    for (let i = 0; i < 20; i++) {
      const res = await request.get("/api/healthz");
      expect(res.status).toBe(200);
    }
  });

  it("does not share that budget with chat", async () => {
    // RATE_LIMIT_CHAT_MAX = 2, independent of the exhausted scan bucket.
    const first = await request
      .post("/api/chat")
      .set("Authorization", `Bearer ${KEY_A}`)
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(first.status).not.toBe(429);

    await request
      .post("/api/chat")
      .set("Authorization", `Bearer ${KEY_A}`)
      .send({ messages: [{ role: "user", content: "hi" }] });

    const third = await request
      .post("/api/chat")
      .set("Authorization", `Bearer ${KEY_A}`)
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(third.status).toBe(429);
    expect(third.headers["retry-after"]).toBeDefined();
  });

  it("gives the GitHub-facing routes the tightest budget of all", async () => {
    // RATE_LIMIT_GITHUB_MAX = 1. The first request is refused for its body
    // size or its URL — the point is only that the *second* is refused for
    // being over budget, without any outbound call having been possible.
    const first = await request
      .post("/api/github/fetch")
      .set("Authorization", `Bearer ${KEY_B}`)
      .send({ repoUrl: "https://github.com.evil.example/o/r" });
    expect(first.status).toBe(400);

    const second = await request
      .post("/api/github/fetch")
      .set("Authorization", `Bearer ${KEY_B}`)
      .send({ repoUrl: "https://github.com.evil.example/o/r" });
    expect(second.status).toBe(429);
  });

  it("keys the budget on the API key, not on the connection", async () => {
    // KEY_A exhausts the scan bucket on a key-protected scan route; KEY_B,
    // from the same address, still has its own.
    const body = { files: [] };
    for (let i = 0; i < 3; i++) {
      await request.post("/api/github/scan-files").set("X-API-Key", KEY_A).send(body);
    }
    const exhausted = await request.post("/api/github/scan-files").set("X-API-Key", KEY_A).send(body);
    expect(exhausted.status).toBe(429);

    const other = await request.post("/api/github/scan-files").set("X-API-Key", KEY_B).send(body);
    expect(other.status).toBe(400); // rejected for an empty files array, not rate limited
  });

  it("never sets WWW-Authenticate on a 429", async () => {
    const res = await request.post("/api/demo/repos/paramiko-ssh/scan");
    expect(res.status).toBe(429);
    expect(res.headers["www-authenticate"]).toBeUndefined();
  });
});

describe("S6 — per-route body ceilings", () => {
  it("caps a chat body well below the global 10 MB", async () => {
    const res = await request
      .post("/api/chat")
      .set("Authorization", `Bearer ${KEY_B}`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ messages: [{ role: "user", content: "x".repeat(400_000) }] }));
    expect(res.status).toBe(413);
  });
});
