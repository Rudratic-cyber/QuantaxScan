import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test in asset-ingest.test.ts spins up its own embedded pglite
    // instance and applies the real @workspace/db migrations — slower than
    // the default 5s timeout on a cold WASM compile.
    testTimeout: 30_000,
  },
});
