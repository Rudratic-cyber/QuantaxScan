# QuantaxScan

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
where their cryptography currently *is*. QuantaxScan finds it and tells you what to replace it
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
- **AI assistant** — Q-Bitron AI, streamed over SSE (requires an OpenAI key; degrades gracefully)
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

```bash
BASE=https://quantaxscan.swotpam.com/api

# health
curl $BASE/healthz

# platform stats + recent activity
curl $BASE/stats

# create a project
curl -X POST $BASE/projects -H 'Content-Type: application/json' \
  -d '{"name":"my-app","language":"python","code":"# placeholder"}'

# scan a file against that project (projectId from the response above)
curl -X POST $BASE/scans -H 'Content-Type: application/json' -d '{
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
cd QuantaxScan
pnpm install

# 1. database
docker run -d --name qvuln-pg \
  -e POSTGRES_PASSWORD=qvuln -e POSTGRES_DB=qvuln \
  -p 55432:5432 postgres:16

export DATABASE_URL='postgres://postgres:qvuln@localhost:55432/qvuln'
pnpm --filter @workspace/db run push --force

# 2. API  (terminal 1)
PORT=5055 DATABASE_URL=$DATABASE_URL pnpm --filter @workspace/api-server run dev

# 3. frontend  (terminal 2)
PORT=5199 VITE_API_BASE_URL=http://localhost:5055 pnpm --filter @workspace/q-vuln run dev
```

Then open **http://localhost:5199** and check the API with
`curl http://localhost:5055/api/healthz`.

> ⚠️ **`VITE_API_BASE_URL` is required.** There is no Vite dev proxy, and
> `artifacts/q-vuln/public/config.js` ships `apiBaseUrl: ""`. Without it every `/api/*` call 404s
> against the dev server and the UI looks broken for no obvious reason.

Ports 5055/5199 are arbitrary — pick anything free. Both the API
(`artifacts/api-server/src/index.ts`) and Vite read `PORT`, so set it per-command rather than
exporting it.

### Docker

```bash
echo "API_BASE_URL=http://localhost:5000" > .env
docker compose up -d --build
```

Frontend on `:5173`, API on `:5000`. The frontend image is nginx serving a static build;
`docker/entrypoint.sh` writes `API_BASE_URL` into `config.js` at container start, so the same
image works against any backend. See [DOCKER.md](DOCKER.md).

### Commands

| Command | Does |
|---|---|
| `pnpm run typecheck` | Typecheck every package |
| `pnpm run build` | Typecheck, then build all packages |
| `pnpm --filter @workspace/api-spec run codegen` | Regenerate API client + Zod schemas from OpenAPI |
| `pnpm --filter @workspace/db run push` | Push schema changes (dev only) |

`preinstall` refuses npm and yarn — this is a pnpm workspace.

---

## Repository layout

```
artifacts/
  q-vuln/            React 19 + Vite 7 frontend (Tailwind 4, shadcn/ui, Framer Motion, Wouter, Recharts)
  api-server/        Express 5 API — 9 route modules, esbuild bundle
  mockup-sandbox/    shadcn component playground
lib/
  db/                Drizzle ORM + PostgreSQL — 10 tables
  api-spec/          OpenAPI spec, Orval codegen config
  api-client-react/  Generated React Query hooks
  api-zod/           Generated Zod validation schemas
  integrations/      OpenAI server + React wrappers
docs/Claude/         Product plan, architecture, compliance mapping, editions, gap register
docker/              nginx config + entrypoint
```

**Frontend pages:** Home, Scan, Demo, Dashboard, Community, CreatePost, Report, NotFound.

**Database tables:** `projects`, `scans`, `findings`, `community_posts`, `activity`,
`shared_reports`, `conversations`, `messages`, `users`, `sessions`.

### Environment variables

