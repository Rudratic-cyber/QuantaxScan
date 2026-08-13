# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Testing

Root `pnpm run test` runs three suites in sequence — `test:libs` (vitest in `lib/collectors` and
`lib/db`), `test:api` (vitest + supertest in `artifacts/api-server`), `test:ui` (Playwright specs
in `tests/ui/`). Run one package's vitest suite directly with `pnpm --filter <pkg> run test`.
**`test:ui` is not free to run:** it needs the Playwright browsers installed and it boots its own
Vite dev server on `UI_TEST_PORT` (default `5833`) with `strictPort`, so it fails loudly if that
port is taken — see the port-collision note below. Suite contents and the CI pipeline live in
[docs/Claude/12-test-suite.md](docs/Claude/12-test-suite.md).

DB-backed tests use `@electric-sql/pglite` (an embedded, in-process Postgres) instead of a live
database: `lib/db/src/test-support/test-db.ts` (exported as `@workspace/db/test-support`) spins
one up, applies the real migrations from `lib/db/drizzle/` via `drizzle-orm/pglite/migrator`, and
then applies `lib/db/sql/tenant-isolation.sql` verbatim — so tests exercise actual
`CHECK`/FK/unique-index SQL and the real RLS policies, not just the TypeScript schema. This caught
a real bug once already (see below) — don't replace it with a mocked/hand-rolled schema.

**Any test that touches organisation-scoped data must pass
`createTestDb({ asRole: "quantaxscan_app" })`.** PGlite connects as `postgres`, which is
`rolbypassrls = t`: with RLS enabled, FORCEd, and no GUC set at all, a plain `SELECT` still
returns every row across every organisation. A cross-tenant test written against the default
harness **passes while proving nothing**. The negative control in
`lib/db/src/tenant-isolation.test.ts` exists to keep that honest and should be the first thing
read there. Two pglite specifics: `client.query()` rejects multi-statement SQL (use `exec()`), and
`db.execute()` returns `{ rows, ... }` rather than an array — use `executeRows<T>()` from
`@workspace/db/org-scope`.

## Database migrations

