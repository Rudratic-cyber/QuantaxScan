# QuantaXscan Feature-Level Test Suite & CI

This document describes the feature-level test suite, UI journey suite, and continuous integration pipeline for QuantaXscan.

---

## 1. Overview

The test architecture bridges the gap between unit-level pattern matching and end-to-end user journeys. It guarantees that API routes, authentication controls, database queries, and frontend user paths work reliably on every change.

| Suite | Runner / Tool | Target / Location | Environment |
|---|---|---|---|
| **Library Unit Suites** | Vitest | `lib/collectors`, `lib/db` | Node + in-memory `@electric-sql/pglite` Postgres |
| **API Feature Suite** | Vitest + Supertest | `artifacts/api-server/src/api-feature.test.ts` | In-memory `@electric-sql/pglite` Postgres + Express `app` |
| **UI Journey Suite** | Playwright | `tests/ui/ui-journey.spec.ts` | Headless Chromium + Vite dev server (`http://localhost:5833`) |
| **Continuous Integration** | GitHub Actions | `.github/workflows/ci.yml` | Ubuntu runner (`ubuntu-latest`) |

The UI suite always starts its own Vite dev server (`reuseExistingServer: false`) so it can never
silently pass against an unrelated process. `vite.config.ts` sets `strictPort: true`, so a busy
port fails loudly at startup — set `UI_TEST_PORT` to pick a free one when other worktrees are
running local verification on the same host.

---

## 2. API Feature Test Suite

The API feature suite exercises the Express API server endpoints against a real in-memory Postgres database.

### Database Strategy
Rather than mocking database queries or running against a shared Postgres container, the test suite uses `createTestDb()` (`lib/db/src/test-support/test-db.ts`). This boots `@electric-sql/pglite` (an embedded, in-process Postgres engine) and applies the authoritative Drizzle migrations from `lib/db/drizzle/`. This ensures `CHECK` constraints, foreign keys, and unique indexes are exercised as they would be in production.

### Coverage Summary
1. **Health Check**:
   - `GET /api/healthz` -> returns status 200 with `{ status: "ok" }`.
2. **Authentication Boundary (Security Control)**:
   - Every route in the public allowlist is reachable without an API key. `PUBLIC_ROUTES` in `artifacts/api-server/src/lib/auth.ts` owns that list; the test restates it as a literal array, so a route added to the allowlist must be added to the test by hand.
   - Protected routes (`/api/projects`, `/api/scans`, `/api/scans/multi`, `/api/community/posts` write/vote, `/api/reports` create) return 401 Unauthorized when unauthenticated or presenting an invalid key.
   - Valid `X-API-Key` or `Authorization: Bearer <key>` headers allow access to protected endpoints.
3. **Demo Repositories & Demo Scan**:
   - `GET /api/demo/repos` lists hardcoded repositories.
   - `POST /api/demo/repos/:slug/scan` runs scan and returns findings, risk score, executive summary, and derived NIST replacements (e.g. RSA -> ML-KEM).
4. **Project Lifecycle**:
   - `POST /api/projects`: Creates project and runs initial scan on submitted code.
   - `GET /api/projects`: Lists projects.
   - `GET /api/projects/:id`: Fetches project by ID.
   - `GET /api/projects/:id/findings`: Fetches aggregated findings across scans.
   - `DELETE /api/projects/:id`: Deletes project and cascades asset cleanup.
5. **Scans (Single-File & Multi-File)**:
   - `POST /api/scans`: Single-file scan on vulnerable code (MD5, RSA) verifying specific detected algorithms and NIST replacement mappings (`SHA-256 or SHA3-256`, `ML-KEM or ML-DSA`).
   - `GET /api/scans/:id` and `GET /api/scans/:id/findings`: Scan detail and finding list.
   - `POST /api/scans/multi`: Multi-file scan across multiple repository files returning file-level breakdown.
6. **Community Posts & Leaderboard**:
   - `POST /api/community/posts` (creates post with enum types `question`/`article`/`migration-story`), `GET /api/community/posts`, `POST /api/community/posts/:id/vote`, `GET /api/community/leaderboard`.
7. **Reports & Public Share Links**:
   - `POST /api/reports` (creates report with cryptographically random ID) and `GET /api/reports/:id` (public unauthenticated retrieval by share ID).

---

## 3. UI Journey Test Suite

