import { AsyncLocalStorage } from "node:async_hooks";
import { sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import * as schema from "./schema";

/**
 * Organisation scoping — the single choke point for tenant-scoped data.
 *
 * docs/Claude/08-security.md requires isolation "applied in a single choke
 * point that cannot be bypassed by forgetting a `where` clause". Only the
 * database can make that guarantee, so this module does not *implement* the
 * isolation: it sets the two transaction-local GUCs that the row-level
 * security policies in lib/db/sql/tenant-isolation.sql compare against.
 *
 * The consequence, which is the whole point: a forgotten
 * `where organizationId = ...` returns ZERO rows rather than another tenant's
 * data, and a wrong-organisation insert is rejected by the policy's
 * `WITH CHECK`. TypeScript makes the correct path the ergonomic one; the
 * guarantee is the database's.
 *
 * See docs/Claude/13-auth-and-tenancy.md §5.5.
 */

/** Accepts node-postgres in production and pglite in tests without a cast. */
export type AppDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/** The handle a scoped callback is given. Route code must use *this*, never the module-level `db`. */
export type ScopedTx = PgTransaction<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;

export interface OrgContext {
  organizationId: number;
  /**
   * The signed-in user, or `""` for a principal with no person behind it —
   * today, the shared API key. Empty string rather than null on purpose:
   * `nullif(..., '')` in the policies normalises it to NULL, so the
   * `user_id = ...` branches match nothing, which is the correct semantics
   * for a machine credential.
   */
  userId: string;
}

/**
 * Set by every scope helper, transaction-locally, so that a nested scope is
 * detectable at the database level too. See `assertNotNested`.
 */
const SCOPE_SENTINEL = "app.scope_active";

interface GucRow {
  scope_active: string | null;
  org_id: string | null;
}

/**
 * Nesting guard, part one — and the one that actually fires.
 *
 * A nested scope is the ONLY failure mode in this whole mechanism that returns
 * *another tenant's rows* rather than *no rows*, so it gets an explicit guard
 * rather than a convention.
 *
 * The hazard: `db.transaction()` nests via savepoints, and a GUC set inside a
 * savepoint that is RELEASED persists for the remainder of the outer
 * transaction. Verified against PGlite 0.5.4 / PostgreSQL 18.3 — an outer
 * scope at org 1 saw `[a, b]`; an inner scope at org 2 ran and released; the
 * *outer* scope then saw org 2's row, silently, with no error. (`ROLLBACK TO
 * SAVEPOINT` does restore it, so only the success path is dangerous, which is
 * why this cannot be left to error handling.)
 *
 * Why AsyncLocalStorage and not only the GUC probe below: the probe can only
 * run once a transaction has been opened, and opening one is exactly what a
 * nested call must not get to do. On a single-connection driver a nested
 * `BEGIN` deadlocks against its own parent — measured, it hangs rather than
 * throwing — and on a pooled driver it silently checks out a *second* client,
 * where the guard would see a pristine session and wave it through. Refusing
 * in-process, before any transaction exists, is correct on both.
 */
const activeScope = new AsyncLocalStorage<{ opening: string; organizationId?: number }>();

function assertNotNestedInProcess(opening: string): void {
  const outer = activeScope.getStore();
  if (!outer) return;

  const where =
    outer.organizationId !== undefined ? `organization ${outer.organizationId}` : `an unscoped block`;
  throw new Error(
    `${opening} cannot nest: already inside ${outer.opening}, scoped to ${where}. ` +
      `A nested scope silently re-scopes its parent once its savepoint is released, ` +
      `which is how one tenant ends up reading another's rows. ` +
      `Pass the existing ScopedTx down instead of opening a new scope.`,
  );
}

/**
 * Nesting guard, part two: the database-level backstop, for a connection that
 * arrives already carrying a scope GUC from somewhere this process did not
 * open — a savepoint-based `tx.transaction()` in a helper, or a leaked `SET`.
 *
 * `nullif` matters here as much as in the policies: on a pooled client reused
 * after a previous transaction committed, `current_setting` returns the empty
 * string rather than NULL, and a bare check would then reject every second
 * request.
 */
async function assertNotNested(tx: ScopedTx, opening: string): Promise<void> {
  const result = await tx.execute(sql`select
    nullif(current_setting(${SCOPE_SENTINEL}, true), '') as scope_active,
    nullif(current_setting('app.current_org_id', true), '') as org_id`);
  const row = (result.rows as GucRow[] | undefined)?.[0];

  if (row?.scope_active != null || row?.org_id != null) {
    const where = row?.org_id != null ? `organization ${row.org_id}` : "an unscoped block";
    throw new Error(
      `${opening} cannot nest: this connection is already scoped to ${where}. ` +
        `Pass the existing ScopedTx down instead of opening a new scope.`,
    );
  }
}

export interface OrgScope {
  withOrg<T>(ctx: OrgContext, fn: (tx: ScopedTx) => Promise<T>): Promise<T>;
  withPublicShare<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T>;
  withoutOrgScope<T>(reason: string, fn: (tx: ScopedTx) => Promise<T>): Promise<T>;
}

export interface OrgScopeOptions {
  /** Where the audited escape hatch reports its use. Defaults to `console.warn`. */
  warn?: (message: string, detail: { reason: string; stack?: string }) => void;
}

/**
 * Binds the scope helpers to a database handle. The production instance is
 * exported from `@workspace/db` as `withOrg`/`withPublicShare`/
 * `withoutOrgScope`; tests bind their own pglite handle.
 *
 * This module deliberately does not import `./index`, so importing it never
 * requires `DATABASE_URL`.
 */
export function createOrgScope(database: AppDatabase, options: OrgScopeOptions = {}): OrgScope {
  const warn =
    options.warn ??
    ((message, detail) => {
      console.warn(message, detail);
    });

  async function withOrg<T>(ctx: OrgContext, fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    if (!Number.isInteger(ctx.organizationId)) {
      throw new Error(`withOrg needs an integer organizationId, got ${String(ctx.organizationId)}`);
    }

    assertNotNestedInProcess("withOrg");

    return activeScope.run({ opening: "withOrg", organizationId: ctx.organizationId }, () =>
      database.transaction(async (tx) => {
        const scoped = tx as ScopedTx;
        await assertNotNested(scoped, "withOrg");
        // set_config(..., true) rather than SET LOCAL, for two reasons: it
        // takes BIND PARAMETERS, so the organisation id is never
        // string-interpolated into SQL; and `SET LOCAL` outside a transaction
        // silently succeeds while doing nothing at all (verified).
        await scoped.execute(sql`select
          set_config('app.current_org_id',  ${String(ctx.organizationId)}, true),
          set_config('app.current_user_id', ${ctx.userId},                 true),
          set_config(${SCOPE_SENTINEL},     '1',                           true)`);
        return fn(scoped);
      }),
    );
  }

  /**
   * Anonymous access to a public share link. Sets no organisation GUC, so the
   * only branch of `shared_reports_org_isolation` that can match is the public
   * one — `visibility = 'public' AND revoked_at IS NULL AND expires_at > now()`.
   * The public-share rule is therefore enforced by the policy rather than by a
   * `where` clause a route could forget.
   */
  async function withPublicShare<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    assertNotNestedInProcess("withPublicShare");

    return activeScope.run({ opening: "withPublicShare" }, () =>
      database.transaction(async (tx) => {
        const scoped = tx as ScopedTx;
        await assertNotNested(scoped, "withPublicShare");
        await scoped.execute(sql`select set_config(${SCOPE_SENTINEL}, '1', true)`);
        return fn(scoped);
      }),
    );
  }

  /**
   * Audited escape hatch, for the tables that are deliberately not
   * organisation-scoped: `users`, `sessions`, `community_posts`, and
   * platform-wide aggregate counters. Logs the reason with a stack so an
   * unexplained use is visible in production logs rather than invisible in a
   * diff.
   *
   * Never legitimate for `projects`, `scans`, `findings`, `assets`,
   * `observations`, `collection_runs` or `shared_reports` — those have no
   * un-scoped read that is not a bug.
   */
  async function withoutOrgScope<T>(reason: string, fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    assertNotNestedInProcess("withoutOrgScope");
    warn(`withoutOrgScope: ${reason}`, { reason, stack: new Error("withoutOrgScope").stack });

    return activeScope.run({ opening: "withoutOrgScope" }, () =>
      database.transaction(async (tx) => {
        const scoped = tx as ScopedTx;
        await assertNotNested(scoped, "withoutOrgScope");
        await scoped.execute(sql`select set_config(${SCOPE_SENTINEL}, '1', true)`);
        return fn(scoped);
      }),
    );
  }

  return { withOrg, withPublicShare, withoutOrgScope };
}
