import { defineConfig } from "vitest/config";

/**
 * DB-backed suites boot `@electric-sql/pglite` — an embedded Postgres — inside the test body via
 * `createTestDb()`, then apply the full drizzle migration set and `tenant-isolation.sql`. On a
 * loaded machine that first boot alone can exceed vitest's 5s default, which surfaced as two
 * different `asset-model.test.ts` cases "failing" on timeout while proving nothing about the
 * code under test.
 *
 * A flaky gate is worse than no gate: it teaches everyone to re-run rather than read the failure.
 * The timeout is therefore raised here, once, rather than sprinkled per test — a real regression
 * still fails, it just gets long enough to actually run.
 */
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