Playwright was selected as the UI testing framework for its cross-browser execution capabilities, robust network route intercepting (`page.route`), hermetic browser context isolation, and integrated dev server orchestration (`webServer`).

### Tool Choice Rationale
Playwright provides built-in dev server lifecycle management, fast headless Chromium execution, network mocking, and resilient locator assertions without requiring flaky sleeps or external driver binaries.

### Coverage Summary
1. **Home Page**: Dismisses the intro screen overlay, then asserts the hero heading ("Know where your cryptography is.") and its supporting copy.
2. **Navigation**: Verifies navigation reaches every primary route (`/`, `/scan`, `/dashboard`, `/community`, `/coverage`, `/security`). Each assertion targets copy owned by the page itself, never the persistent `Navbar` — the navbar renders "Scanner", "Coverage", "Dashboard", "Security" and "Community" on every route including the `NotFound` fallback, so navbar text would pass even for a deleted route.
3. **Demo Scan**: Navigates to `/demo/paramiko-ssh` and waits on the mocked scan's executive summary — the file tree, code viewer and findings panel only mount once the scan resolves. It then asserts scan-derived values: the header metrics (`2 critical`, `12h to migrate`), and the finding's algorithm (`RSA-2048`), source line (`L36`), code snippet, NIST replacement (`ML-KEM-768`) and standard (`NIST FIPS 203`).
4. **Dashboard 401 Degradation**: Mocks 401 Unauthorized API responses for `/api/projects` and `/api/stats`, then asserts the Dashboard's own heading plus its empty-state copy ("No scans yet — run your first scan") — proving the failed queries fell through to the no-data path rather than a crash or a stuck spinner. A `pageerror` listener registered before navigation asserts no unhandled exception was raised.
5. **Report Page**:
   - Renders real report details (`/report/real-report-1`) with owner, repo name, risk score gauge, and expandable finding card displaying NIST replacements (`ML-KEM-768`).
   - Handles unknown report identifiers (`/report/unknown-id-999`) by displaying a clear "Report not found" error state rather than crashing.

---

## 4. Continuous Integration Pipeline

The CI workflow is defined in `.github/workflows/ci.yml`.

### Key Workflow Characteristics
- **Triggers**: Runs on every `pull_request` regardless of base branch, and on every `push` to `main`.
- **Hermetic Build Environment**: Runs on `ubuntu-latest`, installing Node.js 20, pnpm v10, and Playwright Chromium dependencies (`npx playwright install --with-deps chromium`).
- **Typecheck Baseline Handling**:
  - `pnpm run typecheck` is run explicitly with `continue-on-error: true`.
  - *Rationale*: `main` carries a pre-existing typecheck baseline (owned by AGENTS.md § "`pnpm run typecheck` pre-existing failures" — check the counts there, not here). Running typecheck as a non-blocking step prints all type errors into the CI log for visibility without failing pull requests on pre-existing issues.
- **Build**: Executes `pnpm -r --if-present run build` (bypassing the typecheck script gate).
- **Test Suites Execution**: Runs `pnpm run test:libs`, `pnpm run test:api` and `pnpm run test:ui` as three separately named steps, so a failure is attributable to a suite from the step name alone.
- **Failure Diagnostics**: On failure, `playwright-report/` and `test-results/` (which hold the HTML report and the `on-first-retry` traces) are uploaded via `actions/upload-artifact@v4`.

---

## 5. Running Tests Locally

The `test` / `test:libs` / `test:api` / `test:ui` scripts are listed in the root README's
Commands table. Only the UI suite needs setup beyond `pnpm install`:

```bash
# One-time: the UI suite needs a browser binary
npx playwright install chromium

# Run the UI journeys on a free port (other worktrees may already hold 5833)
UI_TEST_PORT=5901 pnpm run test:ui
```

---

## 6. Untested Features & Future Coverage Gaps

The following product areas are deliberately excluded from automated test coverage in this suite and remain as documented gaps:

1. **OpenAI / LLM Integration (`/api/chat`)**:
   - AI remediation chat requires live OpenAI API keys (`OPENAI_API_KEY`).
2. **GitHub OAuth & Integration (`/api/github/*`)**:
   - Live GitHub repository fetching and scanning endpoints require active GitHub App / OAuth credentials.
3. **Production Database Driver Migrations**:
   - Tests run against `@electric-sql/pglite` (embedded Postgres). Live `drizzle-kit push` against a production Postgres host is tested during deployment.
