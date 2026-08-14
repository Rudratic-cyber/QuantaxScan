import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { createOrgScope, UNSCOPED_BY_DESIGN } from "./org-scope";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

/**
 * The sanctioned path to organisation-scoped data. Route code takes the
 * `ScopedTx` these hand it and never closes over `db` directly — a query run
 * on `db` inside a `withOrg` callback runs outside the transaction, and so
 * outside the GUC the policies read.
 */
export const { withOrg, withPublicShare, withoutOrgScope } = createOrgScope(db, {
  // Public community content is read on every page load, so its use of the
  // escape hatch is routine by design. Declaring it keeps the warning channel
  // meaningful: anything NOT on this list is genuinely worth looking at.
  expectedReasons: UNSCOPED_BY_DESIGN,
});

export * from "./schema";
export * from "./org-scope";
export * from "./tenant-isolation";
/**
 * Re-exported for convenience. A4 and anything else that only needs the A3
 * contract should import `@workspace/db/classification` instead — that subpath
 * pulls in no drizzle, no `pg`, and does not require `DATABASE_URL`, which this
 * module does at import time (line 8).
 */
export * from "./classification";
