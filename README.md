# QuantaXscan

**Post-quantum cryptography vulnerability scanner.** Scans code for cryptography that quantum
computers will break, and maps every finding to its NIST-approved post-quantum replacement.

🔗 **Live scanner — [quantaxscan.swotpam.com](https://quantaxscan.swotpam.com/)**

| | |
|---|---|
| **Scan a repo** | [quantaxscan.swotpam.com/scan](https://quantaxscan.swotpam.com/scan) |
| **Dashboard** | [quantaxscan.swotpam.com/dashboard](https://quantaxscan.swotpam.com/dashboard) |
| **Community** | [quantaxscan.swotpam.com/community](https://quantaxscan.swotpam.com/community) |
| **API health** | [quantaxscan.swotpam.com/api/healthz](https://quantaxscan.swotpam.com/api/healthz) |

No account required.

---

## What it does

Public-key cryptography — RSA, ECDSA, ECDH, DSA — is broken by Shor's algorithm on a
sufficiently large quantum computer. NIST published replacement standards in August 2024
(FIPS 203/204/205) and, in draft guidance, expects the classical algorithms to be **deprecated
after 2030 and disallowed after 2035**.

The immediate problem for most organisations is not the cryptography. It is that nobody can say
where their cryptography currently *is*. QuantaXscan finds it and tells you what to replace it
with.

### Detection

| Algorithm | Severity | NIST replacement | Standard |
|---|---|---|---|
| RSA | critical | ML-KEM-768 (Kyber) | FIPS 203 |
| ECDSA | critical | ML-DSA (Dilithium) | FIPS 204 |
| ECDH / DH | critical | ML-KEM-768 (Kyber) | FIPS 203 |
| DSA | critical | SLH-DSA (SPHINCS+) | FIPS 205 |
| MD5 | alert | SHA-256 / SHA-3 | classical hygiene |
| SHA-1 | alert | SHA-256 / SHA-3 | classical hygiene |
| AES-ECB | alert | AES-GCM / AES-CBC | classical hygiene |

Each finding carries a line reference, a code snippet, a migration effort estimate in hours, and
a plain-English explanation. Effort estimates roll up into a risk score (0–100) and a projected
migration cost.

> **The last three are not quantum vulnerabilities.** MD5, SHA-1 and AES-ECB are classical
> weaknesses, reported for hygiene. They currently count toward the same risk score as RSA, which
> inflates it — tracked as [G-10](docs/Claude/09-open-gaps.md).

### Features

- **IDE-style scanner** — file tree, colour-coded source, live agent console
- **Three input modes** — paste code, upload a `.zip`, or point it at a GitHub URL
- **Demo repos** — `paramiko/paramiko`, `node-vault/crypto-api`, `go-microservice/tls-server`,
  pre-loaded with real vulnerability patterns
- **Dashboard** — risk gauge, severity split, algorithm breakdown, effort-per-file
- **Community hub** — posts, voting, contributor leaderboard
- **AI assistant** — QuantaXscan AI, streamed over SSE (requires an OpenAI key; degrades gracefully)
- **Shareable reports** — public link per scan

---

## Using the hosted scanner

1. Open **[quantaxscan.swotpam.com/scan](https://quantaxscan.swotpam.com/scan)**
2. Choose an input:
   - **Upload Code** — drag a source file or a `.zip` archive
   - **GitHub URL** — paste a public repository URL
   - **Demo** — pick a pre-loaded repo for an instant result
3. Press **Run Scan**
4. Results land in the Problems panel; the Dashboard aggregates them per project

**Scannable file types:**
`.py` `.js` `.ts` `.tsx` `.jsx` `.java` `.go` `.rb` `.php` `.rs` `.kt` `.swift` `.cs` `.cpp`
`.c` `.scala` `.sh`

GitHub scans are capped at **25 files**, 150 KB and 300 lines per file, with a 500-node tree
limit. Trees are cached 30 minutes and file contents 60 minutes. Without a `GITHUB_TOKEN` the
upstream rate limit is 60 requests/hour — check remaining budget at `/api/github/rate-limit`.

### Using the API directly

The API is served under `/api` on the same origin.

Most routes require an API key, sent as `Authorization: Bearer <key>` or `X-API-Key: <key>`.
Public routes — no key needed — are `GET /healthz`, `GET /demo/repos`,
`POST /demo/repos/:slug/scan`, `GET /community/posts`, `GET /community/leaderboard` and
`GET /reports/:id`; everything else returns `401`. Keys are configured server-side via
`QUANTAXSCAN_API_KEYS` and the server will not start without it. This is an interim control —
it grants all-or-nothing access with no per-user identity. See
[docs/Claude/08-security.md](docs/Claude/08-security.md) (S1).

```bash
BASE=https://quantaxscan.swotpam.com/api
KEY=your-api-key

# health (public)
curl $BASE/healthz

# platform stats + recent activity
curl -H "X-API-Key: $KEY" $BASE/stats

# create a project
curl -X POST $BASE/projects -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"name":"my-app","language":"python","code":"# placeholder"}'

# scan a file against that project (projectId from the response above)
curl -X POST $BASE/scans -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{
  "projectId": 1,
  "mode": "scan-only",
  "language": "python",
  "code": "from Crypto.PublicKey import RSA\nkey = RSA.generate(2048)\n"
}'
```

Returns a scan with `riskScore`, `criticalCount`, `alertCount`, `totalEffortHours`,
`estimatedCost`, an `executiveSummary`, and a `findings[]` array with `nistReplacement` and
`nistStandard` on each entry.

<details>
<summary><strong>Full endpoint list</strong></summary>

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/healthz` | Health check |
| `GET` | `/api/stats` | Global stats + activity feed |
| `GET` `POST` | `/api/projects` | List / create projects |
| `GET` `DELETE` | `/api/projects/:id` | Fetch / delete a project |
| `GET` | `/api/projects/:id/findings` | All findings across a project |
| `POST` | `/api/scans` | Scan a single file |
| `POST` | `/api/scans/multi` | Scan a whole project (ZIP) |
| `GET` | `/api/scans/:id` | Scan result |
| `GET` | `/api/scans/:id/findings` | Findings for a scan |
| `POST` | `/api/github/fetch` | Fetch a repo tree |
| `POST` | `/api/github/scan` | Scan a GitHub repo |
| `POST` | `/api/github/scan-files` | Scan selected files |
| `GET` | `/api/github/rate-limit` | GitHub API budget |
| `GET` | `/api/demo/repos` | List demo repos |
| `POST` | `/api/demo/repos/:slug/scan` | Scan a demo repo |
| `GET` `POST` | `/api/community/posts` | List / create posts |
| `POST` | `/api/community/posts/:id/vote` | Vote |
| `GET` | `/api/community/leaderboard` | Top contributors |
| `POST` | `/api/reports` | Create a shareable report |
| `GET` | `/api/reports/:id` | Fetch a shared report |
| `POST` | `/api/chat` | AI assistant (SSE stream) |

The OpenAPI spec in `lib/api-spec/openapi.yaml` covers a subset and has drifted — it declares
`/auth/user`, which does not exist, and omits `/reports`, `/chat`, `/scans/multi` and the
`/github/*` routes.
</details>

---

## Running it locally

**Requirements:** Node 24, pnpm 10, and PostgreSQL (Docker is easiest).

```bash
git clone https://github.com/Rudratic-cyber/QuantaxScan.git
cd QuantaXscan
pnpm install

# 1. database
docker run -d --name quantaxscan-pg \
  -e POSTGRES_PASSWORD=quantaxscan -e POSTGRES_DB=quantaxscan \
  -p 55432:5432 postgres:16

export DATABASE_URL='postgres://postgres:quantaxscan@localhost:55432/quantaxscan'
pnpm --filter @workspace/db run push --force

# 2. API  (terminal 1) — the server refuses to start without an API key
export QUANTAXSCAN_API_KEYS="$(openssl rand -base64 32)"
PORT=5055 DATABASE_URL=$DATABASE_URL CORS_ALLOWED_ORIGINS=http://localhost:5199 \
  pnpm --filter @workspace/api-server run dev

# 3. frontend  (terminal 2)
PORT=5199 VITE_API_BASE_URL=http://localhost:5055 pnpm --filter @workspace/quantaxscan run dev
```

Then open **http://localhost:5199** and check the API with
`curl http://localhost:5055/api/healthz`. The browser UI holds no API key, so pages backed by
protected routes return 401 until per-user auth (F1) lands — use `curl -H "X-API-Key: $QUANTAXSCAN_API_KEYS"`
to exercise those routes meanwhile.

> ⚠️ **`VITE_API_BASE_URL` is required.** There is no Vite dev proxy, and
> `artifacts/quantaxscan/public/config.js` ships `apiBaseUrl: ""`. Without it every `/api/*` call 404s
> against the dev server and the UI looks broken for no obvious reason.

Ports 5055/5199 are arbitrary — pick anything free. Both the API
(`artifacts/api-server/src/index.ts`) and Vite read `PORT`, so set it per-command rather than
exporting it.

### Docker

```bash
echo "API_BASE_URL=http://localhost:5000" > .env
export QUANTAXSCAN_API_KEYS="$(openssl rand -base64 32)"   # not in .env — it is tracked in git
docker compose up -d --build
```

Frontend on `:5173`, API on `:5000`. The frontend image is nginx serving a static build;
`docker/entrypoint.sh` writes `API_BASE_URL` into `config.js` at container start, so the same
image works against any backend. See [DOCKER.md](DOCKER.md).

### Commands

| Command | Does |
|---|---|
| `pnpm run typecheck` | Typecheck every package |
| `pnpm run test` | All three suites in order: `test:libs`, `test:api`, `test:ui` |
| `pnpm run test:libs` | Vitest unit suites in `lib/collectors` and `lib/db` |
| `pnpm run test:api` | Vitest + Supertest API feature suite against in-memory Postgres |
| `pnpm run test:ui` | Playwright UI journeys — starts its own Vite dev server on `UI_TEST_PORT` (default 5833) |
| `pnpm run build` | Typecheck, then build all packages |
| `pnpm --filter @workspace/api-spec run codegen` | Regenerate API client + Zod schemas from OpenAPI |
| `pnpm --filter @workspace/db run push` | Push schema changes (dev only) |

`preinstall` refuses npm and yarn — this is a pnpm workspace.

`test:ui` needs the Playwright browsers (`npx playwright install chromium`). What each suite
covers, and the GitHub Actions pipeline that runs them on every pull request, is documented in
[docs/Claude/12-test-suite.md](docs/Claude/12-test-suite.md).

---

## Repository layout

```
artifacts/
  quantaxscan/            React 19 + Vite 7 frontend (Tailwind 4, shadcn/ui, Framer Motion, Wouter, Recharts)
  api-server/        Express 5 API — 9 route modules, esbuild bundle
  mockup-sandbox/    shadcn component playground
lib/
  db/                Drizzle ORM + PostgreSQL — 13 tables
  collectors/        Collector contract, source regex + dependency/lockfile collectors, CPE 2.3, asset fingerprint
  api-spec/          OpenAPI spec, Orval codegen config
  api-client-react/  Generated React Query hooks
  api-zod/           Generated Zod validation schemas
  integrations/      OpenAI server + React wrappers
tests/ui/            Playwright UI journey specs
docs/Claude/         Product plan, architecture, compliance mapping, editions, gap register
docker/              nginx config + entrypoint
```

**Frontend pages:** Home, Scan, Coverage, Security, Demo, Dashboard, Community, CreatePost,
Report, NotFound.

**Database tables:** `projects`, `scans`, `findings`, `assets`, `observations`,
`collection_runs`, `community_posts`, `activity`, `shared_reports`, `conversations`, `messages`,
`users`, `sessions`.

`assets`, `observations` and `collection_runs` are the persistent inventory model. They are
written alongside `findings` on every scan, but nothing reads them yet — every API route still
reads `findings`. See [docs/Claude/03-features.md](docs/Claude/03-features.md) (A1/A2).

### Environment variables

| Variable | Used by | Required | Purpose |
|---|---|---|---|
| `DATABASE_URL` | API | **yes** | PostgreSQL connection. The process exits at import time without it |
| `PORT` | API, Vite | **yes** for API | API throws if unset; Vite defaults to 5173 |
| `QUANTAXSCAN_API_KEYS` | API | **yes** | Comma-separated API keys. The API refuses to start without it, so it can never serve an unauthenticated API. Keep it out of `.env` — that file is tracked in git |
| `QUANTAXSCAN_API_KEY_ORG_ID` | API | no | Legacy single binding: every configured key acts as this organisation. Defaults to `1`. Ignored when `QUANTAXSCAN_API_KEY_ORG_IDS` is set |
| `QUANTAXSCAN_API_KEY_ORG_IDS` | API | no | One organisation id per key in `QUANTAXSCAN_API_KEYS`, comma-separated, same order — the F1 multi-tenant binding. A length mismatch refuses to start rather than defaulting an unlisted key to organisation `1`. See `artifacts/api-server/src/lib/principal.ts` and `pnpm --filter @workspace/db run create-organization` |
| `CORS_ALLOWED_ORIGINS` | API | no | Comma-separated origins allowed to call the API cross-origin. Unset means same-origin only |
| `TRUST_PROXY` | API | **behind a proxy** | Number of proxies in front of the API (`1` for a single load balancer). Rate limiting keys public routes on `req.ip`; unset behind a proxy, every caller shares one bucket and the public demo path rate-limits the world together. A bare `true` is rejected at startup — it lets a client forge `X-Forwarded-For` |
| `RATE_LIMIT_*` | API | no | Per-window budgets; see `.env.example` and `artifacts/api-server/src/lib/rate-limit.ts`. The store is in-process, so each is per replica |
| `VITE_API_BASE_URL` | frontend | dev only | API origin — no dev proxy exists |
| `API_BASE_URL` | docker frontend | docker only | Injected into `config.js` at container start |
| `GITHUB_TOKEN` | API | no | Raises the GitHub rate limit above 60 req/hr |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | API | no | Enables the AI assistant |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | API | no | OpenAI-compatible endpoint |
| `AI_CHAT_MODEL` | API | no | Model override |
| `LOG_LEVEL` | API | no | pino level |
| `BASE_PATH` | frontend | no | Sub-path deployment |
| `NODE_ENV` | both | no | |

---

## Project status

**This is an early-stage project.** The scanner works and is deployed, but it covers **two of the
ten surfaces** a cryptographic inventory needs, and both of them reach your cryptography through
the repository. Connections (TLS, certificates, protocol config) and storage (data-at-rest, KMS)
have no collector at all — see [the coverage page](https://quantaxscan.swotpam.com/coverage),
which reports that honestly rather than implying completeness.

**Works today:** regex detection across 7 algorithm families over source; dependency detection
from lockfiles (pnpm/npm/yarn, `requirements.txt`) against a cited package table; single-file /
ZIP / GitHub scanning, NIST replacement mapping, risk and effort scoring, coverage and confidence
reporting, dashboard, community hub, shareable reports.

**Known limitations, honestly:**

- **Detection is regex over source, not AST.** Expect false positives — `\bDH\b` matches `DHCP`
  and people's initials in comments. Findings carry no confidence score yet.
- **Key size is only extracted when it is on the same line.** `RSA.generate(2048)` and named
  curves like `secp256r1` resolve; anything needing a variable or another line stays undetermined
  (never guessed), and the value is recorded on the new `assets`/`observations` tables, not on the
  findings the API returns. NIST's rules are keyed on security strength (112-bit vs ≥128-bit), so
  deadline mapping is still approximate. This remains the largest known gap.
- **Dependencies are read from lockfiles, and a lockfile is not first-party use.** Submit them to
  `POST /api/projects/:id/dependencies` and matched packages persist as `dependency` assets. Two
  limits worth stating before a customer sees a finding: a lockfile records the fully *resolved*
  graph, so a match may be a transitive dependency of the build toolchain rather than a library
  your own code calls (G-20 — the caveat ships on every response, the detection does not); and the
  package table applies one claim to every version of a package, though capabilities move under a
  version bump (G-21 — paramiko removed DSA in 4.0.0). Ecosystems: npm and PyPI
  (`requirements.txt` only — `poetry.lock` and `Pipfile.lock` are not read). No version-range or
  advisory reasoning.
- **Most cryptography still is not visible to any of this.** OpenSSL, BouncyCastle, your TLS
  termination, your KMS and your database's encryption-at-rest are where the real estate lives,
  and each needs a collector that does not exist yet (B3–B7).
- **One finding per line.** EdDSA (Ed25519/Ed448) is detected now and resolves its curve size,
  but a line naming two algorithms — an SSH key list with both `ssh-rsa` and `ssh-ed25519` — is
  reported as the first pattern that matches it, and the second algorithm is silently lost.
- **Authentication is a single shared API key**, not per-user accounts. Organisation scoping *is*
  built — every scoped table carries `organization_id` under a row-level-security policy, the
  runtime connects as a role without `BYPASSRLS`, and a cross-tenant suite proves it with a
  negative control. What is missing is the other half: no per-user identity, so no action can be
  attributed to a person, and **only one organisation can exist** — the shared key is bound to it.
  You cannot host two customers on one instance today. See below.
- Findings are per-scan, so there is no drift detection or remediation tracking yet.

The full plan for addressing these — and the open-gap register — is in
**[`docs/Claude/`](docs/Claude/)**. Start with [the index](docs/Claude/README.md), or
[09-open-gaps.md](docs/Claude/09-open-gaps.md) for what is broken and why.

---

## ⚠️ Security notice

**Authentication is a shared API key, and it is an interim control — not a finished design.**

Until 2026-08-02 every API route was open to the internet, and anyone could list, create and
delete projects and read every scan result on the hosted instance. `/api` is now default-deny:
requests need `Authorization: Bearer <key>` or `X-API-Key: <key>` unless the route is on the
public allowlist (`GET /healthz`, `GET /demo/repos`, `POST /demo/repos/:slug/scan`,
`GET /community/posts`, `GET /community/leaderboard`, `GET /reports/:id`). Shared report IDs are
now generated with `crypto.randomBytes`, and CORS uses an explicit origin allowlist.

What that does **not** give you:

- **No per-user identity.** One key grants access to everything the organisation it is bound to
  can see, and access cannot be attributed to a person in the logs. Organisation scoping and
  tenant isolation *are* enforced in the database (see
  [13-auth-and-tenancy.md](docs/Claude/13-auth-and-tenancy.md)), but there is no way to create a
  second organisation, so the isolation has nothing to isolate from yet.
- **No key rotation story**, and shared report links still have no expiry or revocation.
- **Submitted source is still stored in full** in the database (`scans.code`).

**Do not scan private or proprietary code on the hosted instance.** Run it locally for anything
you would not publish.

These are documented with fixes in [docs/Claude/08-security.md](docs/Claude/08-security.md)
(findings S1–S8). S1 is mitigated, not closed; S3, S6, S7 and S8 are open. All must be resolved
before any production or enterprise use.

---

## Roadmap

The direction is from *scanner* to **cryptographic inventory platform** — multi-surface
discovery (dependencies, TLS, certificates, key stores), persistent assets with drift detection,
CycloneDX CBOM export, and compliance evidence mapped to NIST and CISA guidance.

An **open-core split** is planned: an Apache-2.0 Community edition covering detection and
single-project scanning, standards data under CC BY 4.0, and a commercial Enterprise edition for
estate-wide, continuous and audit-facing use. See
[docs/Claude/10-editions.md](docs/Claude/10-editions.md).

---

## Naming

**QuantaXscan** is the product name. Settled 2026-08-02 — the earlier mix of *Q-Vuln*,
*Q-Bitron* and *QuantaxScan* has been consolidated.

| Context | Form |
|---|---|
| Prose, UI, titles | `QuantaXscan` |
| Uppercase UI, report headers | `QUANTAXSCAN` |
| Identifiers, packages, paths, CLI | `quantaxscan` |
| Domain | `quantaxscan.swotpam.com` |

The logo splits as **Quanta** + accented **Xscan**, preserving the original two-tone treatment.

**Two things still carry the old spelling** and need action outside this repo:

- **The GitHub repository is still `QuantaxScan`** (lowercase `x`, capital `S`). Renaming it to
  `QuantaXscan` is a repository setting; GitHub redirects old URLs, but the clone command in this
  README and any existing remotes point at the current name until it changes.
- **`.env`** contains `API_BASE_URL=https://q-bitron--edastro.replit.app/`, a stale pointer at the
  old Replit deployment. Left untouched deliberately — it is a live hostname, not a brand string,
  and renaming it would point at nothing. It should be updated or removed
  ([G-13](docs/Claude/09-open-gaps.md)).

> Note: **Q-Day** is a technical term, not branding, and is intentionally left as-is throughout.

---

## Standards referenced

- **FIPS 203 / 204 / 205** — ML-KEM, ML-DSA, SLH-DSA (final, August 2024)
- **NIST IR 8547** — transition timeline. *Initial public draft, November 2024 — not final.*
  Deprecation after 2030, disallowance after 2035, at **all** classical key sizes
- **NIST SP 1800-38** (NCCoE) — cryptographic discovery practice guide. *Volumes A/B/C are all
  preliminary drafts (A April 2023; B/C December 2023) — not final.*
- **CISA / NSA / NIST** — *Quantum-Readiness: Migration to Post-Quantum Cryptography*, August 2023

Versioned, citation-backed mapping data lives in
[docs/Claude/mappings/](docs/Claude/mappings/), with every claim tagged `verified` or
`needs-check`.

---

## Licence

`package.json` declares MIT, but **no LICENSE file exists** and the intended split is Apache-2.0
core plus a commercial Enterprise tier. Treat licensing as unresolved until this is fixed —
tracked as [G-18](docs/Claude/09-open-gaps.md).