| Variable | Used by | Required | Purpose |
|---|---|---|---|
| `DATABASE_URL` | API | **yes** | PostgreSQL connection. The process exits at import time without it |
| `PORT` | API, Vite | **yes** for API | API throws if unset; Vite defaults to 5173 |
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

**This is an early-stage project.** The scanner works and is deployed, but it covers one surface
of many.

**Works today:** regex detection across 7 algorithm families, single-file / ZIP / GitHub
scanning, NIST replacement mapping, risk and effort scoring, dashboard, community hub, shareable
reports.

**Known limitations, honestly:**

- **Detection is regex over source, not AST.** Expect false positives — `\bDH\b` matches `DHCP`
  and people's initials in comments. Findings carry no confidence score yet.
- **Key size is never extracted.** NIST's rules are keyed on security strength (112-bit vs
  ≥128-bit), so deadline mapping is currently approximate. This is the largest known gap.
- **Dependencies are invisible.** Most real cryptography lives in OpenSSL, BouncyCastle and your
  TLS stack — not application source. A source scanner cannot see it.
- **EdDSA (Ed25519) is not detected**, despite being quantum-vulnerable and in active use.
- **No authentication.** See below.
- Findings are per-scan, so there is no drift detection or remediation tracking yet.

The full plan for addressing these — and a 19-item gap register — is in
**[`docs/Claude/`](docs/Claude/)**. Start with [the index](docs/Claude/README.md), or
[09-open-gaps.md](docs/Claude/09-open-gaps.md) for what is broken and why.

---

## ⚠️ Security notice

**The hosted instance has no authentication.** Every API route is open to the internet. Verified
on the live deployment:

```
$ curl https://quantaxscan.swotpam.com/api/projects
[{"id":1,"name":"Kodela-website-sam", ...}]     # all projects, no auth
```

Anyone can list, create and delete projects and read every scan result. Shared report links use
IDs from `Math.random()`, which is not a CSPRNG — the sequence is predictable from a few
observed outputs, and `GET /api/reports/:id` has no auth, expiry or revocation.

**Do not scan private or proprietary code on the hosted instance.** Submitted source is stored
in full in the database (`scans.code`), and project names are publicly listable. Run it locally
for anything you would not publish.

These are documented with fixes in [docs/Claude/08-security.md](docs/Claude/08-security.md)
(findings S1–S8). They are appropriate for a public demo and must be resolved before any
production or enterprise use.

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

The project appears under several names and this is **not yet settled**:

| Name | Where |
|---|---|
| **QuantaxScan** | repository, domain (`quantaxscan.swotpam.com`) |
| **qbitron** | README title on `main` as of 2026-08-01 |
| Q-BITRON | UI branding, logo (`QBitronLogo.tsx`) |
| Q-Vuln | `replit.md`, package names (`@workspace/q-vuln`) |

This document uses **QuantaxScan** because that is the repository name and the domain users will
type. If the intended product name is **Q-Bitron**, the repo and domain should move too —
picking one and renaming everything else is a half-day of work that gets cheaper the sooner it
happens.

---

## Standards referenced

- **FIPS 203 / 204 / 205** — ML-KEM, ML-DSA, SLH-DSA (final, August 2024)
- **NIST IR 8547** — transition timeline. *Initial public draft, November 2024 — not final.*
  Deprecation after 2030, disallowance after 2035, at **all** classical key sizes
- **NIST SP 1800-38** (NCCoE) — cryptographic discovery practice guide
- **CISA / NSA / NIST** — *Quantum-Readiness: Migration to Post-Quantum Cryptography*, August 2023

Versioned, citation-backed mapping data lives in
[docs/Claude/mappings/](docs/Claude/mappings/), with every claim tagged `verified` or
`needs-check`.

---

## Licence

`package.json` declares MIT, but **no LICENSE file exists** and the intended split is Apache-2.0
core plus a commercial Enterprise tier. Treat licensing as unresolved until this is fixed —
tracked as [G-18](docs/Claude/09-open-gaps.md).
