import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * A real (embedded, in-memory) Postgres instance with the actual generated
 * migrations in `lib/db/drizzle/` applied — not a hand-rolled approximation
 * of the schema. This is what lets `assets`/`observations` tests exercise
 * the genuine `CHECK`/foreign-key/unique-index constraints rather than
 * asserting against the TypeScript layer alone.
 */
export async function createTestDb(): Promise<{
  db: PgliteDatabase<typeof schema>;
  close: () => Promise<void>;
}> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db, close: () => client.close() };
}
