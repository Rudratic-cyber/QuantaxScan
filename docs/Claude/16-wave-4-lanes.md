# 16 — In-flight lanes (wave 4)

Fanned out **2026-08-15**, overnight, against `main` at the commit that lands the RBAC frontend.
Four lanes, four branches, four git worktrees. This file is written **before** the lanes start, so
that if the driving session dies the plan survives — wave 3's lanes existed only as uncommitted
files in a locked worktree for nine hours (see [14-in-flight-lanes.md](14-in-flight-lanes.md)).

## Why these four, and not the six the roadmap would suggest

Wave 3's six-lane fan-out cost roughly a day of merge work and forked the drizzle snapshot chain
five ways. Four is the deliberate ceiling. The selection rule was **file-disjointness first,
priority second** — a P1 that collides with three other lanes is worth less than a P1 that
collides with none.

| Lane | Branch | Work | Migration | Touches `openapi.yaml` |
|---|---|---|---|---|
| A | `feat/qx-e1-e2-reports` | E1 board/executive pack + E2 regulator submission pack | none | yes |
| B | `feat/qx-c4-c5-c6-mappings` | NIST IR 8547, CNSA 2.0, CISA roadmap timeline mappings | none | no |
| C | `feat/qx-c8-waivers` | Waivers / exceptions register | **`0016` — the only lane allowed one** | yes |
| D | `feat/qx-dep-ecosystems` | Java, Go, .NET and Rust dependency parsing | none | fields only |

## The rules every lane was given

Three of these exist because **no wave-3 lane did any of them**:

1. **Commit to your own branch as you go.** A `wip(...)` commit is fine; an uncommitted tree is not.
2. **Write the e2e spec.** Writing the six missing wave-3 specs found five real payload mistakes
   that no amount of reading caught.
3. **Add or correct your row in [03-features.md](03-features.md).** Three consecutive waves missed
   this, which is why that table could not be trusted as a status source.
4. **Run `pnpm run ci --quick` before you stop**, and say in the commit message what was green.

Plus the two that are specific to running four at once:

5. **Only lane C may add a migration**, and its index is `0016`. Verified against
   `drizzle/meta/_journal.json` before the fan-out: the last entry really is `0015`
   (`0015_certain_natasha_romanoff`), so `0016` is the next free index rather than an assumption
   inherited from the session that wrote this file. Reserving an index is necessary and not
   sufficient — lane C must also relink `drizzle/meta/0016_snapshot.json`'s `prevId` to `0015`'s
   `id`, or `drizzle-kit generate` refuses to run for the next person.
6. **Own your ports.** The README/CI defaults (`55432`, `5055`, `5199`, `UI_TEST_PORT=5833`,
   container `quantaxscan-pg`) are taken by the driving session. Per-lane assignment:

   | Lane | Postgres | API | Vite | `UI_TEST_PORT` | container |
   |---|---|---|---|---|---|
   | A | 55451 | 5061 | 5201 | 5841 | `quantaxscan-pg-a` |
   | B | — (no stack needed) | — | — | — | — |
   | C | 55452 | 5062 | 5202 | 5842 | `quantaxscan-pg-c` |
   | D | 55453 | 5063 | 5203 | 5843 | `quantaxscan-pg-d` |

7. **`pnpm run test:e2e` ignores every port above.** The e2e suite provisions its *own* stack from
   `tests/e2e/support/config.ts`, whose defaults are `E2E_PG_PORT=55441`, `E2E_API_PORT=5711`,
   `E2E_UI_PORT=5712`, `E2E_CT_STUB_PORT=5713` and container `quantaxscan-e2e-pg` — identical in
   every worktree, so two lanes running it concurrently fight over one container and one database.
   The lane table originally assigned 55441 to lane A as well, which is the same clash twice over;
   it has been moved to 55451+. Each lane exports its own set before running the suite:

   | Lane | `E2E_PG_PORT` | `E2E_API_PORT` | `E2E_UI_PORT` | `E2E_CT_STUB_PORT` | `E2E_PG_CONTAINER` |
   |---|---|---|---|---|---|
   | A | 55461 | 5721 | 5722 | 5723 | `quantaxscan-e2e-pg-a` |
   | B | — | — | — | — | — |
   | C | 55462 | 5731 | 5732 | 5733 | `quantaxscan-e2e-pg-c` |
   | D | 55463 | 5741 | 5742 | 5743 | `quantaxscan-e2e-pg-d` |

   `.e2e-stack.json` and `.e2e-logs/` are written to the *worktree* root, so they do not collide.

## Deliberately held back, and why

- **F3 audit logging** — P1, and the obvious next thing. Held because it modifies the *request
  path* itself, which is the same argument doc 14 makes for landing F1 last: every other lane's
  verification would then run against a just-changed auth path, and a red would not say which lane
  caused it. It also needs a table, and only one migration can be in flight.
- **D5 crypto-agility score / E4 remediation backlog** — E4 groups by agility cluster, so D5 is its
  prerequisite. Sequenced, not parallel.
- **Credentialed collector variants** — unblocked by F4 now, but each one touches
  `asset-ingest.ts`, which is the single worst conflict magnet in the repository.
- **F6 SSO/SAML** — same request-path argument as F3.

## Merging them

[CLAUDE.md](../../CLAUDE.md) §"Merging two parallel collector lanes" applies in full. In
particular: `openapi.yaml` is merged **by key**, never by hunk, and the generated clients under
`lib/api-client-react` and `lib/api-zod` are never hand-merged — splice the spec, re-run
`pnpm --filter @workspace/api-spec run codegen`.

Suggested order: **B** (touches nothing else), then **D**, then **A**, then **C** last because it
carries the migration and the snapshot relink.
