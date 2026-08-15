import { AsyncLocalStorage } from "node:async_hooks";
import { sql, type ExtractTablesWithRelations, type SQL } from "drizzle-orm";
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

/**
 * Run raw SQL and get its rows back, typed.
 *
 * `db.execute()` is typed against the driver's result HKT, which is left
 * unresolved on the generic handle above — so its return type is `unknown` and
 * every call site would otherwise need its own cast. At runtime both drivers
 * this project uses return `{ rows, fields, affectedRows }`.
 *
 * Worth stating because the design document specifies
 * `const [{ existing }] = await tx.execute(...)`, destructuring the result as
 * an array. It is not one. That destructure throws — and it is the nesting
 * guard, the one place in this mechanism where a misread fails open.
 */
export async function executeRows<T>(handle: AppDatabase | ScopedTx, query: SQL): Promise<T[]> {
  const result = (await handle.execute(query)) as unknown as { rows?: T[] } | undefined;
  return result?.rows ?? [];
}

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
  /**
   * RBAC — divisions this caller may see, and **empty means unrestricted**.
   * docs/Claude/15-rbac-design.md §4.1.
   *
   * The encoding is the load-bearing part. An org admin, an owner, and the
   * API-key principal all see every division — that is what makes them
   * administrators — and carry an empty list. A member or viewer carries the
   * divisions they hold a grant on and is confined to those plus rows with no
   * division at all. Encoding "unrestricted" as empty rather than a magic
   * value keeps the policy expression simple, and fails the right way: a
   * caller with *some* divisions is restricted to them.
   *
   * Optional so that every existing caller — and there are many — keeps
   * compiling and keeps meaning "unrestricted", which is exactly what they
   * were before divisions existed.
   */
  divisionIds?: readonly number[];
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
  const rows = await executeRows<GucRow>(
    tx,
    sql`select
      nullif(current_setting(${SCOPE_SENTINEL}, true), '') as scope_active,
      nullif(current_setting('app.current_org_id', true), '') as org_id`,
  );
  const row = rows[0];

  if (row?.scope_active != null || row?.org_id != null) {
    const where = row?.org_id != null ? `organization ${row.org_id}` : "an unscoped block";
    throw new Error(
      `${opening} cannot nest: this connection is already scoped to ${where}. ` +
        `Pass the existing ScopedTx down instead of opening a new scope.`,
    );
  }
}

/**
 * The handle a `withUserScope` callback is given: a transaction scoped to a
 * *person* and to no organisation yet.
 */
export interface UserScopedTx {
  tx: ScopedTx;
  /**
   * Promote this same transaction to also act inside `organizationId`.
   *
   * **This is the write authority, and it is why it is deliberately awkward.**
   * The row-level-security policies compare `organization_id` against
   * `app.current_org_id`; whatever is passed here becomes that value, so a
   * caller that promotes to an organisation the user is not a member of gets
   * exactly the access of a member. Verified: a second user given a forged org
   * GUC can insert their own membership row into a stranger's organisation.
   * The database cannot tell the difference, so confirming membership *before*
   * calling this is the entire control.
   *
   * There are exactly two legitimate callers:
   *   1. sign-up, promoting to an organisation this same transaction just
   *      created (so no caller-supplied id is involved at all); and
   *   2. nothing else — an ordinary request uses `withOrg`, whose organisation
   *      came from `resolvePrincipal` re-reading `organization_members`.
   */
  enterOrganization(organizationId: number): Promise<void>;
}

export interface OrgScope {
  withOrg<T>(ctx: OrgContext, fn: (tx: ScopedTx) => Promise<T>): Promise<T>;
  withUserScope<T>(userId: string, fn: (scope: UserScopedTx) => Promise<T>): Promise<T>;
  withPublicShare<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T>;
  withoutOrgScope<T>(reason: string, fn: (tx: ScopedTx) => Promise<T>): Promise<T>;
}

/**
 * The reasons `withoutOrgScope` is legitimately used on a hot path. Adding to
 * this list is a deliberate act: it downgrades an audit warning to routine, so
 * a reason belongs here only when the table it touches is genuinely not
 * organisation-scoped (`users`, `sessions`, `community_posts`).
 */
export const UNSCOPED_BY_DESIGN = [
  "public community content",
  // The three auth tables that genuinely have no organisation: a session is
  // read before anyone knows who the caller is, and a user and their provider
  // identities are read before anyone knows which tenant they act in. All
  // three happen on ordinary authenticated requests, so an undeclared warning
  // here would fire on every one of them and stop being a signal. Membership
  // is NOT on this list — it is organisation-scoped and goes through
  // `withUserScope`.
  "session store",
  "sign-in identity resolution",
] as const;

