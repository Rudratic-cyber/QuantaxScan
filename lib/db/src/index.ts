import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { createOrgScope } from "./org-scope";

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
export const { withOrg, withPublicShare, withoutOrgScope } = createOrgScope(db);

export * from "./schema";
export * from "./org-scope";
export * from "./tenant-isolation";
