# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Testing

No test runner existed before the A1/A2 migration (2026-08-02). `vitest` is now used in
`lib/collectors`, `lib/db`, and `artifacts/api-server` — run with `pnpm --filter <pkg> run test`.
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

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
