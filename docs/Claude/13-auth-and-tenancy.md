# QuantaXscan — Per-user authentication, organisation scoping, and authenticated scanning

**The design for authentication and tenancy, and the record of what is built.**

| | |
|---|---|
| **Written** | 2026-08-03, against base commit `2c0e5bd` |
| **Phase 1 built** | 2026-08-03 — schema, migration, roles, grants, policies, `withOrg`, the startup gate, and the cross-tenant suite |
| **Closes** | S5 / G-13 (`.env` out of git) · the tenant-isolation requirement at [08-security.md](08-security.md) §"Tenant isolation" |
| **Does NOT close** | S1 (no per-user identity yet) · S2's auth/expiry/revocation UI · G-12's remainder |
| **Status of the rest** | P2 onward are specified below and **not built**. Everything about sign-in, sessions, providers and the interface is design, not description. |

**How to read this.** [§4](#4-the-data-model-and-its-migration), [§5](#5-query-scoping-as-a-choke-point)
and [§9.1–9.3](#9-test-strategy-including-cross-tenant-proof) describe code that exists — read them
as documentation. [§3](#3-the-sign-in-flow), [§6](#6-the-api-boundary), [§7](#7-the-interface) and
[§8](#8-private-repository-scanning--specified-sequenced-last) are specification for phases not yet
built. [§10](#10-what-ships-when) says which is which, and
[§13](#13-five-things-that-will-bite-the-implementer) is the list of things that fail *silently* —
worth reading before touching any of it.

Where a decision is genuinely the captain's rather than the implementer's, it is called out in
[§12](#12-decisions-that-are-the-captains-not-mine) with the default that was built.

---

## Contents

1. [Why the order of this document is not the brief's order](#1-why-the-order-of-this-document-is-not-the-briefs-order)
2. [Foundational decisions](#2-foundational-decisions)
3. [The sign-in flow](#3-the-sign-in-flow)
4. [The data model and its migration](#4-the-data-model-and-its-migration)
5. [Query scoping as a choke point](#5-query-scoping-as-a-choke-point)
6. [The API boundary](#6-the-api-boundary)
7. [The interface](#7-the-interface)
8. [Private-repository scanning](#8-private-repository-scanning--specified-sequenced-last)
9. [Test strategy, including cross-tenant proof](#9-test-strategy-including-cross-tenant-proof)
10. [What ships when](#10-what-ships-when)
11. [What I would not build](#11-what-i-would-not-build)
12. [Decisions that are the captain's, not mine](#12-decisions-that-are-the-captains-not-mine)
13. [Five things that will bite the implementer](#13-five-things-that-will-bite-the-implementer)
14. [Deviations from the specification as built](#14-deviations-from-the-specification-as-built)
- [Appendix A — Evidence log](#appendix-a--evidence-log)
- [Appendix B — Citations](#appendix-b--citations)

---

## 1. Why the order of this document is not the brief's order

Three facts determine everything downstream, and two of them contradict what a reasonable
implementer would assume. They are settled first.

**a. Production is same-origin. The repo's Docker topology is not.**
`https://quantaxscan.swotpam.com/` serves the SPA and `https://quantaxscan.swotpam.com/api/healthz`
serves the API — same origin, confirmed by `curl` and by the deployed runtime config
(`config.js` → `window.__APP_CONFIG__ = { apiBaseUrl: "" }`). `docker-compose.yml`, by contrast,
runs the frontend on `:5173` and the API on `:5000` — cross-origin. **Same-origin is the supported
topology.** This is what makes `SameSite=Lax` and the `__Host-` cookie prefix usable and makes CORS
irrelevant in production. Cross-site cookies (`SameSite=None`) are **not** specified and must not be
introduced. The split dev compose gets a Vite dev-server proxy instead (§6.6).

**b. The live API was still open when this was written.** Verified 2026-08-03:

```
$ curl -s -o /dev/null -w "%{http_code}" https://quantaxscan.swotpam.com/api/projects
200
$ curl -s https://quantaxscan.swotpam.com/api/projects | head -c 60
[{"id":1,"name":"Kodela-website-sam","description":null,"lang…
```

This is not new information — `08-security.md` predicts it exactly ("*The exposure stays open until
the deployment sets `QUANTAXSCAN_API_KEYS` and redeploys*"). It is recorded here because it is a
**precondition of this work, not part of it**: setting that variable is a deployment action, and
none of the phases below should be used as a reason to defer it. Nothing in P1 changes it either
way — P1 is a database and application change, not a deployment one.

**c. `drizzle-kit push` silently installs RLS policies with no `USING` clause.**
This is the single most consequential finding in this report and it inverts a rule in `AGENTS.md`.
Verified twice, from an empty database, against real PostgreSQL 16.14 — see
[§5.4](#54-the-drizzle-kit-push-trap) and [Appendix A.3](#a3--drizzle-kit-push-drops-rls-policy-expressions).
A policy with a NULL qualifier permits everything. Row-Level Security would appear installed,
every test would pass, and there would be no tenant isolation at all.

---

## 2. Foundational decisions

### 2.1 Key types are already decided by existing data — do not "fix" them

| Column | Actual type at `2c0e5bd` | Consequence |
|---|---|---|
| `assets.organization_id` | `integer NOT NULL` (`lib/db/src/schema/assets.ts:24`) | `organizations.id` **must be `serial`/`integer`**, not `uuid` |
| `collection_runs.organization_id` | `integer NOT NULL` (`lib/db/src/schema/collection_runs.ts:22`) | same |
| `users.id` | **`varchar`** with `default gen_random_uuid()` (`lib/db/src/schema/auth.ts:15`) | not `uuid`; every FK to a user is `varchar` |

The brief describes `users.id` as `uuid`. It is `varchar`. Both columns work, but a mixed
declaration will produce an FK type mismatch at migration time. `organization_members` is therefore
`(organization_id integer, user_id varchar)`. **Do not retype either column.** Retyping
`assets.organization_id` would force a rebuild of `assets_org_fingerprint_idx` and
`assets_org_location_status_idx` on populated tables for no benefit.

Existing rows are already consistent: `artifacts/api-server/src/lib/asset-ingest.ts:23` hardcodes
`DEFAULT_ORGANIZATION_ID = 1`, so every `assets` and `collection_runs` row in production is
organisation `1`. The captain's organisation is therefore created **as id `1`**, and the backfill for
those two tables is a no-op.

### 2.2 The existing `auth.ts` tables are the right foundation, with exactly one change

`lib/db/src/schema/auth.ts` is not a generic scaffold — it is a near-verbatim copy of
`connect-pg-simple`'s `table.sql`, paired with a user table shaped to Replit Auth's OIDC claim set.
The evidence is exact: Replit's live discovery document at `https://replit.com/oidc` advertises
`claims_supported: ["sub","username","first_name","last_name","profile_image_url","email",
"email_verified","sid","auth_time","iss"]` (retrieved 2026-08-03). Compare to `usersTable`:
`first_name`, `last_name`, `profile_image_url`, `email`. That is a 1:1 mapping, and `UpsertUser`
exists because the Replit pattern upserts the user on every login from those claims.

| Table | Verdict | Action |
|---|---|---|
| `sessions` | **Sufficient**, with one fix | Keep `sid varchar PK`, `sess jsonb`, `IDX_session_expire`. Change `expire` to `timestamptz` (§2.3). Pass `tableName: "sessions"` — `connect-pg-simple`'s default is `session`, **singular** |
| `users` | **Sufficient as a profile table**, insufficient as an identity table | Keep every column. Keep `id varchar default gen_random_uuid()` and **let the default generate it** — under the Replit pattern `id` was the single provider's `sub`; with three providers it must be an internal ID. Provider subjects move to `user_identities` (§4.2) |
| — | **Missing** | Organisations, membership, roles, provider identities. Added, not substituted |

`sess` as `jsonb` rather than upstream's `json` is fine and slightly better: `connect-pg-simple@10`'s
write is `INSERT INTO "<table>" (sess, expire, sid) SELECT $1, to_timestamp($2), $3 ON CONFLICT (sid)
DO UPDATE …` with an *untyped* `$1`, so PostgreSQL infers the parameter type from the target column.
Verified working against a `jsonb` column — [Appendix A.4](#a4--connect-pg-simple-against-the-existing-sessions-shape).

### 2.3 `sessions.expire` must become `timestamptz` — this is a real bug, not a preference

`connect-pg-simple` compares `expire >= to_timestamp($2)`. `to_timestamp()` returns `timestamptz`;
the column is `timestamp without time zone` (drizzle's `timestamp("expire")` with no
`withTimezone`). PostgreSQL resolves that comparison by interpreting the stored value as local time
in the session's `TimeZone`. Rows written under one `TimeZone` and read under another expire wrong —
verified: a session written under `Etc/GMT0` and valid for 24 h reported as **already expired 13 h
in** when read under `Pacific/Auckland`, and correct under `UTC`. Switching the column to
`timestamptz` makes it correct under every `TimeZone` tested. Full transcript:
[Appendix A.5](#a5--the-sessionsexpire-timezone-bug-and-its-fix).

Every other timestamp in this schema already uses `withTimezone: true`. `expire` is the only
exception. Fix it in this migration.

### 2.4 Row-Level Security is real here, but only if four things are pinned

The security document's requirement is literal: *"applied in a single choke point that cannot be
bypassed by forgetting a `where` clause"* (`docs/Claude/08-security.md:218-220`). Only the database
can make that guarantee. RLS is specified — but RLS ships as theatre unless all four of these hold,
and each was verified:

1. **Role separation** — the runtime must not own the tables and must not have `BYPASSRLS` (§5.2).
2. **`set_config(..., true)`, never `SET`** — transaction-scoped, so it cannot leak across pool
   checkouts. `SET LOCAL` outside a transaction *silently does nothing* (verified).
3. **The test harness must be subject to RLS** — pglite runs as `postgres` with
   `rolsuper=t, rolbypassrls=t`. A naive cross-tenant test against `createTestDb()` **passes
   vacuously**. Verified, and the fix is one `SET ROLE` (§9.1).
4. **Policies must not be installed by `drizzle-kit push`** — it drops their expressions (§5.4).

---

## 3. The sign-in flow

### 3.1 What "the Replit pattern" actually is, in a self-hosted context

Replit Auth is an ordinary OpenID Connect Provider. Its discovery document (retrieved 2026-08-03)
shows `issuer: https://replit.com/oidc`, `response_types_supported: ["code"]`,
`code_challenge_methods_supported: ["S256"]` (PKCE mandatory — `plain` is not offered),
`grant_types_supported: ["authorization_code","refresh_token"]`, and an `end_session_endpoint`.
The scaffold Replit's agent generates around it is:

> `openid-client` for the protocol → a Passport strategy wrapping it → `express-session` →
> `connect-pg-simple` on a Postgres `sessions` table → `upsertUser(claims)` into a `users` table
> keyed by `sub` → `isAuthenticated` middleware → RP-initiated logout via `end_session_endpoint`.

**Off Replit, the pattern survives; the provider does not.** Everything except the issuer URL and
the Passport wrapper carries over directly, and the two tables already in the repo are the durable
part of it.

### 3.2 Library choice, and why Passport is dropped

| Concern | Decision |
|---|---|
| OIDC protocol (Google, Microsoft) | **`openid-client@6`** (6.8.4 at time of writing) |
| OAuth 2.0 (GitHub) | **`openid-client@6`'s OAuth-only helpers**, against a hand-written `Configuration` — GitHub has no discovery document |
| Session | **`express-session@1.19`** + **`connect-pg-simple@10`** |
| Passport | **Not used** |

**Why `openid-client`.** It is the same library the Replit scaffold uses, it is the reference
JS implementation, and v6 is function-based. Note for the implementer: **the v5 class API is gone.**
Verified by introspecting the installed package — `"Issuer" in client === false`,
`"Client" in client === false`. The v6 exports are `discovery`, `buildAuthorizationUrl`,
`authorizationCodeGrant`, `randomPKCECodeVerifier`, `calculatePKCECodeChallenge`, `randomState`,
`randomNonce`, `fetchUserInfo`, `refreshTokenGrant`, `buildEndSessionUrl`, `Configuration`,
`ClientSecretPost`/`ClientSecretBasic`/`None`, `allowInsecureRequests`, `skipSubjectCheck`,
`customFetch`. Any tutorial showing `Issuer.discover()` is for v5 and will not compile.

**Why not Passport.** Passport buys one thing here — `req.login()` and a strategy registry — at the
cost of a second session-mutation path that must be kept in step with `express-session`'s own
`regenerate()`, plus `passport@0.7`'s own session-fixation handling layered on top of ours. With
three providers and two protocols (one of which is not OIDC), the strategy abstraction earns
nothing. Two ~60-line route handlers reading from a provider registry are smaller, and the session
write is in one place.

**Three providers, two protocols.** This is the discriminating fact:

- `https://accounts.google.com/.well-known/openid-configuration` → **200**, full OIDC,
  `code_challenge_methods_supported: ["plain","S256"]`, `email_verified` in `claims_supported`.
- `https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration` → **200**, OIDC.
- `https://github.com/.well-known/openid-configuration` → **404.**

GitHub's only OIDC issuer is `https://token.actions.githubusercontent.com`, whose discovery document
advertises `response_types_supported: ["id_token"]` and has **no** `authorization_endpoint` or
`token_endpoint` — it is Actions workload identity, not user sign-in. **GitHub user sign-in is
plain OAuth 2.0 authorisation-code, with no `id_token` and no UserInfo.** It does support PKCE:
GitHub's docs state `code_challenge_method` "*Must be `S256` - the `plain` code challenge method is
not supported*". Identity comes from `GET /user` and `GET /user/emails` afterwards.

### 3.3 The provider registry

One module, `artifacts/api-server/src/lib/auth/providers.ts`, exporting a normalising registry so
the callback handler has no per-provider branches beyond claim extraction.

```ts
export type ProviderId = "google" | "github" | "microsoft";

export interface NormalizedIdentity {
  provider: ProviderId;
  /** Stable, provider-scoped subject. NEVER an email. */
  providerUserId: string;
  /** Microsoft only: the `tid` claim. Null elsewhere. */
  providerTenantId: string | null;
  email: string | null;
  /** Provider-asserted verification. Governs auto-linking — see §3.6. */
  emailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
}
```

| | `google` | `microsoft` | `github` |
|---|---|---|---|
| Protocol | OIDC | OIDC | OAuth 2.0 |
| Discovery | `https://accounts.google.com/.well-known/openid-configuration` | `https://login.microsoftonline.com/{TENANT}/v2.0/.well-known/openid-configuration` | none — literal endpoints |
| Authorize | from discovery | from discovery | `https://github.com/login/oauth/authorize` |
| Token | from discovery | from discovery | `https://github.com/login/oauth/access_token` (send `Accept: application/json`) |
| Scopes | `openid email profile` | `openid email profile` | `read:user user:email` |
| PKCE | S256 | S256 | S256 (`plain` not supported) |
| `state` | required | required | required |
| `nonce` | required | required | n/a (no `id_token`) |
| `providerUserId` | `sub` | **`oid`** | `id` from `GET /user`, as a string |
| `providerTenantId` | `null` | `tid` | `null` |
| `emailVerified` | `email_verified` claim | **always `false`** — see below | `verified` on the primary entry of `GET /user/emails` |

**Microsoft `oid`, not `sub`.** Microsoft documents `sub` as "*a pairwise identifier … unique to an
application ID*" — it changes if the client ID changes. `oid` is "*The immutable identifier for an
object … two different applications signing in the same user receives the same value*". Store
`(oid, tid)`; `oid` alone is not unique across tenants for a guest user.

**Microsoft `email` is never treated as verified.** Microsoft's own reference says of the `email`
claim: "*This value isn't guaranteed to be correct and is mutable over time. **Never use it for
authorization or to save data for a user.***" And, generally: "*Your application mustn't use
human-readable data to identify a user.*" This is not a judgement call — set `emailVerified: false`
for `microsoft` unconditionally, which routes it to the explicit-link path in §3.6.

**GitHub's email needs a second call.** `GET /user`'s `email` is null when the user has made it
private. `GET /user/emails` returns objects with required `email`, `primary`, `verified`,
`visibility` fields, and "*OAuth app tokens … need the `user:email` scope to use this endpoint*".
Take the entry with `primary: true`; use its `verified` flag verbatim.

**Multi-tenant Microsoft: validate `iss` yourself.** The `common` discovery document returns a
templated `issuer` of `https://login.microsoftonline.com/{tenantid}/v2.0` (verified). Microsoft's
guidance is that the app "*should use the GUID portion of the claim to restrict the set of tenants
that can sign in*". Configure `ENTRA_TENANT` explicitly — a single tenant GUID for a single-tenant
deployment, or `organizations` (verified, returns 200) with an explicit allowlist of accepted `tid`
values. **Do not ship `common` with no `tid` check** — that accepts every Entra tenant *and* every
personal Microsoft account. Default: `ENTRA_TENANT=organizations`, `ENTRA_ALLOWED_TIDS` unset means
"any organisational tenant, no personal accounts", which is the intended posture for a B2B product.

### 3.4 Routes

All under `/api/auth`. All are added to the public-route allowlist (§6.2) — they are how a caller
*becomes* authenticated.

| Route | Purpose |
|---|---|
| `GET  /api/auth/providers` | `{ providers: ["google","github"] }` — which are configured. Drives the sign-in page; an unconfigured provider must not render a dead button |
| `GET  /api/auth/:provider/start` | Generates PKCE verifier + `state` (+ `nonce` for OIDC), stores them in the session, 302s to the IdP |
| `GET  /api/auth/:provider/callback` | Validates, exchanges, upserts, regenerates the session, 302s to the app |
| `GET  /api/auth/session` | `200 {user, organization, memberships}` when signed in; `200 {user: null}` when not. **Never 401** — it is the anonymous-state probe |
| `POST /api/auth/logout` | Destroys the session, clears the cookie |
| `POST /api/auth/organizations/:id/select` | Switches active organisation. 403 unless the caller is a member |

`GET /api/auth/session` returning 200-with-null rather than 401 matters: it is called on every page
load including for anonymous visitors, and a 401 would be indistinguishable from a real failure.

### 3.5 `/start` and `/callback` in detail

**`/start`:**

1. Reject unless `:provider` is a configured `ProviderId` → 404.
2. `verifier = randomPKCECodeVerifier()`; `challenge = await calculatePKCECodeChallenge(verifier)`;
   `state = randomState()`; for OIDC, `nonce = randomNonce()`.
3. Store `{ provider, verifier, state, nonce, returnTo, createdAt }` in `req.session.oauth`.
   `express-session` is configured `saveUninitialized: false`, so **this write is what creates the
   session row** — an anonymous visitor who never clicks sign-in never touches the database.
4. `returnTo` comes from a `?returnTo=` query parameter and **must be validated as a
   same-origin absolute path**: it must start with a single `/`, must not start with `//` or `/\`,
   and must not contain a scheme. Anything else → `/dashboard`. This is an open-redirect check;
   skipping it is a phishing primitive.
5. 302 to `buildAuthorizationUrl(config, { redirect_uri, scope, state, nonce, code_challenge,
   code_challenge_method: "S256" })`.

The OIDC transaction record has a **10-minute TTL** enforced against `createdAt`; an older one is
discarded and the flow restarts.

**`/callback`:**

1. Load `req.session.oauth`. Absent, expired, or `provider` mismatched → 400 and clear it.
2. **Single use.** Delete it from the session *before* the token exchange. A replayed callback must
   fail even if the exchange succeeds.
3. OIDC: `authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier, expectedState,
   expectedNonce })` — the library validates `state`, `nonce`, `iss`, `aud`, signature and
   expiry. **Let it.** Do not hand-decode the `id_token`.
   GitHub: POST the token endpoint with `Accept: application/json`, `code`, `code_verifier`,
   `client_id`, `client_secret`, `redirect_uri`; compare the returned `state` to the stored one in
   constant time; then `GET /user` and `GET /user/emails`.
4. Additionally assert `tid ∈ ENTRA_ALLOWED_TIDS` for Microsoft when that list is configured.
5. Normalise to `NormalizedIdentity`.
6. Resolve to a user (§3.6) and to an active organisation (§3.7).
7. **`req.session.regenerate()`**, then write `{ userId, organizationId, provider, loginAt,
   absoluteExpiresAt }`, then `req.session.save()`, then 302 to `returnTo`.
   Regeneration is the session-fixation defence and it is verified working on Express 5 —
   [Appendix A.6](#a6--express-session-on-express-5).
8. **Provider access tokens are not stored.** Sign-in needs identity, not ongoing API access. The
   only token this system persists is the private-repository grant in §8, and that is a different
   credential with a different lifecycle.

### 3.6 The same person via Google, then GitHub

This is the account-takeover surface, and it has one dangerous answer: match on email. `users.email`
is `unique` and nullable, which makes it tempting.

**The rule:**

```
lookup user_identities by (provider, provider_user_id)
  ├─ hit  → that user. Refresh profile columns. Done.
  └─ miss →
       ├─ identity.emailVerified === true
       │     AND a users row exists with that email (case-folded)
       │        → auto-link: insert user_identities for the existing user
       ├─ identity.emailVerified === true, no matching user
       │        → create user + identity + personal organisation
       └─ identity.emailVerified === false
             → NEVER auto-link and NEVER create a user matched on that email.
               ├─ already signed in → link to the current session's user
               └─ not signed in     → create a NEW user with email = NULL,
                                      and surface "already have an account?
                                      sign in with your original provider and
                                      link this one in Settings"
```

`provider_user_id` — Google `sub`, Microsoft `oid`, GitHub `id` — is the only join key. Email is a
**hint**, never an identifier. Google: "*Don't use the email field as a unique identifier for a
user. Always use the `sub` field.*" Microsoft: "*Never use it for authorization or to save data for
a user.*"

Consequences, all deliberate:

- **Microsoft never auto-links**, because §3.3 pins its `emailVerified` to `false`. A Microsoft
  sign-in either lands on an existing `(microsoft, oid)` identity or creates a fresh user. This is
  the correct trade: it produces occasional duplicate accounts, resolvable by an explicit link;
  the alternative produces silent account takeover.
- **Email comparison is case-folded and stored lower-case.** `users.email` is `unique`; two
  providers asserting `Sam@x.com` and `sam@x.com` must not create two rows.
- **Explicit linking**: `POST /api/auth/:provider/link` runs the same `/start` flow with
  `mode: "link"` in the session, and on callback attaches the identity to the *already
  authenticated* user, refusing if that `(provider, provider_user_id)` is attached to a different
  user. `DELETE /api/auth/identities/:id` unlinks, refusing to remove the last identity.

### 3.7 Which organisation a session is in

`req.session.organizationId` is resolved on login and re-resolved on every request from
`organization_members` (never trusted from the session alone — see §6.3):

1. New user → create a personal organisation, `personal = true`, the user as `owner`.
2. Returning user with exactly one membership → that one.
3. Multiple memberships → the one in the session if still valid, else the oldest.

A solo user has exactly one personal organisation forever, so the concept never appears in the UI
(§7.4). The organisation switcher renders only when `memberships.length > 1`.

### 3.8 Session and cookie configuration

```ts
app.set("trust proxy", 1);                      // required: TLS terminates upstream

session({
  name: SECURE ? "__Host-qx.sid" : "qx.sid",
  store: new PgSession({ pool, tableName: "sessions", createTableIfMissing: false,
                         pruneSessionInterval: 900 }),
  secret: SESSION_SECRETS,                      // string[]; [0] signs, all verify
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: true,
  cookie: {
    httpOnly: true,
    secure: SECURE,
    sameSite: "lax",
    path: "/",
    // no `domain` — required for the __Host- prefix
    maxAge: 8 * 60 * 60 * 1000,                 // 8 h idle, refreshed by `rolling`
  },
})
```

Every flag, with its reason:

| Flag | Value | Why |
|---|---|---|
| `name` | `__Host-qx.sid` when secure | The `__Host-` prefix makes the cookie un-settable by any sibling subdomain and un-scopable by `Domain`. Requires `Secure`, `Path=/`, no `Domain` — all satisfied. Verified emitted correctly |
| `secure` | `NODE_ENV === "production"` | **Trap:** with `secure: true` and no `X-Forwarded-Proto: https`, express-session emits **no `Set-Cookie` header at all** — sign-in appears to succeed and silently does nothing. Verified. This is why the name is conditional too: `__Host-` without `Secure` is rejected by browsers |
| `httpOnly` | `true` | XSS cannot read the session |
| `sameSite` | `lax` | Correct for a same-origin deployment. **Never `none`** (S4 makes that a credential-theft primitive) and **never `"auto"`** — documented as setting `SameSite=None` on secure connections |
| `path` | `/` | `__Host-` requirement |
| `maxAge` + `rolling` | 8 h idle | `rolling` re-sets the cookie each response. Verified |
| absolute cap | 7 days | `rolling` alone extends indefinitely. Store `absoluteExpiresAt` in the session payload; the auth middleware destroys any session past it regardless of activity |
| `resave` | `false` | `connect-pg-simple` implements `touch` |
| `saveUninitialized` | `false` | Anonymous visitors create no session rows |
| `secret` | `string[]` from `SESSION_SECRET` | express-session: "*Only the first element will be used to sign … while all elements will be considered when verifying*" — rotation without logging everyone out. Each ≥ 32 bytes |
| `genid` | default | `uid-safe`, 24 CSPRNG bytes |

`SESSION_SECRET` is validated at startup by `assertSessionSecretsConfigured()`, mirroring the
existing `assertApiKeysConfigured()` in `artifacts/api-server/src/lib/auth.ts:61`: **refuse to
start** if absent or if any secret is under 32 bytes. Fail-closed startup is already this codebase's
idiom; keep it.

### 3.9 CSRF

`SameSite=Lax` is necessary and **not sufficient** — it permits top-level GET navigations, and it is
a browser-side control that a spec should not rely on alone.

1. **No state-changing GETs.** `/api/auth/logout` is `POST`. Anything that mutates is
   POST/PUT/PATCH/DELETE.
2. **Fetch-metadata check**, in middleware, on every state-changing method:
   accept if `Sec-Fetch-Site ∈ {same-origin, none}`; else accept if `Origin` is present and in
   `CORS_ALLOWED_ORIGINS`; else **403**. Per the Fetch standard the browser sets `Origin` on every
   non-`GET`/`HEAD` request, so a legitimate browser call always presents one of the two.
   Requests authenticated by API key (§6.1) skip this check — they are not browser-driven and carry
   no ambient credential.
3. **`__Host-` prefix**, which removes the subdomain cookie-injection route into a double-submit
   scheme.
4. The OAuth `state` parameter, which is a *different* CSRF control protecting the callback
   specifically, and is validated by `openid-client` for OIDC and by hand for GitHub.

An anti-CSRF token is deliberately not specified: with a same-origin SPA, `SameSite=Lax`, a
fetch-metadata check and `__Host-`, it adds a token-distribution problem and no coverage. Revisit if
the cross-origin topology ever becomes supported.

### 3.10 Sign-out

`POST /api/auth/logout` → `req.session.destroy()` → `res.clearCookie(name, {path, httpOnly, secure,
sameSite})`. Verified: the destroyed session's cookie no longer resolves and the next request gets a
fresh anonymous session ID.

**RP-initiated logout is not specified.** The Replit pattern redirects to the IdP's
`end_session_endpoint`; Google and GitHub do not meaningfully offer one for this case, and signing
a user out of their Google account because they left QuantaXscan is wrong. Local sign-out only.

---

## 4. The data model and its migration

### 4.1 New enums

Auth and tenancy enums live in a **new `lib/db/src/schema/auth-enums.ts`**, not in
`@workspace/collectors`.

This is a deliberate, recorded deviation. `AGENTS.md` says shared enums needing both a DB constraint
and a TypeScript type are defined once in `@workspace/collectors`. That rule exists because those
enums are part of the collector contract, and `lib/collectors` is deliberately dependency-free so it
can run as a standalone on-prem agent. An on-prem collector has no concept of an organisation role
or an identity provider; putting them there would put tenancy into the artefact whose whole point is
that it does not have any. The rule's *mechanism* is preserved exactly — one const tuple, `text` +
`CHECK` via the existing `oneOf()` helper from `sql-helpers.ts`, no Postgres `ENUM` type:

```ts
export const ORG_ROLE_VALUES = ["owner", "member"] as const;
export const IDENTITY_PROVIDER_VALUES = ["google", "github", "microsoft"] as const;
export const REPORT_VISIBILITY_VALUES = ["private", "public"] as const;
```

`ORG_ROLE_VALUES` is minimal on purpose; widening a `CHECK` built this way is a one-line diff.
See [§12](#12-decisions-that-are-the-captains-not-mine) — the captain may want `admin`.

### 4.2 New tables

```ts
// lib/db/src/schema/organizations.ts
export const organizationsTable = pgTable("organizations", {
  id: serial("id").primaryKey(),                       // integer — matches assets.organization_id
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  /** True for the auto-created org of a solo user. Never surfaced in the UI. */
  personal: boolean("personal").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("organizations_slug_idx").on(t.slug)]);

export const organizationMembersTable = pgTable("organization_members", {
  organizationId: integer("organization_id").notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull()                 // varchar — matches users.id
    .references(() => usersTable.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.userId] }),
  index("organization_members_user_idx").on(t.userId),
  check("organization_members_role_check", oneOf(t.role, ORG_ROLE_VALUES)),
]);

// lib/db/src/schema/user_identities.ts
export const userIdentitiesTable = pgTable("user_identities", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  /** google: sub · microsoft: oid · github: numeric id as text. NEVER an email. */
  providerUserId: text("provider_user_id").notNull(),
  /** microsoft: tid. Null for the others. */
  providerTenantId: text("provider_tenant_id"),
  /** As asserted at link time. Informational — never a join key. */
  email: text("email"),
  emailVerified: boolean("email_verified").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("user_identities_provider_subject_idx").on(t.provider, t.providerUserId),
  index("user_identities_user_idx").on(t.userId),
  check("user_identities_provider_check", oneOf(t.provider, IDENTITY_PROVIDER_VALUES)),
]);
```

### 4.3 How `organizationId` threads through existing tables

| Table | Change | Notes |
|---|---|---|
| `assets` | add `references(organizations.id) on delete cascade` to the existing column | column already exists and is already `1` everywhere |
| `collection_runs` | same | same |
| `projects` | **add** `organization_id integer not null` + FK cascade | |
| `scans` | **add** `organization_id integer not null` + FK cascade | denormalised from `projects` |
| `findings` | **add** `organization_id integer not null` + FK cascade | denormalised from `scans` |
| `observations` | **add** `organization_id integer not null` + FK cascade | denormalised from `assets` |
| `activity` | **add** `organization_id integer NULL` + FK cascade | `NULL` = platform-level event |
| `shared_reports` | see §4.4 | |
| `community_posts` | **add** `author_user_id varchar NULL` + FK set-null. **Not org-scoped** | public content by design; keeps `author_name` for legacy rows |
| `users`, `sessions` | unchanged (beyond §2.3) | not org-scoped: both are needed *before* an org context exists |
| `conversations`, `messages` | untouched, and **no `GRANT`** to the runtime role | dead tables — `routes/chat.ts` proxies to OpenAI and persists nothing. Denied by default |

**Why denormalise onto `scans`, `findings` and `observations` instead of joining.** A policy that
reaches through a parent works — I verified a join-based policy on a child table correctly inherits
the parent's visibility ([Appendix A.2](#a2--rls-semantics-under-pglite)) — but it puts an `EXISTS`
subquery into the hot path of every read and makes the isolation guarantee depend on the *parent's*
policy staying correct. A local column costs 4 bytes and makes each policy independently checkable
and independently testable. Crucially, `WITH CHECK` then makes the denormalisation **self-enforcing**:
an insert carrying the wrong `organization_id` is rejected by RLS itself, so the column cannot drift
from its parent. No trigger is needed.

`observations` gaining an `organization_id` does not weaken the `S3` deletion path: `observations`
still cascades off `assets`, and the `project:<id>:` location-prefix reconciliation in
`routes/projects.ts:84-87` is unchanged. That prefix convention remains load-bearing — the note at
`08-security.md:116-126` still applies.

### 4.4 `shared_reports` — public by design, and now owned by someone

The existing `owner` column is **not** a user. It is the GitHub repository owner:
`routes/reports.ts:18` destructures `{ owner, repo, repoUrl, data }` from the request body. An
implementer will collide here. Use different names.

```ts
organizationId:   integer("organization_id").notNull().references(...),   // added
createdByUserId:  varchar("created_by_user_id").references(usersTable.id, { onDelete: "set null" }),
visibility:       text("visibility").notNull().default("private"),        // CHECK oneOf REPORT_VISIBILITY_VALUES
expiresAt:        timestamp("expires_at", { withTimezone: true }).notNull(),
revokedAt:        timestamp("revoked_at", { withTimezone: true }),
lastAccessedAt:   timestamp("last_accessed_at", { withTimezone: true }),
accessCount:      integer("access_count").notNull().default(0),
```

This closes the rest of S2 as a side effect: authenticated-by-default (`visibility` defaults to
`private`), opt-in public sharing, mandatory expiry (`expires_at` is `NOT NULL`), revocation
(`revoked_at`), and access logging (`last_accessed_at` / `access_count`, plus the S8 audit row).
`GET /api/reports/:id` also sets `X-Robots-Tag: noindex, nofollow` — "never indexed" is in the
requirement list at `08-security.md:229-231` and nothing currently implements it.

**Legacy rows.** They carry 10-character `Math.random()` IDs and are anonymously enumerable
(`08-security.md:103-114`). The backfill assigns them to the captain's organisation,
`visibility = 'public'`, and `expires_at = now() + interval '30 days'`. That converts an
indefinite exposure into a bounded one **from inside this migration**, without needing the separate
database access the security document says is otherwise required. A captain's call, defaulted —
see [§12](#12-decisions-that-are-the-captains-not-mine).

### 4.5 The migration

Ordering matters. Adding `NOT NULL` to a populated table before backfilling it fails.

`:captain_email` below is **not** a `psql -v` binding. The whole migration is applied by
`pnpm --filter @workspace/db run apply-tenancy`, a small `tsx` script over `DATABASE_URL_MIGRATOR`
that reads the value from the **`CAPTAIN_EMAIL` environment variable** and passes it as a bind
parameter, and that refuses to run if it is unset. It is written as `:captain_email` here only to
make clear it is a parameter and never a literal in the committed SQL.

```sql
-- === 1. Tenancy tables (empty; safe in any order) ===============================
CREATE TABLE organizations        (...);
CREATE TABLE organization_members (...);
CREATE TABLE user_identities      (...);

-- === 2. Seed the captain, as organisation 1 =====================================
-- id 1 is required, not cosmetic: every existing assets/collection_runs row
-- already carries organization_id = 1 (asset-ingest.ts:23).
INSERT INTO organizations (id, name, slug, personal)
VALUES (1, 'QuantaXscan', 'quantaxscan', false);
SELECT setval('organizations_id_seq', (SELECT MAX(id) FROM organizations));

INSERT INTO users (id, email, first_name, last_name)
VALUES (gen_random_uuid()::text, :captain_email, 'Pradeep', NULL)
ON CONFLICT (email) DO NOTHING;

INSERT INTO organization_members (organization_id, user_id, role)
SELECT 1, id, 'owner' FROM users WHERE email = :captain_email;

-- === 3. Add columns NULLABLE, backfill, then constrain ==========================
ALTER TABLE projects       ADD COLUMN organization_id integer;
ALTER TABLE scans          ADD COLUMN organization_id integer;
ALTER TABLE findings       ADD COLUMN organization_id integer;
ALTER TABLE observations   ADD COLUMN organization_id integer;
ALTER TABLE activity       ADD COLUMN organization_id integer;
ALTER TABLE shared_reports ADD COLUMN organization_id integer,
                           ADD COLUMN created_by_user_id varchar,
                           ADD COLUMN visibility text NOT NULL DEFAULT 'private',
                           ADD COLUMN expires_at timestamptz,
                           ADD COLUMN revoked_at timestamptz,
                           ADD COLUMN last_accessed_at timestamptz,
                           ADD COLUMN access_count integer NOT NULL DEFAULT 0;
ALTER TABLE community_posts ADD COLUMN author_user_id varchar;

UPDATE projects       SET organization_id = 1;
UPDATE scans          SET organization_id = 1;
UPDATE findings       SET organization_id = 1;
UPDATE observations   SET organization_id = 1;
UPDATE shared_reports SET organization_id = 1,
                          visibility = 'public',
                          expires_at = now() + interval '30 days';
-- activity stays NULL: existing rows are a global feed with no owner.

ALTER TABLE projects       ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE scans          ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE findings       ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE observations   ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE shared_reports ALTER COLUMN organization_id SET NOT NULL,
                           ALTER COLUMN expires_at      SET NOT NULL;

-- FKs (assets/collection_runs gain theirs here; their data is already correct)
ALTER TABLE assets         ADD CONSTRAINT assets_org_fk         FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE collection_runs ADD CONSTRAINT collection_runs_org_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
-- ... and the same for projects, scans, findings, observations, activity, shared_reports

-- === 4. Session store fix (§2.3) ================================================
-- Truncate rather than convert. `expire AT TIME ZONE 'UTC'` would be correct only
-- if every existing row had been written under a server TimeZone of UTC — and the
-- bug in §2.3 is precisely that a stored `timestamp`'s meaning depends on the
-- writing session's TimeZone, so that cannot be assumed. `sessions` is disposable
-- state; converting it wrong silently mis-dates every live session on a non-UTC
-- deployment. This logs everyone out once, at the moment the feature that
-- introduces logging in ships. That is the intended trade.
DELETE FROM sessions;
ALTER TABLE sessions ALTER COLUMN expire TYPE timestamptz;

-- === 5. Indexes to support the policies =========================================
CREATE INDEX projects_org_idx     ON projects       (organization_id);
CREATE INDEX scans_org_idx        ON scans          (organization_id);
CREATE INDEX findings_org_idx     ON findings       (organization_id);
CREATE INDEX observations_org_idx ON observations   (organization_id);
CREATE INDEX shared_reports_org_idx ON shared_reports (organization_id);
-- assets already has (organization_id, fingerprint) and (organization_id, location, status)
```

Steps 6 (roles/grants) and 7 (RLS) are in §5.2 and §5.3 and **must be hand-written SQL**, for the
reason in §5.4.

`gen_random_uuid()` requires `pgcrypto` on PostgreSQL < 13; the existing schema already depends on
it as a column default, and production is well past 13, so no extension statement is added.

### 4.6 The `AGENTS.md` conflict this creates, and how to resolve it

`AGENTS.md` stated that `drizzle-kit push` is the deploy mechanism and is authoritative for what
lands in a real database. §5.4 shows `push` cannot be trusted with policies. The resolution, now
written into `AGENTS.md`:

> `drizzle-kit push` remains the mechanism for tables, columns, indexes and constraints. It is
> **not** used for row-level security. Policies, roles and grants live in
> `lib/db/sql/tenant-isolation.sql`, applied by `pnpm --filter @workspace/db run apply-rls` after
> `push`, and asserted at API-server startup by `assertTenantIsolationInstalled()`. `push` creates
> policies with a NULL `USING` clause, which silently disables isolation.

---

## 5. Query scoping as a choke point

### 5.1 The mechanism, in one paragraph

Every organisation-scoped read and write runs inside a transaction that first sets two
transaction-local GUCs. PostgreSQL RLS policies on every scoped table compare `organization_id`
against the GUC. The application connects as a role that neither owns the tables nor has
`BYPASSRLS`, so the policies are not optional for it. A forgotten `where organizationId = …` returns
zero rows instead of another tenant's data; a wrong-organisation insert is rejected by `WITH CHECK`.
A TypeScript accessor makes the correct path the *only* ergonomic one, and a lint-style test makes
the incorrect path fail CI — but the guarantee is the database's, not TypeScript's.

### 5.2 Two roles

```sql
-- Owner/migrator: runs drizzle-kit push and apply-rls. Never used at runtime.
CREATE ROLE quantaxscan_migrator LOGIN PASSWORD :'migrator_pw';
-- Runtime: no BYPASSRLS, no ownership, no DDL.
CREATE ROLE quantaxscan_app      LOGIN PASSWORD :'app_pw' NOINHERIT;

GRANT USAGE ON SCHEMA public TO quantaxscan_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
      projects, scans, findings, assets, observations, collection_runs,
      activity, shared_reports, community_posts, ot_fleets, vendor_assessments,
      credentials, discovered_targets, network_flows,
      collection_schedules, collection_schedule_runs, divisions, division_grants,
      waivers,
      organizations, organization_members, user_identities, users, sessions
  TO quantaxscan_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO quantaxscan_app;
-- conversations / messages deliberately receive no grant.
```

`DATABASE_URL` at runtime authenticates as `quantaxscan_app`. `DATABASE_URL_MIGRATOR` is used by
`drizzle.config.ts` and the RLS apply step. **This is the control that makes RLS real** — a table
owner bypasses its own policies unless `FORCE ROW LEVEL SECURITY` is set, and a superuser bypasses
them unconditionally. `FORCE` is applied anyway (§5.3) as defence in depth against a future
ownership change.

The `GRANT` list is itself a second layer: a table with no grant is inaccessible to the runtime
regardless of policy. That is why `conversations`/`messages` are simply not granted.

**This block is a copy, and it went stale.** Between 2026-08-13 and 2026-08-16 nine tables were
added to `ORG_SCOPED_TABLES` and granted in `lib/db/sql/tenant-isolation.sql` while this listing
kept its original fourteen. Following it verbatim would have shipped a database where nine tables
are unreachable by the runtime — fail-closed, so nothing is exposed, but silent until a route
returns a 500 nobody can explain from the error. **`lib/db/sql/tenant-isolation.sql` is the
authority; this is illustration.** If you are adding a table, the checklist is in
[CLAUDE.md](../../CLAUDE.md): `ORG_SCOPED_TABLES`, a policy, and a grant — and
`lib/db/src/tenant-isolation.test.ts` asserts the first against the database rather than against
this page.

### 5.3 The policies

Two GUCs, `app.current_org_id` and `app.current_user_id`. The expression is written inline rather
than wrapped in a helper function, so the planner can still use the `(organization_id, …)` indexes:

```sql
-- Applied to: projects, scans, findings, assets, observations,
--             collection_runs
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE  ROW LEVEL SECURITY;
CREATE POLICY projects_org_isolation ON projects AS PERMISSIVE FOR ALL TO quantaxscan_app
  USING      (organization_id = nullif(current_setting('app.current_org_id', true), '')::int)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::int);
```

**`nullif(…, '')` is not cosmetic.** `current_setting('x', true)` returns `NULL` when the GUC has
never been set — good, `col = NULL` is `NULL`, the row is filtered, zero rows, fail-closed. But after
a `RESET`, or after a transaction that set it commits, it returns the **empty string**, and
`''::int` raises `invalid input syntax for type integer: ""` — a 500 rather than an empty result.
`nullif` normalises both to `NULL`. Verified in both forms —
[Appendix A.2](#a2--rls-semantics-under-pglite).

Three tables need a different shape:

```sql
-- organization_members: the caller must be able to see their OWN memberships
-- before any organisation has been selected (the login bootstrap).
CREATE POLICY organization_members_isolation ON organization_members
  AS PERMISSIVE FOR ALL TO quantaxscan_app
  USING (organization_id = nullif(current_setting('app.current_org_id',  true), '')::int
      OR user_id         = nullif(current_setting('app.current_user_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::int);

-- organizations: the active org, plus the ones the caller belongs to (the switcher).
-- The subquery is evaluated under organization_members' own policy, whose
-- `user_id` branch satisfies it without referencing `organizations` — no recursion.
CREATE POLICY organizations_isolation ON organizations
  AS PERMISSIVE FOR ALL TO quantaxscan_app
  USING (id = nullif(current_setting('app.current_org_id', true), '')::int
      OR id IN (SELECT m.organization_id FROM organization_members m
                 WHERE m.user_id = nullif(current_setting('app.current_user_id', true), '')));

-- shared_reports: the public-share rule lives IN the policy, so the public
-- route goes through the same choke point rather than around it.
CREATE POLICY shared_reports_isolation ON shared_reports
  AS PERMISSIVE FOR ALL TO quantaxscan_app
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::int
      OR (visibility = 'public' AND revoked_at IS NULL AND expires_at > now()))
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::int);

-- activity: platform-level rows (organization_id IS NULL) are visible to all.
CREATE POLICY activity_isolation ON activity
  AS PERMISSIVE FOR ALL TO quantaxscan_app
  USING (organization_id IS NULL
      OR organization_id = nullif(current_setting('app.current_org_id', true), '')::int)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::int);
```

**The asymmetry in `activity` is deliberate — read this before "fixing" it.** `USING` admits
`organization_id IS NULL` (the legacy global feed and any future platform-level event) while
`WITH CHECK` does not. Verified consequence: a NULL-org row is **readable** and **deletable**, but
**not updatable** — `UPDATE` evaluates `WITH CHECK` against the new row, which still has a NULL
`organization_id`, and is rejected with *"new row violates row-level security policy"*. That is
intended: the legacy feed is immutable and prunable, and no tenant may mint new unowned rows. §6.2
removes the last writer of NULL-org rows (the demo route), so nothing creates them going forward.
If a future platform-level writer is genuinely needed, it goes through
`withoutOrgScope("platform activity")` and the `WITH CHECK` gains the same `IS NULL` branch — an
explicit change, not an accident.

`users`, `sessions` and `community_posts` are **not** RLS-scoped, deliberately: the first two are
read before an organisation context exists, and the third is public content. User enumeration is
still contained — the only route that lists users joins through `organization_members`, which *is*
scoped, so a caller can only see users who share an organisation with them. That must be a test.

### 5.4 The `drizzle-kit push` trap

**`drizzle-kit@0.31.9` + `drizzle-orm@0.45.2` create RLS policies with no `USING` and no
`WITH CHECK` expression.** Reproduced twice from an empty database against PostgreSQL 16.14, both
with a `pgRole` target and with `to: "public"`:

```
$ npx drizzle-kit push --force --config /tmp/rls-push-config.ts
[✓] Changes applied

$ psql -c "select polname, polpermissive, polroles::regrole[],
           polqual is null as qual_is_null, polwithcheck is null as check_is_null from pg_policy;"
        polname        | polpermissive |     polroles      | qual_is_null | check_is_null
-----------------------+---------------+-------------------+--------------+---------------
 widgets_org_isolation | t             | {quantaxscan_app} | t            | t
```

`polqual IS NULL` means the policy has no restriction: **RLS is enabled, a policy exists, and every
row is visible.** `psql`'s `\d+` shows only `POLICY "widgets_org_isolation" TO quantaxscan_app` —
no `USING` line. `drizzle-kit generate` is correct and emits the full statement; applying that SQL
by hand produces `(organization_id = (current_setting('app.current_org_id'::text, true))::integer)`
as expected. `push` re-run over a correct state does not destroy it, but errors on `CreateRole`.
Full transcript: [Appendix A.3](#a3--drizzle-kit-push-drops-rls-policy-expressions).

**Consequences, all mandatory, and all built:**

1. Policies, roles and grants live in `lib/db/sql/tenant-isolation.sql`, applied by
   `pnpm --filter @workspace/db run apply-rls` against `DATABASE_URL_MIGRATOR`. Idempotent
   (`DROP POLICY IF EXISTS` before each `CREATE POLICY`; `DO $$ … IF NOT EXISTS … CREATE ROLE`).
2. `.enableRLS()` and `pgPolicy()` are **not** used in the drizzle schema files, so `push` never
   tries to manage them.
3. `assertTenantIsolationInstalled()` runs at API-server startup alongside
   `assertApiKeysConfigured()` and **refuses to start** unless, for every table in
   `ORG_SCOPED_TABLES`: `relrowsecurity AND relforcerowsecurity`, and at least one policy that
   **applies to the runtime role** and has `polqual IS NOT NULL`. The role check matters: a
   permissive policy naming some other role would otherwise satisfy a naive count.
   It lives in `artifacts/api-server/src/index.ts`, deliberately not `app.ts` — the API test
   suite imports `app` directly against a mocked database.
4. The same assertion runs as a test in `lib/db` (§9.2), including two cases that prove it can
   fail: a policy rewritten to have a NULL `USING`, and a table with `NO FORCE`.

### 5.5 The accessor

```ts
// lib/db/src/org-scope.ts  — the only sanctioned path to org-scoped data
export interface OrgContext { organizationId: number; userId: string }
export type ScopedTx = PgTransaction<...>;

export async function withOrg<T>(ctx: OrgContext, fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.current_org_id',  ${String(ctx.organizationId)}, true),
      set_config('app.current_user_id', ${ctx.userId},                 true)`);
    return fn(tx);
  });
}

/** Anonymous access to a public share link. Sets no org GUC — only the
 *  public branch of shared_reports_isolation can match. */
export async function withPublicShare<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> { … }

/** Audited escape hatch. Logs `reason` at warn level with a stack. Permitted
 *  only in the auth bootstrap (users/sessions/identities) and the migration
 *  scripts. A test asserts it is never called from routes/. */
export async function withoutOrgScope<T>(reason: string, fn: (tx) => Promise<T>): Promise<T> { … }
```

**`withOrg` must refuse to nest.** `db.transaction()` on `node-postgres` nests via savepoints, and
a GUC set inside a savepoint that is **released** persists for the remainder of the outer
transaction. Verified: an outer scope at org 1 saw `[a, b, legacy]`; an inner `withOrg` at org 2
ran; after `RELEASE SAVEPOINT` the *outer* scope saw `[c, legacy]` — org 2's data, silently, with no
error. (`ROLLBACK TO SAVEPOINT` does restore it, so only the success path is dangerous.) A shared
helper that calls `withOrg` internally makes this trivially reachable. Therefore:

```ts
// first statement inside the transaction, before any set_config
const [{ existing }] = await tx.execute(sql`select
  nullif(current_setting('app.current_org_id', true), '') as existing`);
if (existing != null) {
  throw new Error(
    `withOrg cannot nest: already scoped to organization ${existing}. ` +
    `Pass the existing ScopedTx down instead of opening a new scope.`);
}
```

The `it("withOrg refuses to nest")` test is not optional — it is the guard against the one failure
mode in this whole mechanism that returns the *wrong* rows rather than *no* rows.

Three further details that are easy to get wrong:

- **`set_config(..., true)`, not `SET LOCAL`.** They are equivalent inside a transaction, but
  `set_config` takes a **bind parameter**, so the organisation id is never string-interpolated into
  SQL. And `SET LOCAL` outside a transaction *silently succeeds and does nothing* — verified. Since
  `db.transaction()` on `node-postgres` pins a single pooled client for the callback's lifetime,
  the setting cannot escape to another request.
- **`current_setting`'s value is a string.** `set_config` requires `String(organizationId)`; passing
  a number throws.
- **`withOrg` returns a `tx`, not `db`.** Route code must use the handle it is given. A route that
  closes over the module-level `db` inside a `withOrg` callback runs *outside* the transaction and
  therefore outside the GUC — it would see zero rows, which is loud, not silent. Still, forbid it:

  ```ts
  // artifacts/api-server/src/db-import.test.ts
  // Fails if any file under routes/ imports `db` from @workspace/db.
  // Routes get their handle from withOrg/withPublicShare, never directly.
  ```

`ingestSourceObservations(db, …)` in `artifacts/api-server/src/lib/asset-ingest.ts:111` already opens
its own `db.transaction()` — which, per the nesting rule above, must **stop**: it takes the caller's
`ScopedTx` and uses it directly rather than opening a second scope. `DEFAULT_ORGANIZATION_ID`
(line 23) is **deleted** — with RLS in place, a hardcoded organisation default is exactly the bug
the whole mechanism exists to prevent. **`artifacts/api-server/src/lib/asset-ingest.test.ts`
constructs its own db handle and must be updated in the same change**, to
`createTestDb({ asRole: "quantaxscan_app" })` plus a `withOrg` wrapper; otherwise P1 lands with a
failing test whose cause the implementer has to reverse-engineer.

---

## 6. The API boundary

### 6.1 Two authentication schemes, one principal

```
requireApiKey  →  resolvePrincipal  →  requireAuth (per route)
```

`resolvePrincipal` runs after `express-session` and produces exactly one of:

| Principal | Source | `organizationId` | `userId` |
|---|---|---|---|
| `session` | valid `__Host-qx.sid` | from `organization_members` | the user |
| `apiKey` | valid `QUANTAXSCAN_API_KEYS` | `QUANTAXSCAN_API_KEY_ORG_ID` (default `1`) | `null` |
| `anonymous` | neither | — | — |

**The shared API key survives as a break-glass and machine credential**, not as the user path. It
is what keeps CI, the backfill scripts and any server-to-server caller working across the cut-over,
and removing it would re-open S1 for those callers. It is now **explicitly bound to one
organisation** by configuration, so it can no longer read everything — that is the difference
between the interim control and the finished one. `08-security.md:41` notes the key "*means S8 audit
logging cannot attribute access to a person*"; that stays true and is now the documented reason it
is a break-glass credential rather than a normal one. Its remaining gap — key rotation without
downtime — is out of scope here (§11).

The middleware order in `app.ts` becomes:

```
pino-http  →  cors  →  session  →  resolvePrincipal  →  requireApiKeyOrSession
    →  csrfFetchMetadata  →  express.json  →  router
```

`cors()` stays ahead of everything, as it is today, so `OPTIONS` preflight terminates there rather
than being answered with a 401 (`app.ts:62-64`). Authentication stays **ahead of the body parsers**,
preserving the existing property that an unauthenticated request is rejected without buffering 10 MB
of JSON (`app.ts:66-68`).

### 6.2 The public allowlist

`PUBLIC_ROUTES` in `artifacts/api-server/src/lib/auth.ts:30-39` is extended, not replaced. **A test
pinning this table does not exist at `2c0e5bd`** — I checked; `artifacts/api-server/src` contains
only `scanner.test.ts` and `asset-ingest.test.ts`. If it is being written in another lane, this is
the contract it must encode:

| Path | Method | Public? | Change |
|---|---|---|---|
| `/healthz` | GET | ✅ | unchanged |
| `/demo/repos` | GET | ✅ | unchanged |
| `/demo/repos/:slug/scan` | POST | ✅ | **stops writing to `activity`** — an unauthenticated route should not write to the database, and a hardcoded demo scan produces no useful audit row. Becomes fully read-only |
| `/community/posts` | GET | ✅ | unchanged |
| `/community/leaderboard` | GET | ✅ | unchanged |
| `/reports/:id` | GET | ✅ | **still public, now conditionally** — goes through `withPublicShare()`, so `visibility='public' AND revoked_at IS NULL AND expires_at > now()` is enforced by the policy. Adds `X-Robots-Tag: noindex, nofollow` |
| `/auth/providers` | GET | ✅ **new** | |
| `/auth/:provider/start` | GET | ✅ **new** | |
| `/auth/:provider/callback` | GET | ✅ **new** | |
| `/auth/session` | GET | ✅ **new** | returns `{user: null}` when anonymous; never 401 |
| `/auth/logout` | POST | ✅ **new** | idempotent when already signed out |
| `/stats/public` | GET | ✅ **new** | see §6.4 |
| `/community/posts` | POST | ❌ **now protected** | it writes; today it is protected only because it is not on the list. Keep it that way and attribute the author |
| everything else | | ❌ | unmatched routes stay default-deny |

The regexes are mount-relative (`/auth/…`, not `/api/auth/…`) — the router is mounted at `/api`.
`:provider` matches `[^/]+` and is validated in the handler.

### 6.3 The session is not trusted for authorisation

`req.session.organizationId` is a **cache**, not a grant. On every authenticated request,
`resolvePrincipal` re-reads `organization_members` for `(userId, organizationId)` and 403s if the
row is gone. Without this, revoking a member leaves them with access until their cookie expires —
up to 7 days under the absolute cap. The read is a single indexed lookup on the
`(organization_id, user_id)` primary key and is cheap.

### 6.4 `/api/stats` splits in two

`routes/stats.ts:9-14` selects **five whole tables unfiltered** and returns `recentActivity`
containing descriptions like `Multi-file scan: 3 critical vulnerabilities found across 12 files in
"<projectName>"`. That is a cross-tenant project-name leak on a route the marketing homepage calls.

- `GET /api/stats/public` — **public.** Aggregate counters only: `totalReposScanned`,
  `totalVulnerabilitiesFound`, `totalLinesScanned`, `totalCommunityPosts`, `mostCommonAlgorithm`.
  Computed with `count()`/`sum()` aggregates, not by selecting whole tables into memory. **No
  `recentActivity`, no names.** Runs through `withoutOrgScope("public platform counters")`.
- `GET /api/stats` — **authenticated, org-scoped.** The full shape including `recentActivity`,
  through `withOrg`.

`artifacts/quantaxscan/src/pages/Home.tsx:134` currently calls `useGetGlobalStats()`, which maps to
`/api/stats` — protected. Under the interim key the homepage stats bar is already broken for the
browser. It moves to `/api/stats/public`. This requires an `openapi.yaml` change and an
`orval` regeneration of `lib/api-client-react` and `lib/api-zod`.

### 6.5 The browser stops being a second-class citizen

Today the browser holds no credential, so every gated action fails — `09-open-gaps.md:308-313`
records this as an expected outage of the product's headline flow. The session cookie is the fix,
and it needs one code change to be usable:

`lib/api-client-react/src/custom-fetch.ts:363` calls `fetch(input, {...init, method, headers})` with
**no `credentials` option**. The default is `credentials: "same-origin"`, which works in the
same-origin production topology and does not in the split dev topology. Set it explicitly:

```ts
const response = await fetch(input, { credentials: "include", ...init, method, headers });
```

`setAuthTokenGetter()` (line 43) stays for non-browser consumers; its own comment already says it
"*should never be used in web applications where session token cookies are automatically associated
with API calls*". The raw `fetch(apiUrl(...))` calls in `Scan.tsx`, `Dashboard.tsx` and `Report.tsx`
need the same option, or better, should move to the generated client.

### 6.6 Development topology

`docker-compose.yml` runs the SPA on `:5173` and the API on `:5000` — cross-origin, where a
`SameSite=Lax` cookie is not sent. Rather than weakening the cookie for everyone, **make dev
same-origin**: add a Vite dev-server proxy so `/api` on `:5173` forwards to `:5000`.

```ts
// artifacts/quantaxscan/vite.config.ts — server: { … }
proxy: { "/api": { target: process.env.API_PROXY_TARGET ?? "http://localhost:5000", changeOrigin: false } }
```

`CORS_ALLOWED_ORIGINS` then needs no entry for dev, and the production allowlist stays as it is.

---

## 7. The interface

The visual review's finding is that the site advertises a product a visitor cannot use. The resolution
is not "show less" — it is to make the boundary between *try it* and *keep it* explicit.

### 7.1 What an anonymous visitor gets

Unchanged and fully working, with no sign-in and no session row:

- The marketing pages (`/`, `/coverage`, `/security`, `/community`) — `/community` read-only.
- **`/demo/:slug`** — the hard-coded demo repositories, end to end. `08-security.md` already keeps
  these public and they are the honest answer to "let me see it work".
- `/scan` **in a "try it" mode**: paste or upload code, or point at a **public** GitHub repository,
  and see the findings rendered. The scan runs; **nothing is persisted**; the result lives in
  page state.
- `/report/:id` for a valid, unexpired, unrevoked public share link.

Anonymous `/scan` is the single most important interface decision in this document. It preserves the
product's headline flow for a first-time visitor, and — because it persists nothing — it is also
strictly better for S3 than what exists today. It requires a `POST /api/scans/ephemeral` that
returns findings without writing `scans`, `findings`, `assets` or `observations`. Rate-limited by
IP (§8.2 dependency), body-size-capped.

### 7.2 What requires signing in

Anything that persists, is attributed, or reads back: creating a project, saving a scan to the
dashboard, `/dashboard` itself, creating a shared report, posting to the community, `/api/chat`.

The gate is a component, not a route guard, so the *page* still renders:

```tsx
<Gated action="save this scan">   {/* signed out → an inline sign-in prompt in place of the button */}
  <Button onClick={saveScan}>Save to dashboard</Button>
</Gated>
```

A signed-out visitor on `/dashboard` sees the real dashboard chrome with an empty state and a
sign-in prompt — not a redirect. They should be able to see what they would get.

### 7.3 Sign-in

`/signin`, rendered from `GET /api/auth/providers` so an unconfigured provider never renders:

```
                Sign in to QuantaXscan
     ┌──────────────────────────────────────────┐
     │  [G]  Continue with Google               │
     │  [ ]  Continue with GitHub               │
     │  [⊞]  Continue with Microsoft            │
     └──────────────────────────────────────────┘
   We only ever receive your name, email and avatar.
   Scanning private repositories is a separate step
   you approve later.          Privacy · Security
```

Each button is a plain link to `/api/auth/{provider}/start?returnTo=<current path>` — a top-level
navigation, which `SameSite=Lax` permits and which avoids a fetch/redirect dance.

The last line is deliberate. Sign-in and repository access are separate consents (§8), and saying so
on the sign-in page is what makes the later GitHub App install feel proportionate rather than
alarming.

### 7.4 Session state

`SessionProvider` at the root of `App.tsx`, backed by a react-query `useSession()` on
`GET /api/auth/session` (`staleTime` 60 s, refetch on window focus). It exposes
`{ user, organization, memberships, isLoading }`.

The navbar gains a right-hand slot: **Sign in** when anonymous; an avatar menu when signed in
(name, email, *Settings*, *Sign out*). The organisation switcher appears in that menu **only when
`memberships.length > 1`** — which is how "a solo user is an organisation of one and never sees the
concept" is implemented literally. A solo user sees their name; there is no org anywhere.

A `401`/`403` from any mutation invalidates the session query and shows a "your session ended"
prompt rather than a generic error.

---

## 8. Private-repository scanning — specified, sequenced last

### 8.1 What must close first — plainly

Holding a token that reads a customer's private source means a compromise of this service leaks
**their proprietary code**, not just their crypto inventory. The security document's opening
argument applies with more force, not less. **These are hard prerequisites. Private-repository
access must not ship before all of them are closed:**

| # | Finding | Why it blocks this specifically |
|---|---|---|
| **S3** | Full customer source persisted in `scans.code` | `routes/scans.ts:38-44` writes `code` unconditionally. Today that is public code. With this feature it becomes *private* code, stored in full, indefinitely, in a database with no encryption at rest. **This is the blocker.** Evidence snippets must be bounded and the full body dropped before a single private file is fetched |
| **S7** | SSRF surface in `routes/github.ts` | `parseGithubUrl` (line 61-69) accepts any hostname containing `github.com` — `https://github.com.attacker.tld/a/b` passes. The fetch targets are currently hardcoded to `api.github.com`/`raw.githubusercontent.com`, which limits today's blast radius, but the validation is not what is holding the line. Needs an exact-host allowlist, private/link-local IP rejection, redirect-host pinning and timeouts |
| **NEW** | **Bearer token forwarded across redirects** | `fetchRawFile` (line 216-220) passes the `Authorization` header into `fetchWithRetry` → bare `fetch`, which **follows redirects by default and re-sends the header to the redirect target**. With today's shared `GITHUB_TOKEN` that is bad. With a *customer's* repository token it is credential disclosure to whatever host GitHub redirects to. Fix: `redirect: "manual"`, validate each hop's host against the allowlist, re-attach the header only for allowlisted hosts. **This is not the same as S7 and must be tracked separately** |
| **S6** | No rate limits | `routes/github.ts` fetches arbitrary repositories on request with no per-caller limit. With authenticated private access this becomes an authenticated amplifier against GitHub *and* an uncapped egress path for a customer's code |
| **S2** (remainder) | Share-link expiry and revocation | Covered by §4.4. A private repository's findings behind a forever-valid, unrevocable, unlogged link is the same exposure by another route |
| **S8** | Audit logging | "*Who read this private repository's findings, and when*" is the first question in any incident and the first question in any security review |

S4 (CORS) and the CSPRNG half of S2 are already closed. S5 (`.env` in git) should be fixed
immediately and independently — it is two minutes and `SESSION_SECRET` is about to join
`QUANTAXSCAN_API_KEYS` as a real secret this repository must not leak.

### 8.2 The mechanism: a GitHub App, not an OAuth App

Sign-in with GitHub (§3) uses an **OAuth App** and asks for `read:user user:email` — identity only,
no repository access whatsoever. Private-repository scanning is a **separate GitHub App**, installed
separately, on repositories the customer picks. GitHub's own guidance:

- "*With a GitHub App, the user or organization owner who installed the app can decide what
  repositories the app can access.*"
- "*GitHub Apps use short lived tokens. If the token is leaked, the token will be valid for a
  shorter amount of time … Conversely, OAuth app tokens do not expire until the person who
  authorized the OAuth app revokes the token.*"
- "*if your app needs to read the contents of a repository, an OAuth app would require the `repo`
  scope, which would also let the app edit the repository contents and settings. A GitHub App can
  request read-only access to repository contents.*"
- "*In general, GitHub Apps are preferred over OAuth apps.*"

The OAuth `repo` scope is all-or-nothing across every repository the user can reach, and grants
**write**. For a product whose security page promises "*read-only, narrowly-scoped credentials you
issue*" (`Security.tsx:15`), asking for `repo` would contradict the marketing on our own site.

**Permissions requested:** `Contents: read-only`, `Metadata: read-only`. Nothing else. No webhooks
in v1.

**Flow:**

1. Signed-in user, in Settings → *Connect GitHub*, is sent to the App's install URL with `state`.
2. GitHub redirects to `/api/integrations/github/callback` with `installation_id` and `state`.
3. Store `github_installations { id, organizationId, installationId, accountLogin, accountType,
   connectedByUserId, connectedAt, revokedAt }`. **Bound to the organisation, not the user** — a
   member leaving must not silently break the org's scans, and the audit trail records who connected
   it.
4. **No long-lived token is stored.** At scan time, mint an installation access token by signing a
   short-lived JWT with the App's private key and calling
   `POST /app/installations/{id}/access_tokens`. Tokens expire in one hour; cache in memory only,
   never in the database, and never in `sess`.
5. The App's private key lives in the deployment's secret store — `GITHUB_APP_PRIVATE_KEY`,
   `GITHUB_APP_ID`, `GITHUB_APP_SLUG`. Never in `.env` (S5), never in the database
   (`08-security.md:214-215`).

**Scoping.** Repository listing goes through `GET /installation/repositories` with the installation
token — the customer's repository selection is enforced by GitHub, not by us. `parseGithubUrl` is
replaced by a resolver that only accepts `owner/repo` pairs present in that list.

**Data handling.** Private-repository scans use the S3-corrected path: bounded evidence snippets in
`observations.evidence.codeSnippet` only, no `scans.code`, no `fullTree`/`fetchedFiles` round-trip
through the browser (`/api/github/fetch` currently returns file contents to the client and
`/api/github/scan-files` accepts them back — that is a client-supplied-source path that must not
carry private code). Reports generated from a private repository default to `visibility: 'private'`
and, when explicitly shared, warn in the UI.

**Disconnect.** `DELETE /api/integrations/github/installation` sets `revokedAt` and calls
`DELETE /app/installations/{id}`, and the docs must state that uninstalling from GitHub's side also
works and is honoured (the installation token mint will 404).

---

## 9. Test strategy, including cross-tenant proof

### 9.1 The negative control — write this test first

pglite's connection runs as `postgres`, which is `rolsuper = t, rolbypassrls = t`. Verified:
with RLS enabled *and* `FORCE ROW LEVEL SECURITY` set, and no GUC at all, a `SELECT` returned **all
three rows across both organisations**. **Every cross-tenant test written naively against
`createTestDb()` will pass while proving nothing.**

`SET ROLE` fixes it, in-process, with no real Postgres required — the same probe under
`SET ROLE app_runtime` returned 0 rows with no GUC, 2 rows scoped to org 1, and 1 row scoped to
org 2. So:

```ts
// lib/db/src/test-support/test-db.ts  — extended, not replaced
export async function createTestDb(opts?: { asRole?: "quantaxscan_app" }): Promise<…>
// applies lib/db/drizzle/ migrations as today, then lib/db/sql/tenant-isolation.sql,
// then `SET ROLE quantaxscan_app` when asRole is given.
```

And the control itself, which must exist and must be the first thing anyone reads:

```ts
it("the harness role is actually subject to RLS — without this every isolation test is vacuous", async () => {
  const { db } = await createTestDb({ asRole: "quantaxscan_app" });
  const [role] = await db.execute(sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`);
  expect(role.rolsuper).toBe(false);
  expect(role.rolbypassrls).toBe(false);

  await seedTwoOrgs(db);
  // No GUC set at all. If this returns rows, RLS is not in force and
  // every other test in this file is meaningless.
  const rows = await db.select().from(projectsTable);
  expect(rows).toHaveLength(0);
});
```

This preserves what `AGENTS.md` values about the existing harness: it runs the **real** migrations
against a **real** Postgres and has already caught a real bug. It is extended, not replaced — and
it now also applies `lib/db/sql/tenant-isolation.sql` verbatim, so the suite exercises the exact
policies production gets rather than an approximation of them.

**The control was proven able to fail, not merely observed passing.** With the harness's
`SET ROLE` removed, 13 of the 29 tests in `lib/db/src/tenant-isolation.test.ts` fail — every
cross-tenant assertion in the file. With it, all 29 pass. A companion test pins that permanently:
it asserts that the *default* harness role sees all three seeded rows across both organisations
with no GUC set, so if anyone ever concludes "RLS must be off, the plain harness works fine", the
answer is already written down.

A first attempt at that sabotage was incomplete and is worth recording, because it is the shape of
mistake this whole section is about: removing the `SET ROLE` from `createTestDb` alone made only
*one* test fail, because the fixture helper's `finally` block re-applied the role on its way out.
Twelve genuinely vacuous tests looked fine. A negative control that is only half-disabled reports
success.

### 9.2 The migration-integrity test — this is the one that catches §5.4

```ts
const ORG_SCOPED_TABLES = ["projects","scans","findings","assets","observations",
                           "collection_runs","activity","shared_reports",
                           "organizations","organization_members"] as const;

it.each(ORG_SCOPED_TABLES)("%s has RLS enabled, forced, and a policy with a real USING clause", async (t) => {
  const [c] = await db.execute(sql`select relrowsecurity, relforcerowsecurity
                                     from pg_class where relname = ${t}`);
  expect(c.relrowsecurity).toBe(true);
  expect(c.relforcerowsecurity).toBe(true);

  const policies = await db.execute(sql`select polname, polqual is null as qual_is_null
                                          from pg_policy p join pg_class c on c.oid = p.polrelid
                                         where c.relname = ${t}`);
  expect(policies.length).toBeGreaterThan(0);
  // A NULL polqual is a policy that permits everything. This is exactly what
  // `drizzle-kit push` produces — see §5.4.
  expect(policies.every(p => p.qual_is_null === false)).toBe(true);
});
```

The same query backs `assertTenantIsolationInstalled()` at API-server startup, so the check runs
against the *real* production database, not only the test one.

### 9.3 The cross-tenant HTTP suite

`artifacts/api-server/src/cross-tenant.test.ts`, against the real Express app with a pglite-backed
`db` and a session cookie per user:

- **Fixtures:** org A (user A, owner), org B (user B, owner), user C in both. Each of A and B owns a
  project, a scan, findings, assets, observations, a collection run, an activity row, and a shared
  report.
- **Route manifest.** A table of every route in `routes/index.ts` with its expected principal and
  the resource it addresses. **A route present in the Express router but absent from the manifest
  fails the suite** — enumerate the router's stack and diff it. This is what stops a new route from
  quietly shipping unscoped.
- **For every resource-addressing route**, as user B against user A's id:
  `GET` → 404 (not 403 — do not confirm existence); `PUT`/`PATCH`/`DELETE` → 404 and **A's row is
  verified unchanged afterwards**; `POST` of a child carrying A's parent id → 404/400 and nothing is
  written.
- **List routes**: B's `GET /api/projects`, `/api/stats`, `/api/scans/*`, `/api/reports` return
  exactly B's rows, `length` asserted.
- **Membership:** B cannot `POST /api/auth/organizations/A/select` → 403. Removing C from A revokes
  access **on the very next request**, not on cookie expiry (§6.3).
- **User enumeration:** the member-list route under B never returns user A.
- **Public share:** A's `visibility='public'` report is readable anonymously; the same report
  `revoked_at`-set, or `expires_at` in the past, or `visibility='private'`, is 404 anonymously and
  readable by A.
- **API-key principal:** the shared key reaches only `QUANTAXSCAN_API_KEY_ORG_ID`'s data, and 404s
  on the other org's ids.
- **Deliberate-bug test:** a fixture route with a genuinely forgotten `where organizationId = …`,
  routed through `withOrg`, returns zero cross-tenant rows. This asserts the *mechanism*, not the
  discipline — it is the direct proof of `08-security.md:218-220`.

### 9.4 The rest

- **Allowlist pin** (§6.2): the exact `PUBLIC_ROUTES` set, asserted both ways — every listed route
  is reachable with no credential; a representative sample of unlisted ones is 401. Includes the
  unmatched-route default-deny case.
- **Auth flow**, with a stubbed IdP: `state` mismatch → 400; replayed callback → 400; expired
  transaction → 400; `nonce` mismatch → 400; PKCE verifier mismatch → 400; **session ID changes
  across login** (fixation); `returnTo` of `//evil.com`, `/\evil.com`, `https://evil.com`,
  `javascript:…` all fall back to `/dashboard`.
- **Identity linkage**, the security-critical table: verified-email Google then verified-email
  GitHub with the same address → **one** user, two identities. Microsoft with the same address →
  a **separate** user (because `emailVerified` is pinned false). Unverified GitHub email → separate
  user. Two providers asserting the same `sub` value for different providers → separate identities.
  Case-differing emails → one user.
- **CSRF:** state-changing request with no `Sec-Fetch-Site` and a foreign `Origin` → 403; with
  `Sec-Fetch-Site: same-origin` → allowed; API-key request with neither → allowed.
- **Cookie flags**, asserted on the raw `Set-Cookie` string: `__Host-` prefix, `HttpOnly`, `Secure`,
  `SameSite=Lax`, `Path=/`, **no `Domain`**.
- **Session store:** a session written and read back across three server `TimeZone` settings expires
  identically (the §2.3 regression test).
- **`withOrg` nesting:** a `withOrg` called inside another `withOrg` throws, and the outer scope's
  visible rows are unchanged afterwards. This is the §5.5 guard, and the only failure mode in the
  isolation mechanism that would return *another tenant's rows* rather than *no rows*.
- **`activity` NULL-org rows:** readable by every organisation, not updatable by any, deletable —
  asserted explicitly so the asymmetry in §5.3 is not "fixed" by a later reader.

---

## 10. What ships when

The sequencing the captain agreed: accounts, organisations and scoping first, with public
repositories and uploads; private repositories last, with the open security findings.

| Phase | Contents | User-visible | Gate to the next phase |
|---|---|---|---|
| **P0** | *Not this work.* Set `QUANTAXSCAN_API_KEYS` on the deployment and redeploy | API stops being open | — |
| **P1** ✅ **BUILT** | Schema + migration (§4) · roles, grants, policies (§5) · `withOrg` · `assertTenantIsolationInstalled` · cross-tenant suite (§9) · S5 (`.env` out of git) | **None.** API-key principal maps to org 1; every existing caller is unaffected | §9.1–9.3 green, including the negative control |
| **P2** | `/api/auth/*` · session + cookie (§3) · Google + GitHub sign-in · `resolvePrincipal` · allowlist update · `credentials` on the API client | Sign-in works; API accepts session **or** key | Auth + linkage tests green; allowlist pin green |
| **P3** | Sign-in page · session state · `<Gated>` · anonymous `/scan` (ephemeral) · `/api/stats` split · Microsoft provider | The site becomes usable by a visitor again | Visual review |
| **P4** | `shared_reports` auth/expiry/revocation UI · S8 audit log · S6 rate limits · S3 (stop persisting `scans.code`) · S7 + the redirect-token-leak fix | Share links expire and can be revoked | **All of §8.1 closed** |
| **P5** | GitHub App · installation storage · private repository picker · private scan path | Private repositories | — |

P1 is deliberately invisible. It is the largest and riskiest change, and shipping it with no
behaviour change means a regression shows up as *zero rows* — loud and immediate — rather than as a
subtle authorisation bug mixed in with a login flow.

### Deploying P1 — the order is not optional

`assertTenantIsolationInstalled()` gates startup, so a release that reaches production before the
database has been prepared **will refuse to boot**. That is the intended failure: loud, at start,
rather than an API serving requests with no isolation. The order:

```
1. pnpm --filter @workspace/db run apply-tenancy   # data migration: backfill, then constrain
2. pnpm --filter @workspace/db run push            # reconcile anything left
3. pnpm --filter @workspace/db run apply-rls       # roles, grants, policies
4. point DATABASE_URL at quantaxscan_app, then deploy
```

`apply-tenancy` needs `CAPTAIN_EMAIL` and refuses to run without it — it seeds the owner of
organisation 1, which every pre-existing row is assigned to.

**It runs first, before `push`, and creates the three tenancy tables itself.** That ordering is
forced rather than chosen: `push` cannot add a `NOT NULL` column to a populated table, so it
cannot run until the backfill has happened — and the backfill needs `organizations` to exist to
point a foreign key at. `push` then adds what `apply-tenancy` deliberately leaves alone (foreign
keys, indexes, `CHECK` constraints), for which it needs no help. Both scripts are idempotent and
were re-run to confirm it.

**That last claim was checked rather than assumed**, because trusting `push` to have added things
because it said "Changes applied" is the exact mistake §5.4 exists to prevent. Two databases were
built on the same server — one by the three generated migrations alone (the *fresh* path, which is
what the test harness exercises), one by `apply-tenancy` → `push` over a populated pre-P1 schema
(the *upgrade* path, which only production takes) — and their `pg_constraint` and `pg_indexes`
contents were diffed. **68 objects, identical, 17 foreign keys each.** Spot-checked live:
`user_identities_provider_subject_idx` rejects a second user claiming the same
`(provider, provider_user_id)`, which is the constraint standing between P2's account linking and
an account-takeover.

Worth re-running as a pre-deploy check if the schema changes, because nothing in CI covers it: the
harness always takes the fresh path, so an upgrade-path gap would be invisible there.

**This whole sequence was verified end to end against real PostgreSQL 16.14**, not only against
the pglite harness: a database built to the pre-P1 schema, populated the way production is, then
migrated. All rows survived and were stamped to organisation 1; the legacy NULL-organisation
`activity` row was preserved; `shared_reports` was backfilled to public with a 30-day expiry;
`sessions.expire` became `timestamptz`. The API server then booted as `quantaxscan_app` and
`GET /api/projects` returned the pre-existing projects exactly as before. As that role,
`rolbypassrls` and `rolsuper` are both false, an unscoped read returns zero rows, a read after a
committed transaction returns zero rows *without erroring* (the `nullif` fix), and a
wrong-organisation insert is rejected by `WITH CHECK`. Rewriting one policy to the shape
`drizzle-kit push` produces made the server refuse to start, naming the table and the reason.

**Step 4 is what makes the guarantee real.** Until the runtime authenticates as a role with no
`BYPASSRLS` and no table ownership, the policies installed in step 3 are inert — the code will work
identically and prove nothing. P1 can merge, pass CI and deploy without step 4, and everything will
look fine. Do step 4.

### One thing to do before a second organisation exists

`apply-tenancy` leaves existing `activity` rows at `organization_id IS NULL`, and the policy admits
NULL on read **for every organisation** — that is §5.3 working as designed for a legacy global
feed. But those rows carry descriptions like `Multi-file scan: 3 critical vulnerabilities found
across 12 files in "<projectName>"`, which is organisation 1's real project names, and
`GET /api/stats` returns them in `recentActivity`. §6.4 calls that exact content a cross-tenant
project-name leak.

Today there is one organisation, so nothing leaks. **The moment P2 creates a second one, it
does.** The policy already makes the answer available — NULL-org rows are readable and
**deletable**, just not updatable — so this is a `DELETE FROM activity WHERE organization_id IS
NULL`, to be run before the second tenant is created, not a code change. It belongs with the
existing "purging real project names needs database access" item in
[08-security.md](08-security.md).

**Closed, not merely noted.** `pnpm --filter @workspace/db run create-organization`
(`lib/db/scripts/create-organization.ts`) is what makes a second organisation possible at all (see
§14 deviation 10), so it is also where this purge had to land — leaving it a separate manual step
would have meant the one operator action that *creates* the leak window never mentions closing it.
The script runs the `DELETE` above, inside the same transaction as the `INSERT INTO organizations`,
every time it actually creates a new organisation (idempotent re-runs on an existing slug do not
re-run it, which is harmless — the delete is itself idempotent).

The README sentence **"Do not scan private or proprietary code on the hosted instance"**
(`README.md:316`) is removable at the end of **P4**, not P5 — because P4 is what stops persisting
full source and closes the fetcher findings. P5 then adds private repositories to an instance that
is already safe for proprietary code.

---

## 11. What I would not build

Each of these is excluded deliberately, with the reason and the trigger that would change it.

| Excluded | Why | Revisit when |
|---|---|---|
| **Email/password sign-in** | Password storage, reset flows, breach monitoring, and credential stuffing are a whole security surface bought for zero users. Three IdPs cover everyone | A design partner has no Google/GitHub/Microsoft identity |
| **MFA / TOTP** | The IdPs already enforce it, and enforcing it *again* locally is weaker than what Google or Entra do | Self-hosted deployments without an IdP |
| **SAML / SCIM / directory sync** | Enterprise-edition features (`10-editions.md:159-160`); no buyer yet | First enterprise pilot asks |
| **Roles beyond `owner` / `member`** | `admin` with no distinct permission is a label. Widening the `CHECK` is a one-line diff | A permission genuinely differs between them |
| **Per-user API tokens (PATs)** | The shared key covers machine access. Per-user tokens are a second credential lifecycle — issuance, scoping, rotation, revocation, listing | A customer needs CI attribution per person |
| **Shared-key rotation without downtime** | `08-security.md:45` lists it as outstanding. It is real, but it is a property of the *break-glass* credential, and the browser path no longer depends on it | Before the break-glass key is given to anyone outside the team |
| **Self-serve organisation deletion** | Deletion must cascade `assets`/`observations` via the `project:<id>:` prefix convention (`08-security.md:116-126`), revoke GitHub installations, and purge share links. Getting it wrong leaves customer source behind. **This is not a silent drop** — the pre-pilot checklist requires "*a working deletion path*", so P4 must ship a **documented, tested, operator-run** deletion runbook | Self-serve, when there is a self-serve signup funnel |
| **Invitations by email** | Needs transactional email, which this project has no provider for. v1 adds members by **existing account**: an owner enters a signed-in user's email, and the invite is accepted in-app on their next sign-in | An email provider is chosen |
| **Domain-based auto-join** | Auto-joining anyone with an `@acme.com` address is an account-takeover vector unless domain ownership is verified. Verification is a whole feature | Domain verification exists |
| **Cross-organisation report sharing** | The public-link mechanism (§4.4) already covers the real use case | A customer asks for named cross-org access |
| **Impersonation / support login** | The most abusable feature in any SaaS. Not before an audit log exists to record it | After S8, with explicit consent and audit |
| **`conversations` / `messages` scoping** | Dead tables — `routes/chat.ts` persists nothing. Scoping them would be scoping fiction. They receive **no `GRANT`**, so they are inaccessible to the runtime | Chat history is actually persisted |

---

## 12. Decisions that are the captain's, not mine

Each has a stated default so the implementer is never blocked. **P1 built the default in every
case below that it touched** (1, 2, 3, 5); 4 and 6 belong to phases not yet built. A captain's
answer that differs from a default is still welcome — items 2 and 3 in particular are a one-line
diff and one script re-run respectively.

1. **Does the shared API key survive, and to which organisation?**
   *Default, and what was built: yes, as break-glass and machine access, bound to
   `QUANTAXSCAN_API_KEY_ORG_ID=1`.*
   Removing it entirely is cleaner but breaks CI, the backfill scripts and any server-to-server
   caller at the cut-over.

2. **`owner | member`, or `owner | admin | member`?**
   *Default, and what was built: `owner | member`.* `admin` is only worth a value if some
   permission actually differs. Widening the `CHECK` built from `ORG_ROLE_VALUES` is a one-line
   diff.

3. **Legacy `shared_reports` rows: expire in 30 days, or revoke immediately?**
   *Default, and what was built: 30-day expiry* (`apply-tenancy`, overridable via
   `LEGACY_SHARE_LINK_TTL`; the script has not been run against production yet, so this is still
   changeable at no cost). They carry weak `Math.random()` IDs and are enumerable today.
   Immediate revocation is safer and breaks any link already circulating. This is a judgement about
   who might be holding those links, which the captain knows and I do not.

4. **Microsoft tenant policy.** *Default: `ENTRA_TENANT=organizations` with no `tid` allowlist* —
   any Entra work/school account, no personal Microsoft accounts. A single-tenant GUID is stricter;
   `common` is looser and I would not ship it.

5. **Does the captain's existing account keep the previously-public project names?**
   The brief says yes, and that is what `apply-tenancy` does — recorded here because the migration
   assigns them to organisation 1 rather than purging, and `08-security.md` still lists purging as
   outstanding. **This design does not close that item.** It scopes the names to one organisation; deleting them is still a separate
   database action.

6. **Anonymous `/scan` (§7.1) — does the "try it without an account" path ship?**
   *Default: yes.* It is the answer to "the site advertises a product a visitor cannot use", and it
   persists nothing. If the captain would rather gate all scanning behind sign-in, §7.1 shrinks to
   the demo repositories and P3 gets smaller.

---

## 13. Five things that will bite the implementer

Repeated here because they are the ones that produce a *silently* wrong result rather than an error.
The fifth was found during P1, by a test that expected a cross-tenant write to fail and watched it
succeed.

1. **`drizzle-kit push` will make you think RLS is installed when it is not.** Policies created by
   `push` have `polqual IS NULL` and permit every row. Use hand-written SQL, and make
   `assertTenantIsolationInstalled()` a startup gate (§5.4).

2. **pglite makes cross-tenant tests pass without proving anything.** Its role is `postgres`,
   `rolbypassrls = t`. Write the negative control in §9.1 before any isolation test.

3. **A nested `withOrg` silently re-scopes its parent.** A GUC set inside a released savepoint
   persists for the rest of the outer transaction, so an inner scope at org B leaves the outer scope
   at org B. This is the only failure mode here that returns *another tenant's rows* rather than
   *no rows*. `withOrg` must throw on nesting (§5.5).

4. **`secure: true` without `X-Forwarded-Proto` emits no cookie at all.** Sign-in appears to
   succeed, the redirect happens, and the user is anonymous. Verified. `app.set("trust proxy", 1)`
   plus `proxy: true`, and `secure` conditional on `NODE_ENV` (§3.8).

5. **A FOREIGN KEY IS NOT SUBJECT TO ROW-LEVEL SECURITY.** PostgreSQL checks referential integrity
   with the policies bypassed, so `insert into scans (organization_id, project_id) values (B, <a
   project belonging to A>)` is **accepted**. The `WITH CHECK` still stamps the row with the
   caller's organisation, so no data leaks — but the result is a row in one tenant whose parent
   belongs to another, which then cascades from *their* delete.

   RLS scopes rows; it does not scope the *references between* them. Anywhere a client supplies a
   parent id, the parent must be confirmed visible **inside the scope** before the child is
   written:

   ```ts
   const [parent] = await tx.select({ id: projectsTable.id })
     .from(projectsTable).where(eq(projectsTable.id, projectId));
   if (!parent) return null;   // 404 — indistinguishable from "does not exist"
   ```

   Found in `POST /api/scans` by the cross-tenant suite. Reading the policies would not have found
   it; only trying the write did.

Three lower-stakes ones, all of which cost real time in P1:

- **`db.execute()` does not return an array.** It returns `{ rows, fields, affectedRows }` under
  both `node-postgres` and pglite. Earlier drafts of §5.5 wrote
  `const [{ existing }] = await tx.execute(...)`, which throws — and that is the *nesting guard*,
  the one place in this mechanism where a misread fails open. Use `executeRows<T>()` from
  `@workspace/db/org-scope`, which exists because drizzle types `execute` against the driver's
  result HKT and so returns `unknown` on a generic handle.
- **PGlite's `query()` rejects multi-statement SQL** — "cannot insert multiple commands into a
  prepared statement", because it uses the extended protocol. Use `exec()` for the policy file.
- `connect-pg-simple`'s default table is `session`, **singular**. Pass `tableName: "sessions"` or
  it will silently look at a table that does not exist.

---

## 14. Deviations from the specification as built

Recorded rather than silently absorbed. Everything else in §4, §5 and §9.1–9.3 was built as
written.

| # | Specified | Built | Why |
|---|---|---|---|
| 1 | This document lives at `docs/Claude/11-auth-and-tenancy.md` | `13-auth-and-tenancy.md` | `11-` and `12-` were taken by `11-ui-defect-fixes.md` and `12-test-suite.md`, both committed after this was written. The rationale — "the next free number in the sequence" — is unchanged; the number is not |
| 2 | `withOrg` detects nesting by probing the GUC as its first statement | An `AsyncLocalStorage` guard that refuses **before** opening a transaction, with the GUC probe kept as a database-level backstop | The GUC probe can only run once a transaction is open, and opening one is exactly what a nested call must not get to do. On a single-connection driver a nested `BEGIN` deadlocks against its own parent (measured: it hangs, it does not throw, so the probe never runs); on a pooled driver it checks out a *second* client, where the probe sees a pristine session and waves it through. Refusing in-process is correct on both |
| 3 | `withOrg` refuses to nest | `withPublicShare` and `withoutOrgScope` refuse too | Same failure, same guard. A `withPublicShare` nested inside a `withOrg` is not unscoped, it is silently scoped to the parent |
| 4 | New `shared_reports` rows take the column default `visibility = 'private'` | `POST /api/reports` writes `'public'` explicitly, with a 365-day `expires_at` | A private row is invisible through `withPublicShare`, so the default would break the share link the caller was just handed — a live regression in the phase that is supposed to have none. §4.4's 30-day figure is about the *legacy backfill*, not about rows created before a sharing interface exists. Both are strictly stronger than today's "never expires". P4 flips the default when there is a UI to express the choice |
| 5 | `POST /demo/repos/:slug/scan` stops writing to `activity` in P2 (§6.2) | Done in P1 | Not a choice: the route is public, so it has no organisation, so `activity`'s `WITH CHECK` rejects the insert. §5.3's policy depends on this route no longer writing, so the two cannot be separated |
| 6 | — | `POST /api/scans` confirms the parent project is visible in-scope | See §13.5. A foreign key is not subject to RLS |
| 7 | `apply-rls` creates roles with passwords | Roles are created without one; `apply-rls` sets them from `QUANTAXSCAN_APP_DB_PASSWORD` / `QUANTAXSCAN_MIGRATOR_DB_PASSWORD` when supplied | A password must not be a literal in committed SQL. Without the variables the roles cannot log in, which fails closed |
| 8 | `DELETE /api/projects/:id` on another organisation's id returns 404 (§9.3) | 204, having changed nothing | The handler issues a scoped delete that matches zero rows; distinguishing "not yours" from "already gone" would need an extra read whose only purpose is to produce a different status code. 204-for-everything is no worse an existence oracle than 404-for-everything, and it is what the route already did for an unknown id. The suite asserts the row survives intact, which is the property that matters |
| 9 | — | `quantaxscan_migrator` is granted `BYPASSRLS` | `FORCE ROW LEVEL SECURITY` subjects the table *owner* to the policies, and the policies name `quantaxscan_app` — so without this a future data migration would silently see zero rows. It is also exactly why the runtime must not use this role |
| 10 | §6.1: the shared API key is "explicitly bound to one organisation by configuration" (`QUANTAXSCAN_API_KEY_ORG_ID`) | `QUANTAXSCAN_API_KEY_ORG_IDS` binds **N** keys to **N** organisations, positionally paired with `QUANTAXSCAN_API_KEYS`; the single-value `QUANTAXSCAN_API_KEY_ORG_ID` is kept as a legacy fallback (applies to every key when the plural variable is unset) rather than removed. A new operator script, `pnpm --filter @workspace/db run create-organization`, creates the second (or Nth) organisation that binding needs — the piece this document's F2 gap (§10, "what is missing is the ability to *create* a second tenant") named as absent | This is F1's scope, not P2's — no sign-in, no sessions, no per-user identity was added; it is still exactly one *kind* of principal (the API key), now able to be more than one *instance* of it. A length mismatch between the two env vars is a startup error, matching this document's own standard elsewhere ("a key with no explicit organisation binding must not silently become organisation 1"). See `artifacts/api-server/src/lib/principal.ts` |

### What P1 did **not** do

- **No sign-in, sessions, providers, or interface.** §3, §6.2's new routes, §7 and §8 are
  unbuilt. The API-key middleware is untouched and remains the only authentication.
- **S1 is not closed.** There is still no per-user identity. `08-security.md` says so and should
  keep saying so.
- **The `users` and `user_identities` tables exist but nothing reads them.** They land with the
  rest of the schema so the migration happens once, not because anything uses them yet.
- **The session-cookie half of §9.3** — two signed-in users, membership revocation taking effect on
  the next request — needs sign-in. It is absent deliberately, and `03-features.md` records F1 as
  partial rather than done.

### Pointer updates that go with this document

- `docs/Claude/README.md` — `13` added to the index.
- `docs/Claude/08-security.md` — §"Tenant isolation" points here for the implementation; S5 is
  closed; S1 and S2 explicitly are not.
- `docs/Claude/09-open-gaps.md` — G-13 closed; G-12's remainder points here.
- `AGENTS.md` — the `drizzle-kit push` / RLS carve-out from §4.6, which is a correction to an
  instruction future agents would otherwise follow into a silent security hole.

---

# Appendix A — Evidence log

Everything below was run in the disposable worktree at `2c0e5bd` on **2026-08-03**. Output is
verbatim, trimmed only where marked.

### A.1 — Live deployment state

```
$ curl -sS -I https://quantaxscan.swotpam.com/api/healthz
HTTP/2 200
x-powered-by: Express
access-control-allow-credentials: true
strict-transport-security: max-age=63072000; includeSubDomains

$ curl -sS -I https://quantaxscan.swotpam.com/
HTTP/2 200
content-type: text/html; charset=utf-8

$ curl -sS https://quantaxscan.swotpam.com/config.js
window.__APP_CONFIG__ = { apiBaseUrl: "" };

$ curl -sS -o /dev/null -w "%{http_code}\n" https://quantaxscan.swotpam.com/api/projects
200
$ curl -sS -o /dev/null -w "%{http_code}\n" https://quantaxscan.swotpam.com/api/stats
200
```

SPA and API on one origin; `apiBaseUrl` empty confirms the frontend calls relative `/api` paths.
`/api/projects` returns 200 with real project names to an unauthenticated caller — the interim key
is not deployed.

### A.2 — RLS semantics under pglite

`node lib/db/rls-probe.mjs`, PGlite 0.5.4 / PostgreSQL 18.3:

```
=== A. default pglite role ===
current_user + bypassrls          => [{"current_user":"postgres","rolsuper":true,"rolbypassrls":true}]
count with NO GUC, RLS+FORCE on   => [{"n":3}]          ←  RLS bypassed entirely

=== B. same session, SET ROLE app_runtime ===
count with NO GUC (fail closed)   => [{"n":0}]
count scoped to org 1             => [{"n":2}]
count scoped to org 2             => [{"n":1}]
direct cross-tenant id fetch      => []                 ←  org-2 row invisible while scoped to 1
cross-tenant UPDATE attempt       => []
cross-tenant DELETE attempt       => []
WITH CHECK: insert into org 2 while scoped 1
                                  => ERROR: new row violates row-level security policy for table "widgets"
insert into own org               => [{"id":5}]

=== C. garbage / injected GUC value ===
count with non-numeric GUC        => ERROR: invalid input syntax for type integer: "not-a-number"
count with injection-ish GUC      => ERROR: invalid input syntax for type integer: "1 or true"

=== D. SET LOCAL inside a transaction, and leakage after ===
inside txn                        => [{"n":1}]
after commit — GUC must be gone   => ERROR: invalid input syntax for type integer: ""

=== E. can the app role read a table it has no GRANT on? ===
SELECT on a table with no GRANT   => ERROR: permission denied for table unguarded
```

Second probe, `nullif` normalisation and `set_config`:

```
=== nullif() normalisation ===
never set                                         => [{"n":0}]
set to 1                                          => [{"n":2}]
after RESET (empty string, must be 0 not error)   => [{"n":0}]
after SET ''                                      => [{"n":0}]

=== SET LOCAL outside a transaction ===
SET LOCAL with no txn                             => ok
does it stick outside a txn?                      => [{"n":0}]
raw guc value                                     => [{"guc":"<empty>"}]     ←  silently no-op

=== set_config(..., true) = transaction-local, parameterisable ===
set_config local                                  => [{"set_config":"2"}]
scoped read inside txn                            => [{"n":1}]
after commit                                      => [{"guc":"<empty>"}]
count after commit                                => [{"n":0}]

=== child table with NO org column, policy via parent join ===
obs visible via parent policy (expect only o1)    => [{"note":"o1"}]
```

Third probe — GUC behaviour across savepoints, and the mutability of NULL-org rows:

```
=== 1. nested set_config across a SAVEPOINT — the withOrg-inside-withOrg case ===
outer: set org 1            => [{"set_config":"1"}]
outer sees                  => [{"name":"a"},{"name":"b"},{"name":"legacy"}]
inner: set org 2            => [{"set_config":"2"}]
inner sees                  => [{"name":"c"},{"name":"legacy"}]
AFTER RELEASE — outer GUC?  => [{"g":"2"}]                                  ←  inner value persists
outer sees NOW              => [{"name":"c"},{"name":"legacy"}]             ←  OUTER SCOPE NOW SEES ORG 2

=== 2. same, but the inner savepoint ROLLS BACK ===
AFTER ROLLBACK TO — GUC?    => [{"g":"1"}]                                  ←  correctly restored

=== 3. NULL-org legacy rows under USING(... OR IS NULL) / WITH CHECK(= guc) ===
visible                                  => [{"name":"legacy"}]
UPDATE keeping organization_id NULL      => ERROR: new row violates row-level security policy for table "w"
DELETE the legacy row                    => [{"id":4}]
```

Conclusions used above: the default pglite role bypasses RLS (§9.1); `nullif(…,'')::int` fails
closed for both never-set and reset, bare `::int` errors after reset (§5.3); `SET LOCAL` outside a
transaction silently no-ops (§5.5); a non-numeric GUC errors rather than injecting; a parent-join
policy works but is not needed given denormalisation (§4.3); **a nested scope that succeeds
silently re-scopes its parent, which is why `withOrg` must refuse to nest** (§5.5); NULL-org
`activity` rows are readable and deletable but not updatable (§5.3).

### A.3 — `drizzle-kit push` drops RLS policy expressions

drizzle-orm 0.45.2, drizzle-kit 0.31.9, PostgreSQL 16.14 in a scratch container
(`qxs-authdesign-pg`, port 55471, removed afterwards).

The API exists:

```
$ node -e "const pg=require('drizzle-orm/pg-core');
           console.log(Object.keys(pg).filter(k=>/policy|rls|role/i.test(k)))"
[ 'PgPolicy', 'pgPolicy', 'PgRole', 'pgRole', 'EnableRLS' ]
```

`generate` is correct:

```sql
CREATE ROLE "quantaxscan_app";
CREATE TABLE "widgets" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "name" text NOT NULL );
ALTER TABLE "widgets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "widgets_org_isolation" ON "widgets" AS PERMISSIVE FOR ALL TO "quantaxscan_app"
  USING ("widgets"."organization_id" = current_setting('app.current_org_id', true)::int)
  WITH CHECK ("widgets"."organization_id" = current_setting('app.current_org_id', true)::int);
```

`push` is not:

```
$ npx drizzle-kit push --force --config /tmp/rls-push-config.ts
[✓] Changes applied

$ psql -c "select * from pg_policies;"
 schemaname | tablename |      policyname       | permissive |       roles       | cmd | qual | with_check
------------+-----------+-----------------------+------------+-------------------+-----+------+------------
 public     | widgets   | widgets_org_isolation | PERMISSIVE | {quantaxscan_app} | ALL |      |

$ psql -c "select polqual is null as qual_is_null, polwithcheck is null as check_is_null from pg_policy;"
 qual_is_null | check_is_null
--------------+---------------
 t            | t

$ psql -c "\d+ widgets"
Policies:
    POLICY "widgets_org_isolation"
      TO quantaxscan_app
```

Reproduced from empty a second time, and again with `to: "public"` and no `pgRole`:

```
=== A. push from empty, WITH pgRole ===   widgets_org_isolation | <<NULL>>
=== B. push from empty, NO pgRole    ===   widgets_org_isolation | {-} | <<NULL — POLICY PERMITS EVERYTHING>>
```

Applying `generate`'s SQL by hand gives the correct policy, and a subsequent `push` leaves it intact
but errors on `CreateRole`:

```
$ psql -f 0000_black_slipstream.sql && psql -t -c "select polname, pg_get_expr(polqual,polrelid) from pg_policy;"
 widgets_org_isolation | (organization_id = (current_setting('app.current_org_id'::text, true))::integer)

$ npx drizzle-kit push --force …
  routine: 'CreateRole'          ← errors; policy expression survives
```

### A.4 — `connect-pg-simple` against the existing `sessions` shape

`connect-pg-simple@10.0.0`'s actual statements (from `unpkg.com/connect-pg-simple@10.0.0/index.js`):

```js
this.#tableName = options.tableName ? escapePgIdentifier(options.tableName) : 'session'
// set()
'INSERT INTO ' + this.quotedTable() + ' (sess, expire, sid) SELECT $1, to_timestamp($2), $3
   ON CONFLICT (sid) DO UPDATE SET sess=$1, expire=to_timestamp($2) RETURNING sid'
// get()
'SELECT sess FROM ' + this.quotedTable() + ' WHERE sid = $1 AND expire >= to_timestamp($2)'
```

Run against a table built to `lib/db/src/schema/auth.ts`'s exact shape:

```
connect-pg-simple set() against jsonb column  => [{"sid":"sid-abc"}]
connect-pg-simple get()                       => [{"sess":{"cookie":{…},"passport":{"user":"u1"}}}]
stored column type                            => [{"t":"jsonb"}]
```

`jsonb` works — `$1` is untyped in `SELECT $1`, so PostgreSQL infers it from the target column.
Default table name is `session` (singular), so `tableName: "sessions"` is required.

### A.5 — The `sessions.expire` timezone bug and its fix

With `expire timestamp` (as the schema declares it today), written under `Etc/GMT0`:

```
expire column type                                    => [{"data_type":"timestamp without time zone"}]
TimeZone=Pacific/Auckland: does get() still find it?   => [{"sess":{…}}]
...and 13h from now (should still be valid)            => []            ←  expired ~13 h early
TimeZone=UTC: get() at now+13h                         => [{"sess":{…}}] ←  still valid
```

With `expire timestamptz`:

```
tz=UTC:                  valid at now | valid at now+13h | expired at now+25h
tz=Pacific/Auckland:     valid at now | valid at now+13h | expired at now+25h
tz=America/Los_Angeles:  valid at now | valid at now+13h | expired at now+25h
```

### A.6 — express-session on Express 5

express 5.2.1 + express-session 1.19.0 + openid-client 6.8.4, real HTTP requests against a live
listener with `X-Forwarded-Proto: https` to emulate a TLS-terminating proxy:

```
=== openid-client v6 exported API ===
ClientSecretBasic, ClientSecretJwt, ClientSecretPost, Configuration, None, allowInsecureRequests,
authorizationCodeGrant, buildAuthorizationUrl, buildAuthorizationUrlWithJAR,
buildAuthorizationUrlWithPAR, buildEndSessionUrl, calculatePKCECodeChallenge, customFetch,
discovery, fetchUserInfo, randomDPoPKeyPair, randomNonce, randomPKCECodeVerifier, randomState,
refreshTokenGrant, skipSubjectCheck
has Issuer (v5 class API)? false | has Client? false

[1] anonymous /me: { sid: '8QiBHi…', userId: null } | Set-Cookie: []        ← saveUninitialized:false
[2] /login: { before: 'B0VZnz…', after: 'VOH7kO…', regenerated: true }      ← fixation defence works
    Set-Cookie: __Host-qx.sid=s%3AVOH7kO…; Path=/; Expires=…; HttpOnly; Secure; SameSite=Lax
[3] /me with cookie: { sid: 'VOH7kO…', userId: 'u-123' }
    rolling re-set:  __Host-qx.sid=…                                        ← rolling:true works
[4] /logout: { ok: true } | Set-Cookie: __Host-qx.sid=; Expires=Thu, 01 Jan 1970 …
[5] /me with the dead cookie: { sid: 'eYrNu-…', userId: null }
[6] secure:true WITHOUT X-Forwarded-Proto (plain http):
    Set-Cookie: []                                        ← NO cookie emitted at all
```

### A.7 — Provider discovery documents

```
$ curl -s -o /dev/null -w "%{http_code}\n" https://github.com/.well-known/openid-configuration
404
$ curl -s https://token.actions.githubusercontent.com/.well-known/openid-configuration
{"issuer":"https://token.actions.githubusercontent.com", …,
 "response_types_supported":["id_token"], …}          ← no authorization/token endpoint

$ curl -s https://accounts.google.com/.well-known/openid-configuration
 issuer: https://accounts.google.com
 code_challenge_methods_supported: ["plain","S256"]
 claims_supported: [aud, email, email_verified, exp, family_name, given_name, iat, iss, name, picture, sub]

$ curl -s https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration
 issuer: "https://login.microsoftonline.com/{tenantid}/v2.0"        ← templated; validate tid yourself
 id_token_signing_alg_values_supported: ["RS256"]
$ curl -s -o /dev/null -w "%{http_code}\n" https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration
200

$ curl -s https://replit.com/oidc/.well-known/openid-configuration
 issuer: https://replit.com/oidc
 claims_supported: ["sub","username","first_name","last_name","profile_image_url",
                    "email","email_verified","sid","auth_time","iss"]
 code_challenge_methods_supported: ["S256"]
 grant_types_supported: ["authorization_code","refresh_token"]
 end_session_endpoint: https://replit.com/oidc/session/end
```

### A.8 — Package versions

```
$ node -p "require('drizzle-orm/package.json').version"   → 0.45.2      (installed)
$ node -p "require('drizzle-kit/package.json').version"   → 0.31.9      (installed)
$ grep express pnpm-lock.yaml                            → express@5.2.1 (installed)
$ curl -s registry.npmjs.org/openid-client/latest        → 6.8.4
$ curl -s registry.npmjs.org/connect-pg-simple/latest    → 10.0.0  (deps: pg ^8.12.0)
$ curl -s registry.npmjs.org/express-session/latest      → 1.19.0
$ curl -s registry.npmjs.org/passport/latest             → 0.7.0
$ curl -s registry.npmjs.org/helmet/latest               → 8.3.0
```

### A.9 — Repository facts referenced above

| Claim | Location |
|---|---|
| `users.id` is `varchar`, not `uuid` | `lib/db/src/schema/auth.ts:15` |
| `sessions.expire` lacks a timezone | `lib/db/src/schema/auth.ts:9` |
| `assets.organization_id` is `integer NOT NULL`, no FK | `lib/db/src/schema/assets.ts:24`, comment at `:11-14` |
| `collection_runs.organization_id` likewise | `lib/db/src/schema/collection_runs.ts:22` |
| Every existing asset is org 1 | `artifacts/api-server/src/lib/asset-ingest.ts:23` (`DEFAULT_ORGANIZATION_ID = 1`) |
| `shared_reports.owner` is the **GitHub** owner | `artifacts/api-server/src/routes/reports.ts:18` |
| `scans.code` written unconditionally | `artifacts/api-server/src/routes/scans.ts:26-44` |
| `/api/stats` selects five whole tables | `artifacts/api-server/src/routes/stats.ts:8-14` |
| Weak GitHub host check | `artifacts/api-server/src/routes/github.ts:61-69` |
| `Authorization` forwarded into redirect-following `fetch` | `artifacts/api-server/src/routes/github.ts:216-220`, `102-136` |
| Project delete reconciles assets by `project:<id>:` prefix | `artifacts/api-server/src/routes/projects.ts:77-89` |
| API client sends no `credentials` | `lib/api-client-react/src/custom-fetch.ts:363` |
| Homepage calls the protected `/api/stats` | `artifacts/quantaxscan/src/pages/Home.tsx:2,134` |
| `chat.ts` persists nothing | `artifacts/api-server/src/routes/chat.ts` — no `conversations`/`messages` write |
| No allowlist test exists | `artifacts/api-server/src/**/*.test.ts` → `scanner.test.ts`, `asset-ingest.test.ts` only |
| "Do not scan private or proprietary code" | `README.md:316` |

---

# Appendix B — Citations

All retrieved **2026-08-03**.

| Claim | Source |
|---|---|
| `openid-client` v6 is function-based; v5 `Issuer`/`Client` removed; Node 20 baseline | `https://github.com/panva/openid-client` README + runtime introspection of 6.8.4 |
| Replit Auth is OIDC at `https://replit.com/oidc`; claim set; PKCE S256 only | `https://replit.com/oidc/.well-known/openid-configuration` |
| Google: `sub` is the identifier; "*Don't use the email field as a unique identifier for a user. Always use the `sub` field*"; email "*may not be unique … could change over time*"; use `hd`, not the email domain, for Workspace | `https://developers.google.com/identity/openid-connect/openid-connect` |
| Google discovery: `email_verified` claim, `code_challenge_methods_supported` | `https://accounts.google.com/.well-known/openid-configuration` |
| Microsoft: `email` "*isn't guaranteed to be correct and is mutable over time. Never use it for authorization or to save data for a user*"; "*Your application mustn't use human-readable data to identify a user*"; `oid` immutable and shared across apps; `sub` pairwise per app; use the `iss` GUID to restrict tenants | `https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference` |
| Microsoft discovery returns a templated `{tenantid}` issuer; `organizations` authority exists | `https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration`, `…/organizations/v2.0/…` |
| GitHub has no OIDC discovery for user sign-in | `https://github.com/.well-known/openid-configuration` → 404; `https://token.actions.githubusercontent.com/.well-known/openid-configuration` advertises `response_types_supported: ["id_token"]` only |
| GitHub OAuth: authorize/token endpoints; `state` "*An unguessable random string … to protect against cross-site request forgery attacks*"; `code_challenge_method` "*Must be `S256` - the `plain` code challenge method is not supported*" | `https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps` |
| `GET /user/emails` returns `email`, `primary`, `verified`, `visibility`; "*need the `user:email` scope*" | `https://docs.github.com/en/rest/users/emails` |
| GitHub Apps: per-repository selection; short-lived tokens; fine-grained read-only Contents vs OAuth's `repo`; "*In general, GitHub Apps are preferred over OAuth apps*" | `https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app` |
| `express-session`: `secure` needs `trust proxy`; `secret` array rotation ("*Only the first element will be used to sign … all elements will be considered when verifying*"); `regenerate()` for session fixation; `sameSite: 'auto'` sets `None` on secure connections | `https://github.com/expressjs/session` README |
| `connect-pg-simple` table shape (`sid varchar`, `sess json`, `expire timestamp(6)`, `IDX_session_expire`), default table `session`, `createTableIfMissing` defaults to `false` | `https://github.com/voxpelli/node-connect-pg-simple` README + `table.sql` + `index.js` at 10.0.0 |
| Tenant isolation must be enforced at the query layer, in a single choke point, with an automated cross-tenant suite | `docs/Claude/08-security.md:216-220` |
| Share-link requirements: authenticated by default, opt-in public, mandatory expiry, revocable, access-logged, CSPRNG IDs, never indexed | `docs/Claude/08-security.md:227-231` |

---

## One-line conclusion

Specification complete and implementable as written; the three findings that would have silently
broken it — `drizzle-kit push` installing RLS policies with no `USING` clause, pglite's `BYPASSRLS`
superuser making cross-tenant tests pass vacuously, and a nested org scope leaving its parent
re-scoped to the wrong tenant — are all reproduced above with the countermeasures specified.
