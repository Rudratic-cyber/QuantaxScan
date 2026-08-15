# 15 — RBAC design (F1's second half)

**Status: built, 2026-08-15 — stages 1–5 of §5, except the management *UI*.** The API, the policies
and the gate are in and proven; divisions and grants are administered over HTTP rather than in a
screen. The open questions at the end were answered by the recommendations beside them.

| Stage | State |
|---|---|
| 1 · schema | ✅ `divisions`, `division_grants`, nullable `division_id`, four roles |
| 2 · resolution | ✅ effective role + division set on the principal; API-key roles |
| 3 · write gating | ✅ one middleware, viewer-closed by default |
| 4 · read scoping | ✅ `app.current_divisions` GUC, nine policies, negative control proven able to fail |
| 5 · management | ✅ API (`/divisions`, `/organization/members`) · ⬜ UI |

F1 shipped authentication — a person can sign in, hold a session, and switch organisation. What it
did not ship is *authorisation for people*: `organization_members.role` carries a string,
`ORG_ROLE_VALUES` is `["owner", "member"]`, and **nothing reads it**. No route is gated, no two
users behave differently. This document is how that becomes real.

---

## 1. What was decided

| Decision | Choice |
|---|---|
| Where sub-organisation scoping is enforced | **In the database, via RLS** — a second GUC beside `app.current_org_id` |
| What a "division / team" is | **A first-class group that owns projects** |
| Role set | **owner / admin / member / viewer** |
| The shared API key | **Gets an explicit role, defaulting to `admin`** |

The first is the load-bearing one. Everything in
[13-auth-and-tenancy.md](13-auth-and-tenancy.md) rests on one property: *a forgotten `where`
clause returns zero rows instead of another tenant's data, because the database — not the route —
decides what is visible.* Division scoping enforced in route code would reintroduce exactly the
failure that design exists to prevent, one route at a time. So it goes in the policies.

---

## 2. The model

```
organizations                     the tenant. Unchanged.
  └── divisions                   Payments · Retail · Platform
        └── projects              a project belongs to at most one division
```

```
organization_members              user × organisation → org role      (exists, gains real meaning)
division_grants                   user × division    → division role  (new)
```

**A project's `division_id` is nullable, and null means organisation-wide.** That is what makes
this migratable: every project that exists today becomes org-wide, visible exactly as it is now, and
a tenant that never creates a division sees no behaviour change at all. Null is "belongs to no
division", not "belongs to a default division" — the same rule as `assets.key_size` and A3's
classification columns, for the same reason.

### How the two roles combine

**The org role is a floor; a division grant can only raise it.** A user's effective role on a
project is the *higher* of their organisation role and any grant on that project's division.

- `admin` and `owner` at organisation level see and act on **every** division. That is what makes
  them administrators, and it is the SaaS norm — an admin who cannot see a division cannot
  administer it.
- `member` and `viewer` at organisation level see org-wide projects (`division_id IS NULL`) plus
  the divisions they are granted, at whichever role is higher.
- A grant never *reduces* access. "Viewer on Payments" for someone who is an org `member` is a
  no-op, not a demotion. Reductions need a deny model, which is a different feature and a much
  larger one — see the open questions.

---

## 3. The capability matrix

Four roles exist because each has a distinct reason to. This is the shape the enforcement layer
will encode; every row is a decision, not a convention.

| Capability | owner | admin | member | viewer |
|---|:--:|:--:|:--:|:--:|
| Read inventory, findings, reports, coverage, timeline | ✅ | ✅ | ✅ | ✅ |
| Export CBOM, generate reports | ✅ | ✅ | ✅ | ✅ |
| Create a project, submit scans and collector data | ✅ | ✅ | ✅ | ❌ |
| Run discovery, probe targets, create collection schedules | ✅ | ✅ | ✅ | ❌ |
| Edit the OT register / vendor register | ✅ | ✅ | ✅ | ❌ |
| Delete a project | ✅ | ✅ | ❌ | ❌ |
| Register, list and revoke credentials | ✅ | ✅ | ❌ | ❌ |
| Create share links / make a report public | ✅ | ✅ | ❌ | ❌ |
| Manage members and grants, create divisions | ✅ | ✅ | ❌ | ❌ |
| Delete the organisation, transfer ownership | ✅ | ❌ | ❌ | ❌ |

