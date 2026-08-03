# QuantaXscan — Enterprise Post-Quantum Readiness

**Working docs for the expansion from "code scanner" to "cryptographic inventory platform."**

Owner: Rudratic-cyber · Started: 2026-08-01 · Status: planning

---

## The one-paragraph version

QuantaXscan today scans source code for quantum-vulnerable algorithms and maps them to NIST PQC
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
| 09 | [Open gaps](09-open-gaps.md) | **Every known gap, what closes it, what it blocks** |
| 10 | [Editions](10-editions.md) | Community vs Enterprise, all 46 features tiered, licensing, publication gates |
| 12 | [Test suite & CI](12-test-suite.md) | API feature suite, Playwright UI journeys, GitHub Actions pipeline, coverage gaps |

### Engineering records

| # | Document | What it answers |
|---|---|---|
| 11 | [UI defect fixes](11-ui-defect-fixes.md) | What the visual review of `main` found, and what closed each item |

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
- **Dates are absolute** (`2030-12-31`), never relative ("next year").
- **Edition tags** in [10-editions.md](10-editions.md): **C** Community · **E** Enterprise ·
  **C→E** open core with a paid extension.

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

A second pass (2026-08-01, `dataVersion 0.3.0`) verified FIPS 186-5, SP 800-131A Rev 2 and
SP 800-38A/D, and found **two more wrong citations**:

| Was | Actually |
|---|---|
| MD5 cited to SP 800-131A Rev 2 | MD5 appears **zero times** in it — it was never NIST-approved, so there is nothing to transition |
| AES-ECB cited to SP 800-38D | "ECB" appears **zero times** in SP 800-38D (the GCM spec). ECB is an **approved** mode in SP 800-38A — calling it a violation would be false |

Plus: **DSA has been unapproved for signature generation since FIPS 186-5 (2023-02-03)** — it is
a present-tense compliance failure, not a 2035 migration item.

A third pass added the NIST publication these docs had been missing entirely:

> **NIST SP 1800-38 (NCCoE) — "Migration to Post-Quantum Cryptography: Quantum Readiness,
> Cryptographic Discovery"** is the practice guide for *cryptographic discovery tools* — our
> exact product category. Volume B defines a discovery architecture, a normalisation scheme for
> discovery output, and an eight-use-case functional test plan. **SP 1800-38A/B/C are all
> preliminary drafts** (A April 2023; B/C December 2023), not final NIST publications — label
> them as draft guidance anywhere this reaches a customer, and re-check when NIST publishes a
> replacement.

Earlier drafts had listed **NIST CSF 2.0** as the relevant NIST framework. That was wrong — CSF
is a generic cybersecurity framework and belongs only as a control crosswalk. The PQC-specific
NIST publications are **IR 8547** (which algorithms, by when), **SP 1800-38** (how to build
discovery), and **FIPS 203/204/205** (what to replace them with).

Three consequences, all logged as gaps: our observation model should carry SP 1800-38B's data
elements including **CPE 2.3** ([G-15](09-open-gaps.md)); NIST treats **binary scanning as core**
where we deferred it ([G-16](09-open-gaps.md)); and the competitive framing was wrong — SP
1800-38B names a **NIST-convened consortium of discovery-tool vendors** ([G-17](09-open-gaps.md)).

**Update, 2026-08-02:** A1 (asset/observation data model) and A2 (collector interface) have
landed — new tables, the `Collector`/`RawObservation` contract, `SourceRegexCollector`, the
`locationDetail`/CPE 2.3 profile, and the six-value discovery-modality enum. See
[04-architecture.md](04-architecture.md) for what was built versus deferred (read cutover and
dropping `findings` are a separate follow-up), and [03-features.md](03-features.md) for the
per-feature status.

Still `needs-check`: CNSA 2.0 per-category dates and OMB M-23-02 format — `nsa.gov`,
`media.defense.gov` and `cisa.gov` all return HTTP 403 to automated fetches and need a human.
Full register in [09-open-gaps.md](09-open-gaps.md); data status in
[mappings/README.md](mappings/README.md).

⚠️ **NIST IR 8547 is still an initial public draft** (published 2024-11-12). The 2030/2035 dates
are verified as what the draft says — they are not final binding guidance, and customer-facing
output must label them as draft.

---

## Current state of the codebase

Grounding for everything below — this is what exists as of 2026-08-02:

| Component | Path | State |
|---|---|---|
| Regex scanner, 7 patterns | `lib/collectors/` (`SourceRegexCollector`); `artifacts/api-server/src/lib/scanner.ts` is a back-compat shim | built |
| Collector contract, CPE 2.3, asset fingerprint | `lib/collectors/` | built |
| Express 5 API, 9 route modules | `artifacts/api-server/src/routes/` | built |
| React + Vite frontend | `artifacts/quantaxscan/` | built |
| Drizzle schema | `lib/db/src/schema/` | built |
| Asset/observation model, dual-written on every scan | `lib/db/src/schema/{assets,observations,collection_runs}.ts` | built, no reads |
| OpenAPI → Orval codegen | `lib/api-spec/` | built |
| GitHub repo scanning (25-file cap) | `routes/github.ts` | built |
| AI chat over SSE | `routes/chat.ts` | built, needs API key |

**Known gaps that this plan addresses:** every route still reads ephemeral per-scan `findings`
(assets persist but nothing reads them — see [03-features.md](03-features.md) A1); risk score is
detection-derived with no data-sensitivity input; no crypto visibility inside dependencies; no
machine-readable export.

---

## How to run the app locally

See the repo root. Short version — the frontend needs `VITE_API_BASE_URL` set explicitly
because there is no Vite dev proxy:

```bash
docker run -d --name quantaxscan-pg -e POSTGRES_PASSWORD=quantaxscan -e POSTGRES_DB=quantaxscan -p 55432:5432 postgres:16
export DATABASE_URL='postgres://postgres:quantaxscan@localhost:55432/quantaxscan'
pnpm install && pnpm --filter @workspace/db run push --force
PORT=5055 DATABASE_URL=$DATABASE_URL pnpm --filter @workspace/api-server run dev
PORT=5199 VITE_API_BASE_URL=http://localhost:5055 pnpm --filter @workspace/quantaxscan run dev
```
