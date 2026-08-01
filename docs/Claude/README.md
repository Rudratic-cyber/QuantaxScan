# Q-Vuln — Enterprise Post-Quantum Readiness

**Working docs for the expansion from "code scanner" to "cryptographic inventory platform."**

Owner: Rudratic-cyber · Started: 2026-08-01 · Status: planning

---

## The one-paragraph version

Q-Vuln today scans source code for quantum-vulnerable algorithms and maps them to NIST PQC
replacements. That is one collector against one surface, and it sees a small fraction of an
enterprise's real cryptographic exposure. This plan turns it into a **cryptographic asset
inventory platform** sold to a CISO who needs a defensible, continuously-updated answer to
"where is all our crypto, how bad is it, and can I prove I have a plan?"

The organizing principle is **Mosca's inequality** — `X + Y > Z` — and we already have two of
its three variables in the codebase. See [01-strategy.md](01-strategy.md).

---

## Index

### Product

| # | Document | What it answers |
|---|---|---|
| 01 | [Strategy](01-strategy.md) | Who buys this, why inventory-first, what we are and aren't |
| 02 | [Roadmap](02-roadmap.md) | Phases, parallel tracks, **what to build first** |
| 03 | [Feature catalog](03-features.md) | Every feature, priority, dependencies, acceptance criteria |
| 04 | [Architecture](04-architecture.md) | Asset/observation model, collector interface, migration from today's schema |

### Compliance & output

| # | Document | What it answers |
|---|---|---|
| 05 | [Compliance mapping](05-compliance-mapping.md) | The dynamic findings → NIST/CNSA/CISA mapping engine |
| 06 | [CISA dashboard](06-cisa-dashboard.md) | The quantum-readiness dashboard spec |
| 07 | [Reports](07-reports.md) | Board pack, regulator submission, CBOM, technical remediation |
| 08 | [Security](08-security.md) | Best practices for a platform that ingests customer source code |

### Data

| Path | What it is |
|---|---|
| [mappings/](mappings/) | Versioned, machine-readable standards data — the thing that makes mapping *dynamic* |

### Marketing

| Path | What it is |
|---|---|
| [marketing/](marketing/) | Positioning, voice, calendar, per-channel playbooks, and the agent runbook |

---

## Reading order

**If you have 10 minutes:** [01-strategy.md](01-strategy.md) then the "Start here" section of
[02-roadmap.md](02-roadmap.md).

**If you're about to write code:** [04-architecture.md](04-architecture.md) first — the
`findingsTable` → asset/observation migration is the decision everything else depends on, and
doing it late is far more expensive than doing it now.

**If you're about to talk to a design partner:** [06-cisa-dashboard.md](06-cisa-dashboard.md)
and [07-reports.md](07-reports.md) — those are the artifacts the buyer actually evaluates.

---

## Document conventions

- **Status tags** on every feature: `built` · `next` · `planned` · `deferred` · `won't`
- **Confidence tags** on every regulatory claim: `verified` · `needs-check`
  Standards timelines move. Anything tagged `needs-check` must be confirmed against the primary
  source before it appears in a customer-facing report. See
  [05-compliance-mapping.md § Provenance](05-compliance-mapping.md#provenance-and-freshness).

### Standards verification — done 2026-08-01

The NIST, CISA and CycloneDX claims in [`mappings/`](mappings/) have been **verified against
primary sources**. Three seed claims turned out to be wrong:

| Was | Actually |
|---|---|
| "FIPS 206 (Falcon), draft/pending" | **No such published standard.** Falcon is still in standardization |
| "CycloneDX 1.6 is current" | **1.7**, released 2025-10-21 |
| "CISA prescribes a five-stage roadmap" | **No numbered stages** — the factsheet uses named sections |

Plus one substantive gap: **≥128-bit classical algorithms are disallowed after 2035 too**, not
just 112-bit ones. Bigger RSA keys do not buy time.

Still `needs-check`: CNSA 2.0 per-category dates and OMB M-23-02 format — `nsa.gov`,
`media.defense.gov` and `cisa.gov` all return HTTP 403 to automated fetches and need a human.
Details in [mappings/README.md](mappings/README.md).

⚠️ **NIST IR 8547 is still an initial public draft** (published 2024-11-12). The 2030/2035 dates
are verified as what the draft says — they are not final binding guidance, and customer-facing
output must label them as draft.
- Dates are absolute (`2030-12-31`), never relative ("next year").

---

## Current state of the codebase

Grounding for everything below — this is what exists as of 2026-08-01:

| Component | Path | State |
|---|---|---|
| Regex scanner, 7 patterns | `artifacts/api-server/src/lib/scanner.ts` | built |
| Express 5 API, 9 route modules | `artifacts/api-server/src/routes/` | built |
| React + Vite frontend | `artifacts/q-vuln/` | built |
| Drizzle schema — 10 tables | `lib/db/src/schema/` | built |
| OpenAPI → Orval codegen | `lib/api-spec/` | built |
| GitHub repo scanning (25-file cap) | `routes/github.ts` | built |
| AI chat over SSE | `routes/chat.ts` | built, needs API key |

**Known gaps that this plan addresses:** findings are ephemeral per-scan; risk score is
detection-derived with no data-sensitivity input; no crypto visibility inside dependencies; no
machine-readable export; no notion of an asset that persists across scans.

---

## How to run the app locally

See the repo root. Short version — the frontend needs `VITE_API_BASE_URL` set explicitly
because there is no Vite dev proxy:

```bash
docker run -d --name qvuln-pg -e POSTGRES_PASSWORD=qvuln -e POSTGRES_DB=qvuln -p 55432:5432 postgres:16
export DATABASE_URL='postgres://postgres:qvuln@localhost:55432/qvuln'
pnpm install && pnpm --filter @workspace/db run push --force
PORT=5055 DATABASE_URL=$DATABASE_URL pnpm --filter @workspace/api-server run dev
PORT=5199 VITE_API_BASE_URL=http://localhost:5055 pnpm --filter @workspace/q-vuln run dev
```
