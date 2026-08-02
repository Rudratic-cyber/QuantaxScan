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
> **This is not F1 and must not be recorded as S1 closed.** It carries no per-user identity, so
> there is no org-scoped authorisation and no tenant isolation — one key grants everything. It is
> a single shared secret with no rotation story and no per-caller attribution, which also means
> S8 audit logging cannot attribute access to a person. Still outstanding:
>
> - Per-user identity and organisation scoping enforced at the query layer (F1)
> - Purging real project names from the production database — cannot be done from the repo
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

### 🟠 S5 — `.env` committed, and not gitignored

`.env` is tracked in git and `.gitignore` does not cover it. Today it holds only `API_BASE_URL`,
so nothing has leaked — but the code already references `DATABASE_URL`, `GITHUB_TOKEN`,
`AI_INTEGRATIONS_OPENAI_API_KEY`. The next person to add one commits a secret.

**Fix now, while it is free:** add `.env` to `.gitignore`, `git rm --cached .env`, keep
`.env.example`. Add a pre-commit secret scanner.

### 🟡 S6 — No rate limiting

No limits on any route. `POST /api/scans` accepts 10 MB bodies and runs regex over every line;
`routes/github.ts` will fetch arbitrary repositories on request.

**Fix:** per-org rate limits, body size limits tuned per route, and a job queue for scans rather
than doing the work in the request handler.

### 🟡 S7 — SSRF surface in GitHub scanning

`routes/github.ts` fetches URLs derived from user input. Without strict validation this is a
server-side request forgery primitive against internal networks and cloud metadata endpoints.

**Fix:** strict allowlist (github.com API host only), reject redirects to other hosts, block
private/link-local IP ranges, enforce timeouts. Already has size caps — good — but host
validation is the important control.

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

### Tenant isolation

Multi-tenancy must be enforced at the query layer, not by convention. Every inventory query
carries `organizationId` and it is applied in a single choke point that cannot be bypassed by
forgetting a `where` clause. Test with an automated cross-tenant access suite.

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
      *(interim shared API key shipped; per-user identity and org scoping still missing)*
- [ ] S2 — CSPRNG IDs, auth, expiry, revocation on shared reports
      *(CSPRNG IDs done; auth, expiry, revocation still missing)*
- [ ] S3 — stop persisting full source
- [x] S4 — CORS allowlist
- [ ] S5 — `.env` out of git, secret scanning in CI
- [ ] S6 — rate limits + scan queue
- [ ] S7 — SSRF controls on GitHub fetching
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