Two placements worth defending:

- **Credentials are admin-only.** A stored credential is a customer's read-only key into their own
  cloud (F4). A `member` who can submit a scan has no reason to hold one, and the blast radius of
  that row is the largest in the product.
- **Share links are admin-only.** `GET /reports/:id` is public-by-link; the ID is the only control.
  Making a report public is a decision to publish outside the tenant, which is not a routine
  action.

---

## 4. The mechanism

### 4.1 A second GUC

`withOrg` currently sets two transaction-local settings. It gains a third:

```
app.current_org_id    = 7
app.current_user_id   = 'u_123'
app.current_divisions = '{2,5}'    -- new: division ids this caller may see
app.current_role      = 'member'   -- new: effective org-level role
```

`app.current_divisions` is **empty for a caller who may see everything** (an org admin/owner, or
the API-key principal at admin), and the policy reads that as "no division restriction". Encoding
"unrestricted" as an empty set rather than a magic value keeps the policy expression simple, and it
fails closed the right way: a caller with *some* divisions is restricted to them.

### 4.2 The policy shape

```sql
-- projects: the one table that carries division_id directly
CREATE POLICY projects_org_isolation ON projects ... USING (
  organization_id = nullif(current_setting('app.current_org_id', true), '')::int
  AND (
    current_setting('app.current_divisions', true) IS NULL
    OR current_setting('app.current_divisions', true) = ''      -- unrestricted
    OR division_id IS NULL                                       -- org-wide project
    OR division_id = ANY(string_to_array(current_setting('app.current_divisions', true), ',')::int[])
  )
);
```

Read-side scoping is the whole of it for `viewer`; write gating is §4.4.

### 4.3 The problem this design has to solve: tables with no project

Only four tables carry a `project_id`:

| Carries `project_id` | Does not |
|---|---|
| `scans`, `discovered_targets`, `network_flows`, `collection_schedules` | `findings`, `assets`, `observations`, `collection_runs`, `activity`, `shared_reports` |

`assets` associates to a project by a **text prefix** in `location` (`project:7:...`), and
`findings` reach a project through `scan_id`. Neither is something an RLS policy can filter on
cheaply or safely — parsing a text prefix in a policy that runs on every row of every query is both
slow and fragile, and a policy that gets it subtly wrong is the silent-wrong-answer failure mode
this project cares most about.

**Recommendation: denormalise `division_id` onto the tables that need it**, written at ingest from
the project the row belongs to, and add it to the policy exactly as on `projects`.

- Rows with no project (a TLS endpoint, a submitted certificate, a KMS key inventory) keep
  `division_id IS NULL` and stay org-wide, which is honest: they genuinely belong to no division.
- The alternative — a subquery per row against `projects` — is correct but puts a correlated
  subquery in the hot path of every inventory read.
- The alternative to *that* — leaving `assets` org-scoped — would mean a viewer restricted to
  Payments still sees the whole estate's assets through `/api/inventory`. That is worse than not
  shipping the feature, because the UI would say "Payments" while the numbers cover everything.

This is the largest single piece of work in the plan and the one most likely to need revisiting
once measured.

### 4.4 Write gating

Reads are shaped by RLS. **Writes are gated in one place**, not per route: a
`requireRole("admin")` middleware factory applied at the router, mirroring how `requireAuth` works
today. Two properties it must have:

1. **A route that names no role is denied to `viewer` by default.** Fail closed: adding a route
   without thinking about roles must not silently grant write access to a read-only account.
2. **The manifest test grows a role column.** `cross-tenant.test.ts` already fails when a route
   exists that it does not name; it gains the required role per route, so a new route cannot ship
   without that decision being made explicitly. This is the mechanism that keeps the matrix in §3
   true a year from now.

