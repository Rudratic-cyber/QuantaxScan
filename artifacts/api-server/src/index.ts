import app from "./app";
import { db, assertTenantIsolationInstalled } from "@workspace/db";
import { logger } from "./lib/logger";
import { assertApiKeysConfigured } from "./lib/auth";

// Fail closed: refuse to start rather than serve an unauthenticated API.
assertApiKeysConfigured();

/**
 * Fail closed again, on the other half of the guarantee.
 *
 * `drizzle-kit push` installs RLS policies with a NULL `USING` clause, which
 * permit every row while reading as installed — so "we ran the migration" is
 * not evidence that isolation exists. This queries `pg_class`/`pg_policy` for
 * the real state and refuses to start if any organisation-scoped table is
 * missing RLS, missing FORCE, or carries a permit-everything policy. It is the
 * control that catches a future `push` silently regressing it.
 *
 * Deliberately here and not in `app.ts`: the API test suite imports `app`
 * directly against a mocked database, and a startup-time database round trip
 * there would be both wrong and flaky.
 *
 * Consequence for deployment, and it is not optional: a release that reaches
 * production before `apply-tenancy` and `apply-rls` have run will refuse to
 * boot. That is the intended failure — loud, at start, rather than a silently
 * unisolated API.
 */
await assertTenantIsolationInstalled(db);

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
