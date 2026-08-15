import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request } from "express";

/**
 * The pure key-to-organisation binding logic in `principal.ts` — no database,
 * no HTTP. `cross-tenant.test.ts` proves the binding holds end to end through
 * real routes and real RLS; this file proves the parsing and validation rules
 * themselves, including the ones that are startup errors rather than reachable
 * HTTP behaviour (a length mismatch never gets far enough to serve a request).
 *
 * Both `auth.ts` and `principal.ts` compute their exported values once, at
 * import time, from `process.env` — the same pattern `assertApiKeysConfigured`
 * uses so a misconfiguration is a boot-time failure. That means each scenario
 * here needs a fresh module graph: set the environment, `vi.resetModules()`,
 * then `import("./principal")` fresh.
 */

const ENV_KEYS = [
  "QUANTAXSCAN_API_KEYS",
  "QUANTAXSCAN_API_KEY_ORG_IDS",
  "QUANTAXSCAN_API_KEY_ORG_ID",
  "QUANTAXSCAN_API_KEY_ROLES",
] as const;

let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.resetModules();
});

/** Fresh import of principal.ts (and, transitively, auth.ts) against the
 * environment set by the calling test. */
async function importPrincipal(): Promise<typeof import("./principal")> {
  vi.resetModules();
  return import("./principal");
}

function requestWithKey(key: string): Request {
  return { headers: { "x-api-key": key } } as unknown as Request;
}

/**
 * Run a key-bearing request through the real `resolvePrincipal` middleware, so
 * `orgContextFor` sees the `req.principal` it now reads.
 *
 * F1 moved the key → organisation resolution out of `orgContextFor` and into
 * the middleware: `orgContextFor` reads `req.principal` and throws if it is
 * absent, because a route reaching it without one is a bug in the route rather
 * than a reachable state. The property under test is unchanged — *which*
 * configured key was presented decides the organisation — so the test drives it
 * where it now lives instead of asserting the old call shape.
 */
async function principalFor(
  principal: typeof import("./principal"),
  key: string,
): Promise<Request> {
  const req = requestWithKey(key);
  await new Promise<void>((resolve, reject) => {
    principal.resolvePrincipal(
      req,
      { status: () => ({ json: () => undefined }) } as never,
      ((err?: unknown) => (err ? reject(err) : resolve())) as never,
    );
  });
  return req;
}

describe("principal.ts — API key to organisation binding (F1)", () => {
  it("no QUANTAXSCAN_API_KEY_ORG_IDS, one key: defaults to organisation 1 (unchanged pre-F1 behaviour)", async () => {
    process.env.QUANTAXSCAN_API_KEYS = "solo-key-abcdefghijklmnopqrstuvwx";
    delete process.env.QUANTAXSCAN_API_KEY_ORG_IDS;
    delete process.env.QUANTAXSCAN_API_KEY_ORG_ID;

    const { API_KEY_ORG_IDS } = await importPrincipal();
    expect(API_KEY_ORG_IDS).toEqual([1]);
  });

  it("no QUANTAXSCAN_API_KEY_ORG_IDS, several keys: the legacy QUANTAXSCAN_API_KEY_ORG_ID binds all of them to the same organisation", async () => {
    process.env.QUANTAXSCAN_API_KEYS = "key-one-abcdefghijklmnopqrstuvwx,key-two-abcdefghijklmnopqrstuvwx";
    process.env.QUANTAXSCAN_API_KEY_ORG_ID = "5";
    delete process.env.QUANTAXSCAN_API_KEY_ORG_IDS;

    const { API_KEY_ORG_IDS } = await importPrincipal();
    expect(API_KEY_ORG_IDS).toEqual([5, 5]);
  });

  it("QUANTAXSCAN_API_KEY_ORG_IDS set: binds positionally, one id per key, in order", async () => {
    process.env.QUANTAXSCAN_API_KEYS = "key-one-abcdefghijklmnopqrstuvwx,key-two-abcdefghijklmnopqrstuvwx";
    process.env.QUANTAXSCAN_API_KEY_ORG_IDS = "7,9";

    const { API_KEY_ORG_IDS } = await importPrincipal();
    expect(API_KEY_ORG_IDS).toEqual([7, 9]);
  });

  it("a shorter QUANTAXSCAN_API_KEY_ORG_IDS than QUANTAXSCAN_API_KEYS is a startup error, not a silent default to organisation 1", async () => {
    process.env.QUANTAXSCAN_API_KEYS = "key-one-abcdefghijklmnopqrstuvwx,key-two-abcdefghijklmnopqrstuvwx";
    process.env.QUANTAXSCAN_API_KEY_ORG_IDS = "3"; // only one id for two keys

    await expect(importPrincipal()).rejects.toThrow(/QUANTAXSCAN_API_KEY_ORG_IDS/);
  });

  it("a longer QUANTAXSCAN_API_KEY_ORG_IDS than QUANTAXSCAN_API_KEYS is also a startup error", async () => {
    process.env.QUANTAXSCAN_API_KEYS = "solo-key-abcdefghijklmnopqrstuvwx";
    process.env.QUANTAXSCAN_API_KEY_ORG_IDS = "1,2";

    await expect(importPrincipal()).rejects.toThrow(/QUANTAXSCAN_API_KEY_ORG_IDS/);
  });

  it("a non-integer or non-positive entry in QUANTAXSCAN_API_KEY_ORG_IDS is rejected", async () => {
    process.env.QUANTAXSCAN_API_KEYS = "solo-key-abcdefghijklmnopqrstuvwx";
    process.env.QUANTAXSCAN_API_KEY_ORG_IDS = "0";
    await expect(importPrincipal()).rejects.toThrow(/QUANTAXSCAN_API_KEY_ORG_IDS/);
  });

  it("orgContextFor resolves the organisation from *which* configured key was presented", async () => {
    process.env.QUANTAXSCAN_API_KEYS = "key-one-abcdefghijklmnopqrstuvwx,key-two-abcdefghijklmnopqrstuvwx";
    process.env.QUANTAXSCAN_API_KEY_ORG_IDS = "10,20";

    const principal = await importPrincipal();
    // `divisionIds` is asserted rather than ignored: an empty set is what
    // carries "unrestricted" into the GUC (RBAC stage 4), and a machine
    // credential acquiring a division restriction by accident would silently
    // narrow what every CI script can see.
    expect(principal.orgContextFor(await principalFor(principal, "key-one-abcdefghijklmnopqrstuvwx"))).toEqual({
      organizationId: 10,
      userId: "",
      divisionIds: [],
    });
    expect(principal.orgContextFor(await principalFor(principal, "key-two-abcdefghijklmnopqrstuvwx"))).toEqual({
      organizationId: 20,
      userId: "",
      divisionIds: [],
    });
  });

  it("orgContextFor throws rather than defaulting an unrecognised key to any organisation", async () => {
    process.env.QUANTAXSCAN_API_KEYS = "solo-key-abcdefghijklmnopqrstuvwx";
    delete process.env.QUANTAXSCAN_API_KEY_ORG_IDS;

    const { orgContextFor } = await importPrincipal();
    expect(() => orgContextFor(requestWithKey("something-nobody-configured-00000000"))).toThrow();
  });
});

