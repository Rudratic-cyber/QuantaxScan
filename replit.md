# QuantaXscan — Post-Quantum Security Scanner

## Overview

QuantaXscan is a web application that scans codebases for quantum-vulnerable cryptographic algorithms (RSA, ECDSA, ECDH, DSA, MD5, SHA-1, AES-ECB) and maps every finding to NIST-approved post-quantum replacements (ML-KEM, ML-DSA, SLH-DSA). It features a VS Code-style IDE scanner, risk analytics dashboard, and a community knowledge hub.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui + Framer Motion
- **Routing**: Wouter
- **Charts**: Recharts
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Architecture

```
artifacts/
  quantaxscan/       — React + Vite frontend (served at /)
  api-server/   — Express 5 API server (served at /api)
lib/
  api-spec/     — OpenAPI spec (openapi.yaml)
  api-client-react/ — Generated React Query hooks
  api-zod/      — Generated Zod validation schemas
  db/           — Drizzle ORM schema + client
```

## Design System (Clean Light Enterprise)

- **Primary**: Indigo `#4f46e5` (hover `#4338ca`), soft fill `#eef0fe`
- **Accent**: Teal `#0d9488` for a distinct secondary
- **Surfaces**: `#ffffff` page/cards → `#f7f8fa` alternating sections → `#f1f3f7` elevated
- **Text**: `#0a0e1a` ink → `#475569` secondary → `#6b7280` muted → `#9aa3b2` faint
- **Semantic**: critical `#dc2626`, alert `#d97706`, safe `#059669` (soft bgs `#fef2f2` / `#fffbeb` / `#ecfdf5`)
- **Borders**: hairline `#e5e7eb` (subtle dividers `#eceef2`)
- **Logo**: Hexagonal mark with circuit traces, Q letterform, and orbit ring in indigo/teal (QuantaXscanLogo.tsx)
- **Fonts**: Inter (sans, incl. 800 for display) + JetBrains Mono (reserved for code / terminal / tabular data)
- **Chrome**: white blurred navbar with hairline border; standardised Footer
- **Intro**: brief, fully-skippable product boot (Skip button + Esc + click-anywhere; plays once per session)
- **Animations**: Framer Motion — whileInView scroll reveals, subtle hover lift, animated counters
- **Cards**: `rounded-xl`/`rounded-2xl` with `border-[#e5e7eb]` and soft neutral shadows (`.card-lift`)
- **Marketing pages**: `/` Home (inventory-first), `/coverage` (honest surface grid), `/security` (trust posture)

## Key Features

1. **Quantum Vulnerability Scanner** — Paste any code, select language, run scan. Detects RSA, ECDSA, ECDH/DH, DSA, MD5, SHA-1, AES-ECB patterns with regex+pattern matching. Maps each finding to NIST PQC replacements (FIPS 203/204/205).
2. **IDE-Style Editor** — 3-panel layout: file tree, color-coded code view (red=critical, yellow=alert, green=safe), agent console with animated scanning cursor.
3. **Full-Project ZIP Scan** — Upload a ZIP archive; all code files are extracted, displayed in the file tree, and scanned as one project in a single `POST /api/scans/multi` call. Navigates to Dashboard on completion.
4. **Space-Themed Scan Overlay** — Full-screen animated overlay with stars, rotating rings, scanning beam, and per-file progress bar. Triggered for multi-file ZIP scans (upload mode) and GitHub URL scans (scanning phase).
5. **Demo Repos** — Pre-loaded Django, Node.js, and Go repos with real vulnerability patterns for instant demonstrations.
6. **Security Dashboard** — Project dropdown (sorted by last scan), per-project risk gauge (0-100), critical/alert/safe metric cards, algorithm breakdown chart from real DB findings, global stats footer.
7. **Community Hub** — "Q-Day Resistance" forum with posts, upvoting, type filters (article/question/migration-story), and a contributor leaderboard with badges (bronze → silver → gold → quantum-guardian).
8. **Q-Day Countdown** — Live clock counting down to estimated Q-Day (2027-01-01).

## API Routes

- `GET /api/stats` — Global platform statistics + recent activity feed
- `GET /api/projects` / `POST /api/projects` — Project management
- `GET /api/projects/:id` / `DELETE /api/projects/:id` — Individual project
- `GET /api/projects/:id/findings` — All findings across all scans for a project (dashboard chart)
- `POST /api/scans` — Run a scan on a single file
- `POST /api/scans/multi` — Full-project scan: accepts `{projectName, language, files[]}`, scans all files, aggregates stats, saves to DB
- `GET /api/scans/:id` / `GET /api/scans/:id/findings` — Scan results
- `GET /api/community/posts` / `POST /api/community/posts` — Community posts
- `POST /api/community/posts/:id/vote` — Vote on posts
- `GET /api/community/leaderboard` — Top contributors
- `GET /api/demo/repos` — List demo repositories
- `POST /api/demo/repos/:slug/scan` — Run scan on a demo repo

## Database Schema

- `projects` — user projects with risk scores
- `scans` — scan runs with results summary
- `findings` — individual vulnerability findings per scan
- `community_posts` — community knowledge base posts
- `activity` — global activity feed entries

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)

## Design System

Dark cyberpunk theme. Background: #0a0a0f / #111118 / #1a1a2e. Accent: #6c63ff (purple). Highlights: #00d2ff (cyan). Critical: #ff4d4d. Alert: #ffc107. Safe: #00e676. Fonts: Inter + JetBrains Mono.
