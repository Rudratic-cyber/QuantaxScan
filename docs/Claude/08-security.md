# 08 — Security best practices

## Why this document is not boilerplate

We are asking a CISO to send us **a complete map of their cryptographic weaknesses**. That
dataset is, from an attacker's perspective, close to ideal: it says exactly which systems use
breakable crypto, where they are, and which ones nobody is watching.

If we are breached, we do not just lose customer data — we hand an attacker a prioritised target
list for every customer at once. The security bar for this product is higher than for a normal
SaaS, and buyers in this category will run a security review before a pilot, not after.

**Our own security posture is a sales blocker or a sales asset. There is no neutral.**

---

## Findings in the current codebase

Fine for a Replit demo; disqualifying for an enterprise pilot. Listed with severity **for the
enterprise context**, not for the demo it is today.

### 🟠 S1 — No authentication anywhere — **INTERIM CONTROL SHIPPED, NOT CLOSED**

Every route in `artifacts/api-server/src/routes/` was unauthenticated. Anyone who could reach the
API could read every project, scan, and finding, and create new ones.

> **Interim mitigation landed 2026-08-02.** `artifacts/api-server/src/lib/auth.ts` adds a
> default-deny shared-API-key middleware on `/api`. Every route requires
> `Authorization: Bearer <key>` or `X-API-Key: <key>` unless it appears in the `PUBLIC_ROUTES`
> table in that file. Keys come from `QUANTAXSCAN_API_KEYS`; the server **refuses to start**
> without it, so a deployment cannot regress to an open API. Keys are compared as SHA-256
> digests with `timingSafeEqual`.
>
> Public by design: `GET /healthz`, `GET /demo/repos`, `POST /demo/repos/:slug/scan`,
> `GET /community/posts`, `GET /community/leaderboard`, `GET /reports/:id`. Everything touching
> project, scan, finding, stats, chat or GitHub data is protected, including unmatched routes.
>
> **Organisation scoping landed 2026-08-03.** The key is no longer a grant over everything: it is
> bound to one organisation by `QUANTAXSCAN_API_KEY_ORG_ID` (default 1), and every scoped read and
> write goes through `withOrg` under row-level security. See §"Tenant isolation" below and
> [13-auth-and-tenancy.md](13-auth-and-tenancy.md).
>
> **This is still not F1 and must not be recorded as S1 closed.** It carries no per-user identity:
> there is no sign-in, no session, and no way for a person to be a principal. The shared key
> remains a single secret with no rotation story and no per-caller attribution, which is why S8
> audit logging still cannot attribute access to a person — and is now the documented reason it is
> a **break-glass and machine credential** rather than the user path. Still outstanding:
>
> - Per-user identity — sign-in, sessions, providers (F1, specified in
>   [13-auth-and-tenancy.md](13-auth-and-tenancy.md) §3, not built)
> - Purging real project names from the production database — cannot be done from the repo.
>   Organisation scoping contains them to one tenant; it does not delete them.
>   **This now has a deadline.** Legacy `activity` rows carry `organization_id IS NULL`, and the
>   policy makes NULL-organisation rows readable by *every* organisation — correct for a legacy
>   global feed, and harmless while there is one tenant. Their descriptions embed real project
>   names, and `GET /api/stats` returns them. Run
>   `DELETE FROM activity WHERE organization_id IS NULL` **before a second organisation is
>   created**. The policy permits that delete; it is not a code change
> - Key rotation without downtime
>
> **The exposure stays open until the deployment sets `QUANTAXSCAN_API_KEYS` and redeploys.**
> Merging this change does not close it.

> **Escalated 2026-08-01.** This is no longer a hypothetical. The application is deployed at
> **https://quantaxscan.swotpam.com** and the unauthenticated API is reachable from the public
> internet. Verified read-only:
>
> ```
> $ curl https://quantaxscan.swotpam.com/api/projects
> [{"id":1,"name":"Kodela-website-sam", ...}]
> ```
>
> Every project in the production database is publicly listable, including real internal project
> names. `DELETE /api/projects/:id` is equally open, so any passer-by can destroy production
> data. `scans.code` holds the full source of everything ever submitted, retrievable through
> `GET /api/scans/:id`.