### 4.5 The API key

```
QUANTAXSCAN_API_KEYS          = k1,k2
QUANTAXSCAN_API_KEY_ORG_IDS   = 7,7
QUANTAXSCAN_API_KEY_ROLES     = admin,viewer      # new, positional, defaults to admin
```

Defaulting to `admin` keeps every existing deployment and CI script working unchanged. Defaulting
to `viewer` would be safer in the abstract and would silently break every writer on upgrade, which
is the worse failure. A read-only integration key becomes possible for the first time — which is
the feature several of these decisions were really for.

**Without this, RBAC is theatre**: the credential every deployment already holds would bypass every
role.

---

## 5. Rollout order

Each step is separately deployable and none breaks the step before it.

1. **Schema, unenforced.** `divisions`, `division_grants`, nullable `division_id` columns, widened
   `ORG_ROLE_VALUES`. Everything defaults to null/org-wide, so behaviour is identical.
2. **Resolution, unenforced.** `resolvePrincipal` computes the effective role and division set and
   puts them on the principal. Nothing reads them yet; the values are asserted in tests.
3. **Write gating.** `requireRole` on every route, manifest test extended. This is the first step
   with visible behaviour, and it is the reversible one.
4. **Read scoping.** The GUC and the policies. Last, because it is the step where a mistake returns
   the wrong rows rather than an error — and it lands on a tree where everything else is already
   proven.
5. **Management surface.** Routes and UI for divisions, members and grants. Until this exists,
   grants are made by an operator script, exactly as `create-organization` works today.

---

## 6. How it was proven

All four, and the first was demonstrated rather than asserted:

- **The negative control was proven able to fail.** Removing the division clause from the
  `projects` policy fails exactly the two isolation assertions in
  `lib/db/src/division-isolation.test.ts` and leaves the other ten passing — including the control
  itself. A suite that goes green without that demonstration is evidence of nothing.
- **Cross-division reads** — twelve tests, every query with **no `where` clause at all**, because
  the database is what scopes and the routes do not filter. Two cover the denormalised columns
  specifically: another division's assets are invisible, and its collection runs cannot be counted
  into a coverage meter.
- **Every role against the route table** — `cross-tenant.test.ts` asserts the admin set matches an
  explicit list in both directions, and that every write is unreachable by a viewer, which is what
  catches a route nobody considered.
- **Two principals end to end** — `tests/e2e/19-rbac.spec.ts`, two API keys in the *same*
  organisation at different roles against real PostgreSQL, so every difference it observes is
  caused by the role and nothing else.

---

## 7. Questions that were open, and how they were answered

All five took the recommendation beside them. Recorded because the answers are now load-bearing:

1. **Can a grant reduce access?** No — grants only raise. `strongerRole()` is the whole
   implementation, and a deny model remains a separate, larger feature.
2. **Do divisions nest?** No, flat. The GUC is a flat id list and the policy is one `= ANY(...)`.
3. **Can a project move between divisions?** Yes, admin-only — **and the follow-up is real**: an
   asset's `division_id` is stamped at ingest, so moving a project leaves already-ingested rows on
   the old division until the next collection. Recorded as the one loose end of stage 4.
4. **What does a viewer see of other divisions?** They exist by name — `GET /divisions` is
   deliberately readable by a viewer and holds none of their data.
5. **Does an org member write to org-wide projects by default?** Yes — a project with
   `division_id IS NULL` is visible and writable to the whole tenant, which is what every project
   created before divisions carries.

## 8. What is not built

- **The management UI.** Divisions and grants are administered over HTTP. The API is complete and
  spec'd; the screen is not written.
- **Moving a project between divisions** does not re-stamp already-ingested rows (see question 3).
- **Invites.** `POST`/`DELETE /organization/members` are gated in `require-role.ts` but not
  implemented — adding a member needs an email flow, which is its own feature.
