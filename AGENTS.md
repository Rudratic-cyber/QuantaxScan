# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Testing

No test runner existed before the A1/A2 migration (2026-08-02). `vitest` is now used in
`lib/collectors`, `lib/db`, and `artifacts/api-server` — run all three with root `pnpm run test`
(`pnpm -r --if-present run test`), or one with `pnpm --filter <pkg> run test`.
DB-backed tests use `@electric-sql/pglite` (an embedded, in-process Postgres) instead of a live
database: `lib/db/src/test-support/test-db.ts` (exported as `@workspace/db/test-support`) spins
one up and applies the real migrations from `lib/db/drizzle/` via `drizzle-orm/pglite/migrator`,
so tests exercise actual `CHECK`/FK/unique-index SQL, not just the TypeScript schema. This caught
a real bug once already (see below) — don't replace it with a mocked/hand-rolled schema.

## Database migrations

`lib/db` uses `drizzle-kit push` (`pnpm --filter @workspace/db run push` / `run push-force`) as
the actual deploy mechanism against a live `DATABASE_URL` — this project has no migrate-on-deploy
step wired into `Dockerfile.api`. `pnpm --filter @workspace/db run generate` additionally produces
reviewable SQL under `lib/db/drizzle/` (both work from the schema files alone — `generate` does
not need a reachable database, only a syntactically valid `DATABASE_URL` string to satisfy
`drizzle.config.ts`'s eager check). Keep the generated migration in sync with what `push` would
actually apply; `push` is authoritative for what lands in a real database.

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

## Package boundaries

`@workspace/collectors` (`lib/collectors/`) has **no dependency on `@workspace/db`**, deliberately
— it's meant to be able to run as a standalone on-prem agent later. `lib/db` depends on
`@workspace/collectors` (for the enum tuples above), not the other way around. Keep that direction
when adding new collectors or schema.

## `pnpm run typecheck` pre-existing failures

Root `pnpm run typecheck` fails today independent of any particular change: `github.ts` (Express
`Response` typing mismatches), `reports.ts` (a drizzle query-builder overload), and `chat.ts`/etc.
(`lib/integrations-openai-ai-server` isn't in the root `tsconfig.json` project references, so its
`dist/` is never built by `tsc --build`). Confirmed present on `main` via `git stash` before this
note was written. Don't attribute these to your own changes without checking — diff the error
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

The README's example ports (Postgres `55432`, API `5055`, frontend `5199`) are shared defaults —
if another lane/worktree on the same host is already running local verification, those ports (and
container name `quantaxscan-pg`) will already be taken. Check `docker ps -a` and `ss -tln` first
and pick different ports/container name for your own session rather than reusing the examples
verbatim.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