describe("principal.ts — API key to role binding (RBAC stage 2)", () => {
  it("defaults every key to admin, so no existing deployment breaks on upgrade", async () => {
    process.env.QUANTAXSCAN_API_KEYS = "key-one-abcdefghijklmnopqrstuvwx,key-two-abcdefghijklmnopqrstuvwx";
    delete process.env.QUANTAXSCAN_API_KEY_ROLES;

    const { API_KEY_ROLES } = await importPrincipal();
    // Defaulting to viewer would be safer in the abstract and would silently
    // break every CI script that writes through this credential. That is the
    // worse failure — 15-rbac-design.md §4.5.
    expect(API_KEY_ROLES).toEqual(["admin", "admin"]);
  });

  it("binds roles positionally, so a read-only integration key is expressible", async () => {
    process.env.QUANTAXSCAN_API_KEYS = "key-one-abcdefghijklmnopqrstuvwx,key-two-abcdefghijklmnopqrstuvwx";
    process.env.QUANTAXSCAN_API_KEY_ROLES = "admin,viewer";

    const { API_KEY_ROLES } = await importPrincipal();
    expect(API_KEY_ROLES).toEqual(["admin", "viewer"]);
  });

  it("refuses to start on a length mismatch rather than defaulting the rest", async () => {
    process.env.QUANTAXSCAN_API_KEYS = "key-one-abcdefghijklmnopqrstuvwx,key-two-abcdefghijklmnopqrstuvwx";
    process.env.QUANTAXSCAN_API_KEY_ROLES = "admin";

    // "Which key may write" is not something to discover at runtime.
    await expect(importPrincipal()).rejects.toThrow(/QUANTAXSCAN_API_KEY_ROLES/);
  });

  it("refuses a role it does not recognise", async () => {
    process.env.QUANTAXSCAN_API_KEYS = "solo-key-abcdefghijklmnopqrstuvwx";
    process.env.QUANTAXSCAN_API_KEY_ROLES = "superuser";

    await expect(importPrincipal()).rejects.toThrow(/unknown role/i);
  });

  it("puts the role on the principal, where a gate can read it", async () => {
    process.env.QUANTAXSCAN_API_KEYS = "key-one-abcdefghijklmnopqrstuvwx,key-two-abcdefghijklmnopqrstuvwx";
    process.env.QUANTAXSCAN_API_KEY_ORG_IDS = "10,20";
    process.env.QUANTAXSCAN_API_KEY_ROLES = "admin,viewer";

    const principal = await importPrincipal();
    const req = await principalFor(principal, "key-two-abcdefghijklmnopqrstuvwx");

    expect(req.principal).toMatchObject({ kind: "apiKey", organizationId: 20, role: "viewer" });
    // Empty is unrestricted: a machine credential acts at its role across the
    // whole organisation rather than being confined to a division.
    expect(req.principal?.kind).toBe("apiKey");
    if (req.principal?.kind !== "apiKey") throw new Error("expected an apiKey principal");
    expect(req.principal.divisionIds).toEqual([]);
  });
});