export interface OrgScopeOptions {
  /**
   * Where the audited escape hatch reports its use. Defaults to
   * `console.warn`; the API server passes its pino logger.
   *
   * `expected` distinguishes a reason that is *supposed* to appear on every
   * request from one that is not. An alert that fires thousands of times a day
   * is not an alert, so declared reasons are reported as routine and anything
   * undeclared is reported as a warning with a stack.
   */
  warn?: (message: string, detail: { reason: string; expected: boolean; stack?: string }) => void;
  /**
   * Reasons known to be legitimate and high-frequency — today, the public
   * community routes. Anything not on this list is unexpected by definition
   * and gets the loud treatment.
   */
  expectedReasons?: readonly string[];
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
  const expectedReasons = new Set(options.expectedReasons ?? []);
  const report =
    options.warn ??
    ((message, detail) => {
      if (detail.expected) console.info(message);
      else console.warn(message, detail);
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
        // A comma-separated list, because a GUC is text and `string_to_array`
        // is what the policies parse it with. Empty string is unrestricted —
        // see `OrgContext.divisionIds`.
        const divisions = (ctx.divisionIds ?? []).join(",");
        await scoped.execute(sql`select
          set_config('app.current_org_id',   ${String(ctx.organizationId)}, true),
          set_config('app.current_user_id',  ${ctx.userId},                 true),
          set_config('app.current_divisions', ${divisions},                 true),
          set_config(${SCOPE_SENTINEL},      '1',                           true)`);
        return fn(scoped);
      }),
    );
  }

  /**
   * The sign-in scope: a transaction that knows *who* the caller is and not
   * yet *which organisation* they are acting in.
   *
   * This is the one thing `withOrg` cannot express. Two reads happen before an
   * organisation is known, and both are the authorisation decision rather than
   * a consequence of it:
   *
   *   * "which organisations does this user belong to" —
   *     `organization_members`' policy has a `user_id` branch precisely so
   *     this works with no organisation GUC set; and
   *   * sign-up creating a personal organisation for a user who is, at that
   *     instant, a member of nothing.
   *
   * It is NOT `withoutOrgScope`. Both of those tables ARE organisation-scoped
   * and stay under their policies here — what changes is only that the
   * `app.current_user_id` branch is the one doing the work. Using the escape
   * hatch instead would drop the policy on the very read that decides which
   * tenant the rest of the request sees.
   */
  async function withUserScope<T>(userId: string, fn: (scope: UserScopedTx) => Promise<T>): Promise<T> {
    if (typeof userId !== "string" || userId === "") {
      throw new Error(
        "withUserScope needs a non-empty userId. The empty string is the API-key principal, " +
          "which has no person behind it and therefore no memberships to read.",
      );
    }

    assertNotNestedInProcess("withUserScope");

    return activeScope.run({ opening: "withUserScope" }, () =>
      database.transaction(async (tx) => {
        const scoped = tx as ScopedTx;
        await assertNotNested(scoped, "withUserScope");
        await scoped.execute(sql`select
          set_config('app.current_user_id', ${userId}, true),
          set_config(${SCOPE_SENTINEL},     '1',       true)`);

        let entered: number | undefined;
        const enterOrganization = async (organizationId: number): Promise<void> => {
          if (!Number.isInteger(organizationId)) {
            throw new Error(`enterOrganization needs an integer organizationId, got ${String(organizationId)}`);
          }
          if (entered !== undefined) {
            throw new Error(
              `enterOrganization was already called with organization ${entered} in this scope. ` +
                `Re-pointing a live transaction at a second organisation is the savepoint bug by another route — ` +
                `finish this scope and open a new one.`,
            );
          }
          entered = organizationId;
          // The in-process guard's record is updated too, so a nested scope's
          // error message names the organisation this transaction is now in.
          const store = activeScope.getStore();
          if (store) store.organizationId = organizationId;
          await scoped.execute(
            sql`select set_config('app.current_org_id', ${String(organizationId)}, true)`,
          );
        };

        return fn({ tx: scoped, enterOrganization });
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
    const expected = expectedReasons.has(reason);
    report(`withoutOrgScope: ${reason}`, {
      reason,
      expected,
      // The stack is what makes an unexplained use findable. It costs
      // something to capture, so only the unexpected path pays for it.
      stack: expected ? undefined : new Error("withoutOrgScope").stack,
    });

    return activeScope.run({ opening: "withoutOrgScope" }, () =>
      database.transaction(async (tx) => {
        const scoped = tx as ScopedTx;
        await assertNotNested(scoped, "withoutOrgScope");
        await scoped.execute(sql`select set_config(${SCOPE_SENTINEL}, '1', true)`);
        return fn(scoped);
      }),
    );
  }

  return { withOrg, withUserScope, withPublicShare, withoutOrgScope };
}