`lib/db` uses `drizzle-kit push` (`pnpm --filter @workspace/db run push` / `run push-force`) as
the actual deploy mechanism against a live `DATABASE_URL` — this project has no migrate-on-deploy
step wired into `Dockerfile.api`. `pnpm --filter @workspace/db run generate` additionally produces
reviewable SQL under `lib/db/drizzle/` (both work from the schema files alone — `generate` does
not need a reachable database, only a syntactically valid `DATABASE_URL` string to satisfy
`drizzle.config.ts`'s eager check). Keep the generated migration in sync with what `push` would
actually apply; `push` is authoritative for what lands in a real database.

**`drizzle-kit push` is authoritative for tables, columns, indexes and constraints — and must
never be used for row-level security.** It creates policies with a **NULL `USING` clause**, which
permits every row while `\d+` and `pg_policies` both show the policy as present. RLS reads as
installed and there is no isolation at all. Reproduced twice from an empty database against
PostgreSQL 16.14; `generate` emits the correct SQL, `push` drops the expression. Therefore:

- Policies, roles and grants live in `lib/db/sql/tenant-isolation.sql`, applied by
  `pnpm --filter @workspace/db run apply-rls` **after** `push`.
- `.enableRLS()` and `pgPolicy()` are not used in the schema files, so `push` never manages them.
- `assertTenantIsolationInstalled()` gates API-server startup on the real `pg_class`/`pg_policy`
  state, so a future `push` regressing it cannot go unnoticed. A deploy that has not run
  `apply-rls` will refuse to boot — that is intended.
- `pnpm --filter @workspace/db run apply-tenancy` is the one-time data migration (add nullable →
  backfill → constrain), which neither `push` nor a generated migration can do on a populated
  table. Full order and rationale: [docs/Claude/13-auth-and-tenancy.md](docs/Claude/13-auth-and-tenancy.md) §10.

**The runtime must connect as `quantaxscan_app`** — a role with no table ownership and no
`BYPASSRLS`. Connect as the owner or a superuser and every policy is inert while the code behaves
identically. That credential swap is what makes tenant isolation real rather than theatre.

**Sharp edge:** a `CHECK` constraint built from `sql\`${value}\`` for a plain string produces a
`$n` bind-parameter placeholder — invalid inside DDL, since there is nothing to bind against at
migration-apply time. Build `CHECK (col IN (...))` expressions with `sql.raw()` over escaped
string literals instead (see `lib/db/src/schema/sql-helpers.ts`'s `oneOf()`). `drizzle-kit
generate` does not catch this — only actually running the generated SQL does (the pglite test
harness above caught it).

Shared enums that need both a DB constraint and a TypeScript type (`DiscoveryModality`, `Surface`,
`AssetStatus`, ...) are defined exactly once, as const tuples in `@workspace/collectors`
(`lib/collectors/src/enums.ts`). The DB layer uses `text` + a `CHECK` derived from the same tuple,
not a Postgres `ENUM` type — narrowing an `ENUM` requires recreating the type; narrowing a `CHECK`
from the same tuple is a one-line diff. Don't introduce a second definition of one of these enums
anywhere else.

**Two recorded exceptions**, both in `lib/db` rather than `@workspace/collectors`: auth and
tenancy enums (`ORG_ROLE_VALUES`, `IDENTITY_PROVIDER_VALUES`, `REPORT_VISIBILITY_VALUES`) in
`lib/db/src/schema/auth-enums.ts`, and A3's `DATA_CLASSIFICATION_VALUES` in
`lib/db/src/classification.ts`. The rule above exists because those enums are part of the
*collector* contract and `lib/collectors` is deliberately dependency-free so it can ship as a
standalone on-prem agent — an on-prem collector has no concept of an organisation role, an
identity provider, or whether the data behind a key is Regulated. The rule's mechanism (one const
tuple, `text` + `CHECK` via `oneOf()`, never a Postgres `ENUM`) is preserved exactly.

**Null means "not supplied", and several columns depend on it.** `assets.key_size` (G-05) and
A3's `data_classification` / `secrecy_lifetime_years` on both `assets` and `projects` are nullable
with **no database default**, deliberately. Adding `NOT NULL DEFAULT ...` to any of them destroys
the difference between a value a human supplied and one nobody ever set — which is what lets a
report state that an X was assumed. Provenance is derived by `resolveSecrecyLifetime()`
(`@workspace/db/classification`), never stored, so it cannot go stale when a project default
changes.

## Tenant isolation

Read [docs/Claude/13-auth-and-tenancy.md](docs/Claude/13-auth-and-tenancy.md) before changing
anything under `lib/db/sql/`, `lib/db/src/org-scope.ts`, or any route's database access. §13 lists
the failure modes that produce a *silently wrong result rather than an error*, which is the whole
reason that file is long.

The rules that matter day to day:

- **Route files never import `db`** — they use the `ScopedTx` handed to them by `withOrg`,
  `withPublicShare` or `withoutOrgScope`. `artifacts/api-server/src/db-import.test.ts` enforces
  this. A query on `db` inside a `withOrg` callback runs on a different connection, outside the
  transaction and therefore outside the GUC the policies read.
- **Scopes do not nest.** All three helpers throw if one is already open. A nested scope silently
  re-scopes its parent once its savepoint is released — the only failure here that returns
  *another tenant's* rows rather than none. Pass the `ScopedTx` down instead.
- **A foreign key is not subject to RLS.** PostgreSQL checks referential integrity with policies
  bypassed, so a client-supplied parent id must be confirmed visible *inside the scope* before
  writing a child row. `POST /api/scans` does this; anything new taking a parent id must too.
- Adding a route? `artifacts/api-server/src/cross-tenant.test.ts` carries a manifest of every
  route and fails if one exists that it does not name. That is deliberate — decide whether a new
  route is org-scoped before it ships.
- Adding an organisation-scoped table? Add it to `ORG_SCOPED_TABLES`
  (`lib/db/src/tenant-isolation.ts`), give it a policy in `tenant-isolation.sql`, and grant it.
  A table with no grant is unreachable by the runtime, which is the fail-closed default.

## Package boundaries

`@workspace/collectors` (`lib/collectors/`) has **no dependency on `@workspace/db`**, deliberately
— it's meant to be able to run as a standalone on-prem agent later. `lib/db` depends on
`@workspace/collectors` (for the enum tuples above), not the other way around. Keep that direction
when adding new collectors or schema.

## `pnpm run typecheck` pre-existing failures

Root `pnpm run typecheck` fails today independent of any particular change — 14 errors in
`artifacts/api-server`: `github.ts` (Express `Response` typing mismatches), `reports.ts` (a
drizzle query-builder overload), and `chat.ts`/etc. (`lib/integrations-openai-ai-server` isn't in
the root `tsconfig.json` project references, so its `dist/` is never built by `tsc --build`).
Confirmed present on `main` via `git stash` before this note was written. Don't attribute these to your own changes without checking — diff the error
list against `git stash && pnpm run typecheck && git stash pop` first.

`artifacts/quantaxscan` (frontend) independently has its own 13-error pre-existing baseline
(`Typewriter.tsx`, `quantaxscan-terminal.tsx`, `Dashboard.tsx`, `Scan.tsx` — mostly implicit-`any`
and a couple of real-but-minor type mismatches). `pnpm run build` gates on `pnpm run typecheck`
and so reports "failed" even though the app itself builds and runs fine — api-server builds with
esbuild (no typechecking) and vite doesn't block on `tsc` errors either. To get real build output,
run `pnpm -r --if-present run build` directly, bypassing the typecheck gate.

## Merging across a directory rename

`main`'s `q-vuln` → `quantaxscan` rename (`26da89e`) is a real rename as far as git is concerned —
`git merge`/`git merge-tree` correctly pair each old-path file with its new-path counterpart via
similarity detection and 3-way-merge the content at the **new** path, even when the other side
never touched the new path directly (confirmed with a `git merge-tree --write-tree` dry run before
committing to anything). Genuinely new files/directories a branch adds inside the old tree have no
rename mapping to follow: git flags them as "file location" conflicts (already computed at the
correct destination, just needs `git add`) or, for a directory with zero prior existence on either
side, leaves them at the old path for a manual `git mv`.

Where this goes wrong is trusting an *unconflicted* hunk just because git didn't print conflict
markers. If one side is a near-total rewrite of a file (a theme/design change, not just renamed
identifiers), a 3-way merge can silently interleave two different eras of the same function in a
region that never triggered a textual conflict — e.g. dropping a prop's destructuring because one
side added it and the other side's surrounding lines happened to still line up. The tell: diff the
file against `main`'s real HEAD after resolving and see if anything looks structurally incomplete,
not just diff-clean. When one side of a conflicted file is a nearly-total rewrite, don't hunk-merge
it — diff `main` against the merge-base for that file (isolates what `main` actually changed since
divergence), take the other side's full content, and reapply just that delta on top.

## Local dev ports collide with other concurrent worktrees

The README's example ports (Postgres `55432`, API `5055`, frontend `5199`) and the Playwright UI
suite's `UI_TEST_PORT` (default `5833`) are shared defaults — if another lane/worktree on the same
host is already running local verification, those ports (and container name `quantaxscan-pg`) will
already be taken. Check `docker ps -a` and `ss -tln` first and pick different ports/container name
for your own session rather than reusing the examples verbatim.

## Frontend sharp edges

`ScrollArea` (`components/ui/scroll-area.tsx`) silently clips horizontally. Radix gives the
viewport's content wrapper an inline `display: table`, which sizes to max-content, and this
component renders only a vertical `ScrollBar` — so anything wider than a narrow panel is cut off
with no way to reach it. Pass `viewportClassName="[&>div]:block!"` when the panel is narrow and
the content must wrap (see the Demo findings rail). Tailwind here is **v4**: the important
modifier is a trailing `!` (`block!`), not the v3 leading `!`.

The API server refuses to start unless every `QUANTAXSCAN_API_KEYS` entry is ≥24 characters.
Local verification is normally done **keyless** in the browser — that is the real deployed
condition until per-user accounts land, and it is what exercises the 401 paths.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
