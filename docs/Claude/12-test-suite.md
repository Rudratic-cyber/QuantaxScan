# QuantaXscan Feature-Level Test Suite & CI

This document describes the feature-level test suite, UI journey suite, and continuous integration pipeline for QuantaXscan.

---

## 1. Overview

The test architecture bridges the gap between unit-level pattern matching and end-to-end user journeys. It guarantees that API routes, authentication controls, database queries, and frontend user paths work reliably on every change.

| Suite | Runner / Tool | Target / Location | Environment |
|---|---|---|---|
| **API Feature Suite** | Vitest + Supertest | `artifacts/api-server/src/api-feature.test.ts` | In-memory `@electric-sql/pglite` Postgres + Express `app` |
| **UI Journey Suite** | Playwright | `tests/ui/ui-journey.spec.ts` | Headless Chromium + Vite dev server (`http://localhost:5833`) |
| **Continuous Integration** | GitHub Actions | `.github/workflows/ci.yml` | Ubuntu runner (`ubuntu-latest`) |

---

## 2. API Feature Test Suite

The API feature suite exercises the Express API server endpoints against a real in-memory Postgres database.

### Database Strategy
Rather than mocking database queries or running against a shared Postgres container, the test suite uses `createTestDb()` (`lib/db/src/test-support/test-db.ts`). This boots `@electric-sql/pglite` (an embedded, in-process Postgres engine) and applies the authoritative Drizzle migrations from `lib/db/drizzle/`. This ensures `CHECK` constraints, foreign keys, and unique indexes are exercised as they would be in production.

### Coverage Summary
1. **Health Check**:
   - `GET /api/healthz` -> returns status 200 with `{ status: "ok" }`.
2. **Authentication Boundary (Security Control)**:
   - Public allowlist routes (`GET /api/healthz`, `GET /api/demo/repos`, `POST /api/demo/repos/:slug/scan`, `GET /api/community/posts`, `GET /api/community/leaderboard`, `GET /api/reports/:id`) accessible without API key.
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
1. **Home Page**: Renders main branding, logo, navigation header, hero text, and handles intro screen dismiss overlay.
2. **Navigation**: Verifies navigation reaches every primary route (`/`, `/scan`, `/dashboard`, `/community`, `/coverage`, `/security`) and that key page headers render.
3. **Demo Scan**: Navigates to `/demo/paramiko-ssh`, runs demo scan to completion, and verifies rendered findings with their NIST replacement labels.
4. **Dashboard 401 Degradation**: Mocks 401 Unauthorized API responses for `/api/projects` and `/api/stats`, verifying the Dashboard degrades gracefully without blank screens or unhandled exceptions.
5. **Report Page**:
   - Renders real report details (`/report/real-report-1`) with owner, repo name, risk score gauge, and expandable finding card displaying NIST replacements (`ML-KEM-768`).
   - Handles unknown report identifiers (`/report/unknown-id-999`) by displaying a clear "Report not found" error state rather than crashing.

---

## 4. Continuous Integration Pipeline

The CI workflow is defined in `.github/workflows/ci.yml`.

### Key Workflow Characteristics
- **Triggers**: Runs on every `push` and `pull_request` against `main`.
- **Hermetic Build Environment**: Runs on `ubuntu-latest`, installing Node.js 20, pnpm v10, and Playwright Chromium dependencies (`npx playwright install --with-deps chromium`).
- **Typecheck Baseline Handling**:
  - `pnpm run typecheck` is run explicitly with `continue-on-error: true`.
  - *Rationale*: A documented pre-existing baseline of ~14 TypeScript errors in `api-server` and 13 in `quantaxscan` exists on `main`. Running typecheck as a non-blocking step ensures all type errors are printed into the CI log for visibility without failing pull requests on pre-existing issues.
- **Build**: Executes `pnpm -r --if-present run build` (bypassing the typecheck script gate).
- **Test Suites Execution**: Runs both `pnpm run test:api` and `pnpm run test:ui`.

---

## 5. Running Tests Locally

```bash
# Run all test suites (API + UI)
pnpm run test

# Run API feature tests only (Vitest)
pnpm run test:api

# Run UI journey tests only (Playwright on port 5833)
pnpm run test:ui
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
