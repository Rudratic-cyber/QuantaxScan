import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const routesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "routes");

/**
 * A route must never import the module-level `db`.
 *
 * Not style. A query issued on `db` from inside a `withOrg` callback runs on a
 * *different* connection, outside the transaction, and therefore outside the
 * GUC the row-level security policies read — so it sees nothing, or, if the
 * policies were ever loosened, sees everything. The failure is loud in the
 * first case and catastrophic in the second, and neither is visible in review:
 * `db.select()` and `tx.select()` look identical at a glance.
 *
 * Route handlers get their handle from `withOrg` / `withPublicShare` /
 * `withoutOrgScope`, which is the only way the scope is guaranteed to be set.
 *
 * This is a lint rule expressed as a test because it is a security property,
 * and a security property belongs in the suite that has to stay green.
 */
describe("routes reach the database only through the scope helpers", () => {
  const routeFiles = readdirSync(routesDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("there are route files to check (guards against this test silently checking nothing)", () => {
    expect(routeFiles.length).toBeGreaterThan(5);
  });

  it.each(routeFiles)("routes/%s does not import `db` from @workspace/db", (file) => {
    const source = readFileSync(path.join(routesDir, file), "utf8");

    // Match the import statement's binding list, not the whole file — the word
    // "db" appears in prose comments in several of these files.
    const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@workspace\/db["']/g)];

    for (const match of imports) {
      const bindings = match[1].split(",").map((b) => b.trim().split(/\s+as\s+/)[0].trim());
      expect(
        bindings,
        `routes/${file} imports \`db\` directly. Use the ScopedTx that withOrg/withPublicShare/withoutOrgScope hands you.`,
      ).not.toContain("db");
      expect(bindings).not.toContain("pool");
    }
  });

  it.each(routeFiles)("routes/%s uses a scope helper if it touches the database at all", (file) => {
    const source = readFileSync(path.join(routesDir, file), "utf8");
    if (!/from\s*["']@workspace\/db["']/.test(source)) return; // touches no database

    expect(
      /\b(withOrg|withPublicShare|withoutOrgScope)\b/.test(source),
      `routes/${file} imports from @workspace/db but opens no scope`,
    ).toBe(true);
  });
});