**Fix:** authentication + org-scoped authorisation. Previously scoped as "before the second
tenant" — that framing is now too generous. There is production data exposed today.

**Interim mitigations, in order of how fast they can ship:**

1. ~~Put the API behind auth at the edge~~ — done differently: application-level default-deny
   API key middleware, which travels with the code rather than depending on the hosting platform
2. ~~Restrict destructive verbs~~ — `DELETE /api/projects/:id` now requires a key
3. Purge real project names from the production database; treat it as a demo dataset only
   — **still outstanding, needs database access**
4. Then implement F1 properly — **still outstanding**

Whatever else is true, **the demo should not be sharing a database with anything real.**

### 🔴 S2 — Predictable share-link IDs

```ts
// artifacts/api-server/src/routes/reports.ts:9-14
function generateId(len = 10): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < len; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}
```

Two problems:

1. **`Math.random()` is not cryptographically secure.** V8's PRNG state is recoverable from a
   modest number of observed outputs, after which *all subsequent IDs are predictable*. An
   attacker who creates a handful of their own reports can enumerate other customers' reports.
2. **`GET /api/reports/:id` has no authentication, expiry, or revocation.** Anyone with the ID
   gets the full report body forever.

**Fix:** `crypto.randomUUID()` or `crypto.randomBytes(16).toString('base64url')`, plus
authentication by default, opt-in public sharing, mandatory expiry, and revocation. Given the
data these reports will carry post-migration, treat this as the single highest-priority fix in
the file.

> **Partially fixed 2026-08-02.** `generateId()` now uses `randomBytes(16).toString('base64url')`.
> This was pulled forward with S1 because `GET /api/reports/:id` was deliberately left on the
> public side of the auth allowlist, which makes the ID the only control on that route.
> `POST /api/reports` now requires a key.
>
> **The fix is forward-only.** Every row already in `shared_reports` keeps its 10-character
> `Math.random()` ID and stays anonymously reachable, so the enumeration exposure described above
> is unchanged for existing links. Closing that means re-issuing or deleting those rows, which
> needs database access rather than a code change.
>
> **Still outstanding:** authenticated-by-default with opt-in sharing, mandatory expiry,
> revocation, access logging, and the pre-existing weak IDs above.

### 🟠 S3 — Full customer source code stored in the database

`scans.code` is a `text` column holding the entire submitted file; `routes/scans.ts:38` writes it
unconditionally. `shared_reports.data` is an unbounded `jsonb` blob that may contain code
snippets. Since A1/A2 there is a third copy: the dual-write puts the matched line into
`observations.evidence.codeSnippet` (bounded, unlike `scans.code`). `assets`/`observations` have
no foreign key to a project by design, so nothing cascades them on
`DELETE /api/projects/:id` — the route reconciles them explicitly by the `project:<id>:` location
prefix (`routes/projects.ts`). **That prefix convention is the only thing keeping those snippets
from outliving a project delete**; any future code that writes assets under a different location
scheme must extend that deletion path.

