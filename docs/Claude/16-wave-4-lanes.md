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

---

# What actually happened

All five lanes finished overnight on **2026-08-16**. Written by the driving session *after* the
lanes reported and *before* any merge, so the merge starts from evidence rather than from five
final messages nobody kept.

| Lane | Branch | Commits | Verified green |
|---|---|---|---|
| A | `feat/qx-e1-e2-reports` | 7 | `ci --quick`, `build`, `test:ui` 24, **e2e 136 passed / 13 skipped** |
| B | `feat/qx-c4-c5-c6-mappings` | 5 | `ci --quick`, `check:standards` (69 dated entries) |
| C | `feat/qx-c8-waivers` | 7 | `ci --quick`, `test:ui` 24, **e2e 130 passed / 13 skipped** |
| D | `feat/qx-dep-ecosystems` | 1 | `ci --quick`, **e2e 122 passed / 13 skipped** |
| E | `docs/qx-discovery-design` | 2 | docs only |

**The failure this whole scheme exists to prevent did not recur.** Verified from `main`, not taken
on report: the snapshot chain walks cleanly across all sixteen entries, and
`git diff --name-only main..<branch> -- lib/db/drizzle` is empty for A, B and D. C was the only
generator, so its `0016_snapshot.json` already pointed at `0015`'s `id` and needed no relink — the
wave-3 fork came from five lanes generating off one common parent, not from the index scheme.
`asset-ingest.ts` was touched by nobody.

## The one interaction that no test catches

**Lane C makes lane A's regulator submission lie.** E2 prints
`exceptions.registerAvailable: false` with the statement *"this product operates no waiver
register"* — deliberately, because an empty `waivers: []` would read as "there are no exceptions",
a different and unsupported claim. C builds that register. The moment both are on `main`, a
regulator-facing document asserts the absence of a feature the product ships.

Four files change together, and **nothing fails if they don't**: `regulator-submission.ts`
(`NO_WAIVER_REGISTER_STATEMENT` and the `exceptions` block), `openapi.yaml` (`registerAvailable` is
`enum: [false]`), `07-reports.md` and `03-features.md`. Do this in the same change that merges the
second of the two, not afterwards.

A related trap in the same pair: **both lanes add a field named `waivedAssets`, to different
schemas** — A's inside the regulator pack's `exceptions` block, C's on `InventoryAssetsSummary`.
They do not collide textually and they do not mean the same thing. After the merge they will
disagree, which is the same defect wearing a second face.

## Cross-lane collisions, by file

Everything below is a same-shaped-block file: **splice the other lane's block in as a unit, never
concatenate both sides** (CLAUDE.md §"Merging two parallel collector lanes").

- **`openapi.yaml`** — A, C and D. Merge **by key**, then one `codegen` run at the end; never
  hand-merge `lib/api-client-react` or `lib/api-zod`, which all three also carry.
- **`inventory-assets.ts` + `EnrichedInventoryAsset`** — A adds `effortHours`, C adds `waiver`.
  Both are field-level spec edits, which is the half `openapi-drift.test.ts` cannot see. If A's is
  dropped, cost silently falls back to derived-only and the *only* alarm is `board-pack.test.ts`'s
  "prefers an effort figure recorded against the asset".
- **`03-features.md`** — all four. Merge by row.
- **`cross-tenant.test.ts`** — A (+6 entries, 2 probes) and C (+3).
- **`routes/index.ts`** — A and C. **`routes/projects.ts`** — D, four hunks inside one function,
  one of them a name on the shared `@workspace/collectors` import line.
- **Three specs are all numbered `20-`** (`20-report-packs`, `20-waivers`,
  `20-dependency-ecosystems`). No file conflict; renumber to 20/21/22 on the way in.
- **`AGENTS.md`** — C appended one paragraph, a clean standalone append.

## Two defects opened, both pinned rather than fixed

- **G-24** (lane B) — a finite-field DH modulus is banded as if it were a curve order and silently
  loses its 2030 deprecation. Confirmed independently: `resolveToken("diffie-hellman-group14-sha256")`
  yields `{ algorithm: "ECDH/DH", keySize: 2048 }` against an entry whose `keySizeKind` is
  `"curve"`. A G-05-class wrong answer — no error, no caveat. Pinned by a test that asserts the
  wrong answer on purpose, so the fix cannot land silently. The fix is three collector files.
- **Nothing in the product can record a failed collection run** (lane E, confirmed).
  `asset-ingest.ts:309` hardcodes `status: "completed"` and is the only production insert into
  `collection_runs`, while `coverage.ts:214` branches on `"failed"` — unreachable code today. A
  collection that fails is filed as one that succeeded. In a product whose defining property is
  refusing to claim coverage it does not have, this is the wrong literal to hardcode. It belongs in
  a stage-0 commit nobody owns, before the credentialed lanes start.

Lane E's document lists five more stale claims in the docs (three feature rows still naming F4 as
the blocker for credentialed collection, which shipped; `13-auth-and-tenancy.md` §5.2's `GRANT`
list nine tables short of `ORG_SCOPED_TABLES`). None were fixed — four lanes were live in those
files at the time. They are the morning's doc sweep, not a lane's job.

## The merge, and what it cost

All five merged 2026-08-16 in the planned order — B, D, A, C, then E — with the E2/C8
reconciliation folded into C's merge commit rather than left as a follow-up. **Every merge
auto-resolved with no textual conflict**, which is precisely the state CLAUDE.md warns not to
trust: each same-shaped-block file was checked by hand afterwards for both lanes' contributions
(`cross-tenant.test.ts`, `routes/index.ts`, `inventory-assets.ts`, `openapi.yaml`), and the
generated clients were **regenerated** from the merged spec rather than accepted from the
three-way merge. Both regenerations produced no diff, which is the confirmation rather than the
assumption.

Verified on merged `main`, not inherited from a lane: the snapshot chain walks cleanly across all
sixteen entries and `drizzle-kit generate` reports "No schema changes, nothing to migrate".

Final gate: `ci --quick` all five stages, `test:ui` 24 passed, and the unfiltered e2e suite
**148 passed / 13 skipped / 0 failed**. 148 is the arithmetic of the four lanes summed against the
pre-wave baseline of 120 — the count is the check, because a merge that silently loses a spec file
still exits 0.

**One failure on the first attempt, and it was the gate working.** The two PDF tests failed
because lane A added `playwright-core` and the merge had not been followed by `pnpm install`.
`--quick` skips install; `test:api`'s 471 tests never touch the package; the API server loads it
through a dynamic import and degrades to 503 by design. So the only thing in the repository that
could see the gap was M2's own exit criterion, which refuses to accept the 503. Recorded in
AGENTS.md — a feature with a deliberate graceful fallback is the one whose absence unit tests
cannot see.

## What tonight did not buy

Discovery and credentialed collection — the actual critical path — did not move, deliberately:
every piece of that work touches `asset-ingest.ts`. Wave 4 bought breadth (four more dependency
ecosystems, three standards mappings), the two regulator artifacts, and the waivers register.
**M2's last exit criterion is closed** by lane A: a real PDF, generated from real inventory,
asserted as `200` + `%PDF-` + `%%EOF` rather than tolerating the documented 503 fallback — which
would have left the criterion open while the suite went green.

The design for what comes next is [17-discovery-design.md](17-discovery-design.md), written by a
lane that wrote no code, so tomorrow's build lane starts from a specification.
