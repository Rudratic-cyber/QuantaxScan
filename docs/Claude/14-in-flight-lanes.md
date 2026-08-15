# 14 — In-flight lanes (wave 3)

**Status: six branches exist, all committed, none merged. Read this before starting new work,
because the thing you are about to build may already be sitting on one of them.**

Wave 3 was fanned out on 2026-08-15 against `main` at `3a33eeb` — six agents, six branches, one
brief. The session driving them ended while all six were still working. Every lane's work existed
only as uncommitted files in a locked worktree for roughly nine hours, which is one
`git worktree remove` from gone and invisible to anyone reading the repository.

They are now committed on their own branches as **honest snapshots**: each commit message says
what the lane built, and lists what it never got to. Nothing here has been verified. A `wip(...)`
commit in this repository means exactly that — the tree it names has never had `pnpm run ci`
pointed at it.

## The lanes

| Branch | Snapshot | Reserved migration | What it builds |
|---|---|---|---|
| `feat/qx-f4-secret-handling` | `bdabf12` | `0009` | F4 — encrypted `credentials` table and the credential-reference contract; the blocker every credentialed collector waits on |
| `feat/qx-discovery` | `aa40122` | `0010` | CT-log host discovery + DNS corroboration into `discovered_targets`; the first thing that names a host the customer did not supply |
| `feat/qx-network-flow` | `cb4f3a2` | `0011` | The `network-flow` surface — conversations, from flow/session records the estate already produces. No packet capture |
| `feat/qx-m3-continuity` | `f54175a` | `0013` | D4 drift (computed, never persisted) + scheduled re-collection |
| `feat/qx-f1-authentication` | `a835ca2` | `0014` | F1 — identity providers, sessions, `/auth/*`. GitHub implemented; Google and Microsoft deliberately deferred |
| `feat/qx-endpoint` | `6b02fb9` | none | The `endpoint` surface — host fleet certificate stores and TLS policy. No agent ships; this is the report format one would report against |

`0012` was reserved and never used.

## What every one of them is missing

The brief made three things mandatory and **no lane completed any of them**, because all six were
interrupted at roughly the same moment:

- **No e2e spec.** `tests/e2e/` is untouched on all six branches.
- **No row in [03-features.md](03-features.md).** This is the third consecutive wave to miss it,
  which is why that file cannot currently be trusted as a status source — see below.
- **No verification.** `pnpm run ci --quick` was never run against any of these trees, let alone
  `test:ui` or an e2e run.

One lane is missing something worse: `feat/qx-f1-authentication` adds **six routes and no
`lib/api-spec/openapi.yaml` entry**, so no generated client can see them and
`openapi-drift.test.ts` fails as it stands. It also carries `lib/db/rls-probe-f1.mjs`, a scratch
probe committed only so it would not be lost, which must not survive the merge.

## Merging them

The rules are in [CLAUDE.md](../../CLAUDE.md) §"Merging two parallel collector lanes" and they
all apply — five of the six touch `asset-ingest.ts`, `openapi.yaml`, the generated clients,
`cross-tenant.test.ts` and `tenant-isolation.sql`. **Never resolve those by keeping both sides.**

One thing wave 3 got right that wave 2 did not: the brief reserved a distinct migration index per
lane, so `drizzle/meta/_journal.json` conflicts are append-only and resolvable rather than the
unmergeable ordered-ledger collision CLAUDE.md warns about. Preserve each lane's reserved index
when resolving; do not renumber to "the next free number".

Suggested order, by what other lanes depend on:

1. **`f4-secret-handling`** — lowest reserved index, and the credential contract is what F1 and any
   future credentialed collector build against.
2. **`f1-authentication`** — largest outstanding defect (the spec drift), and it is the platform
   feature the audit-logging and RBAC work needs underneath it.
3. **`discovery`**, then **`network-flow`**, **`endpoint`** — the three coverage lanes. The last
   two both flip a surface to `live`, so **both** must be reflected in the live-collector count
   test; taking either side whole silently demotes the other.
4. **`m3-continuity`** — touches the fewest shared collector files.

## Status drift found while writing this

`03-features.md` had three false claims on `main`, all of which survived commit `2f0c7db`, whose
entire purpose was bringing status claims back in line. They are corrected in the same change that
adds this file. Treat the feature table as evidence, not as truth: check the route, the page and
the spec before believing a row.

- **D1 read `planned`** while the readiness dashboard had shipped — `GET /api/inventory/readiness`,
  `Readiness.tsx` routed at `/readiness`, and `tests/e2e/06-readiness.spec.ts`.
- **Three separate rows each claimed to be "the fifth `live` surface"** — kms, config and
  data-at-rest. By the catalogue's own order they are fifth, sixth and seventh.
- **The estate timeline tells the user something that is no longer true.** `posture-timeline.ts`
  renders the certificate-expiry row as *"A certificate's notAfter has nowhere to live in the asset
  model and no certificate collector has shipped"*. B4 shipped: `notAfter` travels on
  `assets.location_detail`, and `evaluateCertificateExpiryAgainstQDay` already computes the verdict
  for the per-project certificates route. This is customer-facing copy understating the product,
  and it is the one item here that needs a build rather than an edit — doc 06 Row 5, described in
  the roadmap as the strongest visual in the product. Tracked as **G-22** in
  [09-open-gaps.md](09-open-gaps.md).
