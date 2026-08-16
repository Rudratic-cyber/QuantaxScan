import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { ECOSYSTEM_VALUES, LOCKFILE_KINDS } from "@workspace/collectors";

/**
 * The spec has to describe the server that exists.
 *
 * Six consecutive features shipped a route and skipped regenerating
 * `lib/api-spec/openapi.yaml`, each citing the last one's precedent — so the
 * generated client and the zod types could not see the risk profile, the
 * coverage meter or the CBOM export at all. That is a process failure rather
 * than six coincidences, and a note in AGENTS.md is not a control. This file
 * is the control.
 *
 * It asserts three things, all cheap:
 *
 *  1. every route mounted on the Express router is documented;
 *  2. every documented path/method still exists in Express — a spec that
 *     describes a route which does not exist is worse than one that omits a
 *     route that does, because a client will call it;
 *  3. `security: []` in the spec agrees with `PUBLIC_ROUTES` in `lib/auth.ts`,
 *     in both directions.
 *
 * The database is stubbed rather than started: nothing here calls a handler,
 * it only reads the router's route table, so a pglite instance would be 20
 * seconds spent proving nothing.
 */

vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  const unused = () => {
    throw new Error("openapi-drift.test.ts must not execute a route handler");
  };
  return { db: {}, pool: {}, withOrg: unused, withPublicShare: unused, withoutOrgScope: unused, ...schema };
});

import router from "./routes";
import { PUBLIC_ROUTES } from "./lib/auth";

const SPEC_PATH = fileURLToPath(new URL("../../../lib/api-spec/openapi.yaml", import.meta.url));

interface SpecOperation {
  security?: unknown[];
  operationId?: string;
}

const spec = parseYaml(readFileSync(SPEC_PATH, "utf8")) as {
  paths: Record<string, Record<string, SpecOperation>>;
};

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** `/projects/:id/findings` → `/projects/{id}/findings`, the spec's spelling of the same route. */
function toSpecPath(expressPath: string): string {
  return expressPath.replace(/:([^/]+)/g, "{$1}");
}

/** `/reports/{id}` → `/reports/x`, a concrete path the PUBLIC_ROUTES regexes can be tested against. */
function toSamplePath(specPath: string): string {
  return specPath.replace(/\{[^}]+\}/g, "x");
}

function mountedRoutes(stack: unknown[]): string[] {
  return stack.flatMap((layer) => {
    const l = layer as { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: unknown[] } };
    if (l.route) {
      return Object.keys(l.route.methods)
        .filter((m) => l.route!.methods[m])
        .map((m) => `${m.toUpperCase()} ${toSpecPath(l.route!.path)}`);
    }
    return l.handle?.stack ? mountedRoutes(l.handle.stack) : [];
  });
}

const mounted = mountedRoutes((router as unknown as { stack: unknown[] }).stack).sort();

const documented = Object.entries(spec.paths)
  .flatMap(([path, operations]) =>
    HTTP_METHODS.filter((method) => operations[method]).map((method) => `${method.toUpperCase()} ${path}`),
  )
  .sort();

describe("openapi.yaml describes the server that exists", () => {
  it("documents every route mounted on the router", () => {
    expect(
      mounted.filter((route) => !documented.includes(route)),
      "a route exists in Express but not in openapi.yaml — regenerate the spec with `pnpm --filter @workspace/api-spec run codegen`",
    ).toEqual([]);
  });

  it("documents no route that does not exist", () => {
    expect(
      documented.filter((route) => !mounted.includes(route)),
      "openapi.yaml describes a route the server does not implement — a client will call it and get a 404",
    ).toEqual([]);
  });

  it("marks exactly the public routes as public", () => {
    const isPublicInAuth = (route: string): boolean => {
      const [method, path] = route.split(" ");
      const sample = toSamplePath(path);
      return PUBLIC_ROUTES.some((r) => r.method === method && r.path.test(sample));
    };
    const isPublicInSpec = (route: string): boolean => {
      const [method, path] = route.split(" ");
      const operation = spec.paths[path][method.toLowerCase()];
      return Array.isArray(operation.security) && operation.security.length === 0;
    };

    const disagreements = documented.filter((route) => isPublicInAuth(route) !== isPublicInSpec(route));
    expect(
      disagreements,
      "openapi.yaml and PUBLIC_ROUTES disagree about which routes need an API key — `security: []` means anonymous access is allowed, and a consumer of the generated client reads it that way",
    ).toEqual([]);
  });

  it("gives every operation an operationId, which is what names the generated hook", () => {
    const missing = documented.filter((route) => {
      const [method, path] = route.split(" ");
      return !spec.paths[path][method.toLowerCase()].operationId;
    });
    expect(missing).toEqual([]);
  });

  /**
   * The one *enum* this file polices, because it is the one that fails
   * silently in the client rather than in the server. `lib/api-zod` validates
   * the response, so a lockfile kind the collector emits and the spec does not
   * list makes a real submission fail client-side with a schema error — a
   * failure that looks like a bug in the caller. Nothing else in the test
   * suite can see that: the server would return a perfectly correct payload.
   */
  it("lists every lockfile kind and every ecosystem the collector can emit", () => {
    const summary = (spec as unknown as { components: { schemas: Record<string, unknown> } }).components.schemas
      .DependencyIngestSummary as {
      properties: {
        lockfiles: { items: { properties: { kind: { enum: string[] } } } };
        ecosystems: { items: { enum: string[] } };
      };
    };
    expect([...summary.properties.lockfiles.items.properties.kind.enum].sort()).toEqual([...LOCKFILE_KINDS].sort());
    expect([...summary.properties.ecosystems.items.enum].sort()).toEqual([...ECOSYSTEM_VALUES].sort());
  });
});