**Fix:** store bounded evidence snippets only. Drop the full body. If replay is genuinely
required, make it opt-in per project with documented retention and encryption at rest.
See [04-architecture.md](04-architecture.md#also-stop-storing-customer-source-code).

### 🟠 S4 — Permissive CORS

```ts
// artifacts/api-server/src/app.ts:27
app.use(cors({ credentials: true, origin: true }));
```

`origin: true` reflects **any** origin, and `credentials: true` allows cookies with it. Once
authentication exists, this is a cross-origin credential-theft primitive.

**Fix:** explicit origin allowlist from configuration. These two options must never ship
together.

> **Fixed 2026-08-02.** `app.ts` builds the allowlist from `CORS_ALLOWED_ORIGINS`
> (comma-separated). Unknown origins get no `Access-Control-Allow-Origin` header; requests with
> no `Origin` header — curl, server-to-server — are unaffected by CORS and are gated by the API
> key instead. `cors()` stays mounted ahead of the auth middleware so OPTIONS preflight
> terminates there rather than being answered with a 401.

### 🟢 S5 — `.env` committed, and not gitignored — **CLOSED 2026-08-03**

`.env` was tracked in git and `.gitignore` did not cover it. It held only `API_BASE_URL`, so
nothing leaked — but the code already references `DATABASE_URL`, `GITHUB_TOKEN`,
`AI_INTEGRATIONS_OPENAI_API_KEY`, and `.env` is where `QUANTAXSCAN_API_KEYS` and the new database
role passwords are meant to live locally.

> **Closed 2026-08-03.** `git rm --cached .env`, plus `.gitignore` entries for `.env` and `.env.*`
> keeping `.env.example`. The `git rm --cached` is the part that mattered — adding an
> already-tracked file to `.gitignore` does nothing.
>
> No history rewrite: the file's history contains no secret, and a rewrite is destructive and
> force-push-shaped. If a secret is ever committed, rotate the credential; do not rely on a
> rewrite to have removed it.
>
> **The secret-scanner half is not done.** The pre-pilot checklist below keeps S5 unticked for
> that reason.

### 🟡 S6 — No rate limiting — **RATE LIMITS SHIPPED, QUEUE DEFERRED**

No limits on any route. `POST /api/scans` accepts 10 MB bodies and runs regex over every line;
`routes/github.ts` will fetch arbitrary repositories on request.

**Fix:** per-org rate limits, body size limits tuned per route, and a job queue for scans rather
than doing the work in the request handler.

> **Rate limits landed 2026-08-14.** `artifacts/api-server/src/lib/rate-limit.ts` adds two layers,
> mounted in `app.ts`:
>
> 1. an **IP-keyed limiter before `requireApiKey`**, because the 401 path is the one route
>    guaranteed to be reachable without a credential and was free to hammer;
> 2. a **principal-keyed limiter after it**, dispatching to a per-route budget from a table in the
>    same shape as `PUBLIC_ROUTES`.
>
> **What the budgets are keyed on, and why it is per key rather than per org.** The shared API key
> is the only principal this server has — no sign-in, no session, no person behind a request — so
> per-key is the honest unit. Keying on the organisation would be the same bucket by construction,
> since one key maps to one `QUANTAXSCAN_API_KEY_ORG_ID`, and calling it "per-org limits" would
> claim a granularity that does not exist. Public routes carry no key and fall back to the client
> address, which is a weak identifier (shared NAT collapses callers; a distributed caller escapes
> it) — which is why the public budgets are the generous ones and every expensive route sits behind
> the key. **When F1 lands** the per-route buckets should key on the user id and fall back to the
> key, so one person cannot spend a whole organisation's allowance, with an org-wide ceiling above
> it; that is a change in `principalKey()` plus one more layer.
>
> Budgets reflect cost rather than a single global number — a health check and a scan do not share
> a limit, and `GET /healthz` is exempt from the per-route layer entirely so a load balancer's
> probe cannot consume a scan's allowance. The GitHub-facing routes get the tightest allowance
> (12/hour by default) because one `/github/fetch` costs a tree call, two branch probes and up to
> 25 raw requests against a shared token whose unauthenticated ceiling is 60 requests/hour. All
> budgets are env-overridable integers (`RATE_LIMIT_*`), deliberately not an on/off switch.
>
> 429 responses carry `Retry-After` and are byte-identical whether the presented key was valid,
> invalid or absent — no `WWW-Authenticate`, one message. `rate-limit-edge.test.ts` asserts that
> directly.
>
> **`TRUST_PROXY` must be set on the deployment, and merging this does not do that.** Unset,
> `req.ip` is the proxy's address for every request and every IP-keyed bucket collapses into one
> — which rate-limits the world together, most visibly on `POST /demo/repos/:slug/scan`, the one
> journey that still works without an API key until F1. Set it to the *number* of proxies (`1`
> for a single load balancer); a bare `true` is rejected at startup because it lets a client
> forge `X-Forwarded-For` and mint a fresh bucket per request. The server logs a warning when it
> is unset. **Same shape as S1: the control is not correctly in force until the deployment sets
> the variable.** It is listed in `README.md`, `.env.example` and `docker-compose.yml`; the live
> environment is outside this repository.
>
> **Not closed, and the checklist stays unticked for all three reasons:**
>
> - **The scan queue is deliberately deferred.** It is an architectural change — a job table, a
>   worker, a status API, a UI that can render a pending scan — not a middleware, and it belongs
>   with the request-handler rework in [04-architecture.md](04-architecture.md). Rate limits cap
>   how much damage a caller can do; they do not stop a scan occupying a request handler for its
>   whole duration.
> - **The store is in-process memory.** N replicas means N × every budget and a restart resets
>   every counter. A shared store (Redis) is the real fix and is not built.
> - **Body limits are only partly per-route.** `/chat` (256 kB), `/github/fetch` and
>   `/github/scan` (8 kB) are capped; `/scans` and `/github/scan-files` keep the global 10 MB
>   because they legitimately carry source.

### 🟡 S7 — SSRF surface in GitHub scanning — **HOST VALIDATION FIXED; SEVERITY WAS OVERSTATED**

`routes/github.ts` fetches URLs derived from user input. Without strict validation this is a
server-side request forgery primitive against internal networks and cloud metadata endpoints.

**Fix:** strict allowlist (github.com API host only), reject redirects to other hosts, block
private/link-local IP ranges, enforce timeouts. Already has size caps — good — but host
validation is the important control.

> **Fixed 2026-08-14, and the finding above is corrected rather than repeated.**
>
> **What was actually broken.** `parseGithubUrl()` tested `u.hostname.includes("github.com")`,
> which is not a hostname check. Verified against the shipped implementation on Node 24 — each
> row is now a test in `artifacts/api-server/src/lib/github-url.test.ts`, which runs the old
> function alongside the new one so the table is a demonstration rather than a claim:
>
> | input | old result |
> |---|---|
> | `https://github.com.evil.example/owner/repo` | **accepted** |
> | `https://evil-github.com/owner/repo` | **accepted** |
> | `https://169.254.169.254.github.com/owner/repo` | **accepted** |
> | `http://github.com/owner/repo` | **accepted** |
> | `https://user:pass@github.com/owner/repo` | **accepted** |
> | `https://github.com:8443/owner/repo` | **accepted** |
> | `https://github.com/owner/repo%2F..%2F..` | **accepted**, repo = `repo%2F..%2F..` |
>
> Two shapes named in the original write-up **did not reproduce** and are recorded as corrections:
> `https://evil.example/?x=github.com` was already rejected (`u.hostname` excludes the query
> string) and so was `https://github.com@evil.example/...` (the host after a userinfo section is
> `evil.example`). `https://github.com/../../etc/passwd` is also not a traversal — `new URL`
> resolves dot-segments before `pathname` is read, so it arrives as owner `etc`, repo `passwd`.
>
> **What the reachable surface was, stated honestly.** The caller's *host never reached `fetch`*:
> every request is built against a hardcoded `https://api.github.com/...` or
> `https://raw.githubusercontent.com/...` with `owner` and `repo` interpolated into the path. So
> this was **not** a request-forgery primitive against internal networks or cloud metadata — the
> reachable half was **path injection into two fixed hosts**. The severity in the original finding
> was too high, and "block private/link-local IP ranges" is **moot by construction** once the host
> is an exact allowlist: there is no caller-controlled host left to resolve.
>
> **Controls now in `artifacts/api-server/src/lib/github-url.ts`:** exact hostname match against
> `{github.com, www.github.com}`; `https:` only; no embedded credentials; no explicit port;
> `owner`/`repo` matched against GitHub's real charsets (which makes `%2F`, `.` and `..`
> unrepresentable) and percent-encoded into every request URL; tree-supplied file paths encoded
> per segment with `.`/`..` refused; a 15-second `AbortSignal.timeout` per attempt; and
> `githubFetch()`, which follows redirects manually and re-validates every hop against
> `{api.github.com, raw.githubusercontent.com}`. `POST /github/scan-files` no longer echoes an
> unvalidated `repoUrl`/`owner`/`repo` back to the client — all three routes return a canonical
> URL rebuilt from the validated parts.
>
> **On the register's "redirect token leak": it was already mitigated, and not by us.** WHATWG
> Fetch deletes `Authorization` when a redirect crosses origins and undici implements it; measured
> on Node v24.14.0 against two local servers, a cross-origin 302 arrived with `authorization`
> absent while other headers survived, and a same-origin 302 kept it. `github-url.test.ts` asserts
> that against the running runtime rather than trusting the spec. Because `githubFetch` follows
> redirects manually it opts *out* of that rule, so it reimplements it — which is a real control
> we own, but it replaces a runtime guarantee rather than adding one where there was none.
>
> **Still outstanding:** the API-key middleware is the only thing keeping these routes from being
> an open outbound-request proxy for anyone on the internet, and it is a single shared key. There
> is also no allowlist of *which repositories* a caller may scan.

### 🟡 S8 — No audit logging

`pino-http` logs requests. There is no record of who viewed or exported which inventory.

**Fix:** append-only audit log of access to inventory and report data. Enterprise buyers ask for
this directly, and it is also how we investigate our own incidents.

---

## Design principles going forward

### Source code handling

Ranked by customer preference — offer the highest tier the customer will accept:

| Tier | Model | Trust required |
|---|---|---|
| **Best** | Self-hosted collectors; only findings leave the customer network | Minimal |
| **Good** | Ephemeral SaaS analysis; source in memory, never persisted, findings only | Moderate |
| **Acceptable** | SaaS with encrypted short-retention source and documented deletion | High |
| **Current** | Full source persisted indefinitely, unauthenticated | Unacceptable |

The collector-in-`lib/` decision in [04-architecture.md](04-architecture.md#package-layout) is
what makes the top tier possible later. It is a security decision as much as an architectural
one.

**This may not be optional.** If design partners refuse SaaS source ingestion — the most likely
failure mode identified in [01-strategy.md](01-strategy.md#what-would-falsify-this-thesis) —
self-hosted moves from Phase 4 to Phase 1. Ask in the first three customer conversations.

### Least privilege for collectors

Collectors touching customer infrastructure (KMS, TLS, certificates, cloud) need **read-only,
narrowly-scoped, customer-issued** credentials, with the exact required permissions documented
per collector. Never ask for admin because it is easier to document.

Store credentials in a secrets manager, never in the application database. Support customer-held
keys where possible so we cannot use a credential without the customer's involvement.

### Tenant isolation — **implemented 2026-08-03**

Multi-tenancy must be enforced at the query layer, not by convention. Every inventory query
carries `organizationId` and it is applied in a single choke point that cannot be bypassed by
forgetting a `where` clause. Test with an automated cross-tenant access suite.

That is now built, and the choke point is the **database**, because nothing else can make the
guarantee literally. Implementation and evidence:
[13-auth-and-tenancy.md](13-auth-and-tenancy.md) §5 and §9.

- `lib/db/sql/tenant-isolation.sql` — row-level-security policies on every organisation-scoped
  table, `ENABLE` plus `FORCE`. Hand-written, because `drizzle-kit push` installs policies with a
  NULL `USING` clause that permits every row while appearing installed (§5.4 — this is the single
  sharpest trap in the whole design).
- The runtime connects as `quantaxscan_app`: no table ownership, no `BYPASSRLS`. **This is what
  makes the policies real rather than decorative** — a superuser or owner connection bypasses
  them, and the code would behave identically while proving nothing.
- `withOrg` (`lib/db/src/org-scope.ts`) sets two transaction-local GUCs the policies compare
  against. It refuses to nest: a nested scope silently re-scopes its parent once its savepoint is
  released, and that is the only failure mode here that returns *another tenant's* rows rather
  than none.
- `assertTenantIsolationInstalled()` refuses to start the API server unless every scoped table has
  RLS enabled, forced, and a policy with a real `USING` expression that applies to the runtime
  role.
- No route imports the module-level `db`; a test enforces it.

Two limits worth stating plainly rather than leaving implied:

1. **A foreign key is not subject to RLS.** PostgreSQL checks referential integrity with the
   policies bypassed, so a client-supplied parent id must still be confirmed visible inside the
   scope before a child row is written. One such case existed and was fixed
   (`POST /api/scans`); it was found by the cross-tenant suite, not by review.
2. **`users`, `sessions` and `community_posts` are deliberately not scoped** — the first two are
   read before an organisation context exists, the third is public content. User enumeration is
   contained because the only path to another person is through `organization_members`, which is
   scoped.

### Data minimisation

Collect what the inventory needs and nothing more. A TLS collector needs the negotiated cipher
suite — it does not need response bodies. Every extra field is incident blast radius.

### Shared report links

Post-migration these carry a customer's full cryptographic weakness map. Requirements:
authenticated by default; public sharing explicitly opt-in per report with a warning; mandatory
expiry; revocable; access-logged; cryptographically random IDs (S2); never indexed.

---

## Pre-pilot checklist

Before the first customer with real data:

- [ ] S1 — authentication + org-scoped authorisation
      *(org-scoped authorisation shipped — see §"Tenant isolation" and
      [13-auth-and-tenancy.md](13-auth-and-tenancy.md); per-user identity still missing)*
- [ ] S2 — CSPRNG IDs, auth, expiry, revocation on shared reports
      *(CSPRNG IDs done; expiry, revocation and access-count columns exist and the public-share
      rule is enforced by the policy — the interface that sets and shows them is not built)*
- [ ] S3 — stop persisting full source
- [x] S4 — CORS allowlist
- [ ] S5 — `.env` out of git *(done)*, secret scanning in CI *(not done)*
- [ ] S6 — rate limits + scan queue
      *(rate limits shipped — two layers, per-route budgets, keyed per API key; the **scan queue
      is deliberately deferred** as an architectural change, the store is in-process so the
      budget is per replica, and body limits are only partly per-route. Three reasons this stays
      unticked, all in §S6)*
- [x] S7 — SSRF controls on GitHub fetching
      *(exact host allowlist, https-only, no credentials or port, owner/repo charset validation
      and encoding, per-hop redirect validation, request timeouts. The finding's severity was
      **overstated** — the caller's host never reached `fetch` — and §S7 records the correction
      and the two claimed bypasses that did not reproduce. Nothing here limits **which**
      repositories a caller may ask for; that is access control, not SSRF)*
- [ ] S8 — audit logging
- [ ] Encryption at rest for the inventory database
- [ ] Dependency scanning + `pnpm audit` in CI
- [ ] Documented incident response process
- [ ] Third-party penetration test — buyers will ask for the report
- [ ] Documented data retention and deletion, with a working deletion path

## Before GA

SOC 2 Type II or ISO 27001 (buyers in this category will require one), a public trust page,
a vulnerability disclosure policy, and a signed DPA template.

---

## The uncomfortable observation

We are building a tool that tells organisations their cryptography is inadequate. Every finding
in this document is the kind of thing our own product's category exists to catch.

Fixing S1–S8 before the first pilot is not just risk management — **"we ran our own standards
against ourselves, here is the report" is a sales asset.** A prospect's security team will ask.
Having a good answer converts the hardest part of an enterprise sale into a differentiator.
