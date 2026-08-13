# 03 — Feature catalog

Status: `built` · `next` · `planned` · `deferred` · `won't`

Priority: **P0** blocks a milestone · **P1** milestone scope · **P2** valuable, cuttable ·
**P3** later

> **Edition tiering lives in [10-editions.md](10-editions.md), not here.** That document assigns
> every feature below to Community (Apache 2.0) or Enterprise (commercial). This file is the
> authority on what a feature *is* and its build status; 10 is the authority on which edition
> ships it. Keep them in sync when adding a feature — add the row here first, then tier it there.

---

## A. Inventory core

### A1. Asset/observation data model `built`* **P0**

Replace per-scan findings with persistent assets and time-stamped observations.

- An asset is a *thing that has crypto* — a file, a dependency, an endpoint, a certificate, a key
- An observation is *a collector saw this at a point in time*, with confidence and provenance
- Assets carry `firstSeen`, `lastSeen`, `status` (`active` / `remediated` / `waived` / `gone`)
- Stable identity across re-scans via a deterministic fingerprint

**Acceptance:** re-scanning an unchanged repo produces zero new assets and updates `lastSeen` on
existing ones. Removing the vulnerable line marks the asset `gone`, and it stays in history. Both
halves verified (`artifacts/api-server/src/lib/asset-ingest.test.ts`). The `gone` reconciliation
is scoped **per scanned file** (by `location`), not per repo/project: a call that only submits a
subset of a project's files (e.g. `POST /scans` submitting one file) has no information about
files it wasn't given, so those files' assets are left untouched rather than wrongly marked gone.
Reappearance is symmetric — a `gone` asset that is observed again reactivates the same row
(`status` back to `active`) rather than creating a duplicate. Reactivation is *only* `gone` →
`active`: `waived` and `remediated` are human decisions about an asset, not observations of it,
so re-seeing the same line records the observation and advances `lastSeen` without undoing them.

**Depends on:** nothing. **Blocks:** literally everything else.

\* Schema, fingerprint, backfill script, and dual-write from `POST /scans`/`POST /scans/multi`
are built (`lib/db/src/schema/{assets,observations,collection_runs}.ts`,
`lib/collectors/src/fingerprint.ts`, `scripts/src/backfill-assets.ts`,
`artifacts/api-server/src/lib/asset-ingest.ts`). **Not built:** reads are not cut over — every
existing route still reads `findings`, `findings` is not dropped, and `scans.code` (full
submitted source) is still stored. See [04-architecture.md](04-architecture.md#migration-path)
for why that is a deliberate, separately-scoped follow-up rather than a partial migration.

---

### A2. Collector interface `built`* **P0**

Generalise `scanner.ts`'s `VULNERABILITY_PATTERNS` array into a pluggable collector contract.
Regex-over-source becomes one implementation.

**Acceptance:** a new collector can be added without modifying `scanner.ts` or the API routes.
Architecturally true — nothing in `Collector`/`RawObservation` assumes a source-only collector —
but **unverified**: `SourceRegexCollector` is still the only implementation, so this acceptance
criterion has not actually been exercised by a second collector.

\* `@workspace/collectors` (new package): `Collector`/`RawObservation` contract, `SourceRegexCollector`,
CPE 2.3 parser, discriminated `locationDetail`, deterministic fingerprint, and a small lookup
over `docs/Claude/mappings/algorithms.json` for severity/replacement/standard/explanation — not
the C1 dynamic mapping engine (see [05](05-compliance-mapping.md)), and resolved as each finding
is built, so those strings are still frozen into the `findings` row until reads cut over (see
[04-architecture.md](04-architecture.md)). Key size extraction (G-05) works for same-line
literals and named curves in source only; B2–B10 remain unbuilt.

---

### A3. Data classification `built`* **P0**

`secrecyLifetimeYears` plus a classification label per asset/project. Sensible presets:

| Preset | X (years) | Examples |
|---|---|---|
| Public | 0 | Marketing sites, published docs |
| Internal | 3 | Internal tooling, non-sensitive ops |
| Confidential | 7 | Commercial contracts, financials |
| Regulated | 25 | Health records, insurance, government |
| Indefinite | 50 | State secrets, genomic data, identity roots |

**Acceptance:** every asset has an X value, defaulting to a project-level setting, overridable
per asset, with the default clearly marked as an assumption in reports. The first two clauses are
met by `resolveSecrecyLifetime()`, which always returns a number. The third is met **in the data
rather than in report copy**: the resolved record carries `source` (`asset` | `project` |
`default`) and `assumed`, so a report states the provenance instead of a caption asserting it.

\* **Built:** the classification vocabulary and its preset X values, the `data_classification` +
`secrecy_lifetime_years` pair on both `projects` (the default) and `assets` (the override) with
`CHECK` constraints, and the pure resolver — all in `lib/db/src/classification.ts`, exported as
`@workspace/db/classification` (a subpath with no drizzle/`pg`/`DATABASE_URL` dependency, so A4
can import the contract on its own). `SecrecyLifetime` is A4's `X` input.

All four columns are **nullable with no database default**, and that is what makes the third
acceptance clause satisfiable: `NOT NULL DEFAULT 3` would destroy the difference between "a human
chose Internal" and "nobody said anything" on the way into the database. Same reasoning as
`assets.key_size` (G-05). Provenance is therefore *derived* by the resolver rather than stored — a
persisted `classification_source` column would go stale the moment a project's default changed.

**Not built:** no write path. There is no API route or UI control for setting either level yet,
and `CreateProjectBody` is unchanged — A1's reads were never cut over to `assets`, so there is no
asset API surface to hang an override on (see the route manifest in `cross-tenant.test.ts`).
Nothing calls `resolveSecrecyLifetime()` in production code yet; A4 is its first consumer. Values
can only be set by direct SQL today.

---

### A4. Mosca risk engine `built`* **P0**

Split risk from detection. Input `(asset, X, Y, Z-scenario)` → verdict + score.

X comes from A3: `resolveSecrecyLifetime()` in `@workspace/db/classification` returns a
`SecrecyLifetime` — `{ years, source, assumed, classification, classificationSource, basis }`.
Take `years` as X and carry `assumed`/`basis` into the verdict, so "why" can distinguish a
customer-supplied lifetime from a defaulted one.

**Acceptance:** returns a verdict per Q-Day scenario, and the UI shows *why* — the three input
values, not just a number. **Engine half met, UI half not** — see the asterisk.

\* `@workspace/risk` (`lib/risk/`, new package): `assessMoscaRisk()` returns one `MoscaVerdict`
per Q-Day scenario (conservative 2030 / central 2035 / aggressive 2040, from
[01-strategy.md](01-strategy.md)), each carrying `x`, `y`, `z`, `breached`, `breachMarginYears`
and a narrative sentence naming all three inputs — the module exports no way to obtain a score
without them. `computeRiskProfile()` is the scan-level entry point: it returns a **post-quantum
exposure score** and a **separate classical-hygiene panel**, which is what closes
[G-10](09-open-gaps.md#g-10--hygiene-findings-inflate-the-pqc-risk-score). The track split is
derived from `algorithms.json`'s own `quantumVulnerable` flag and each entry's `reportingNote`,
never from a list of algorithm names in code. `computeScanResult()` now reports the PQC score as
`riskScore` and returns `pqc`/`hygiene`/`mosca` alongside it; the scan, multi-scan, demo and
GitHub routes pass those through. Nothing about A4 is persisted — the profile is recomputed at
read time, so a mappings or scenario change moves the verdict without a backfill.

**Not built, deliberately:**

- **The UI.** `pqc`, `hygiene` and `mosca` are the panel's data contract; no page renders them
  yet, and `lib/api-spec/openapi.yaml` and the generated Orval client are not updated, so the
  typed frontend client cannot see the new fields. That is D2 (Mosca exposure view) and the
  hygiene panel's presentation, not A4's engine.
- **X per asset.** A3 supplies it. Until then every verdict uses
  `DEFAULT_SECRECY_LIFETIME_YEARS` (3 — A3's "Internal" preset) and reports
  `mosca.secrecyLifetimeSource: "assumed-default"` so a report can mark it as an assumption.
- **Agility in Y.** Y is `effortHours ÷ agilityScore ÷ hours-per-calendar-year` with
  `agilityScore` fixed at 1 pending D5, and the hours-per-year constant is a stated guess with
  no source in these documents. It is the least defensible number in the engine.
- **Portfolio rollup and scenario management** — the Enterprise half per
  [10-editions.md](10-editions.md). Scenarios are a parameter everywhere, which is the hook.

**Know this before reading a score.** `riskScore` is `detection` (0-60) + `moscaBreach` (0-40).
At the assumed default X of 3 years the conservative scenario (2030) is still further away than
that, so nothing breaches and **the score cannot exceed 60 until A3 supplies a real secrecy
lifetime** — or until 2027, when the conservative Q-Day comes inside three years. That is
intended: the top 40% of the scale is reserved for an actual Mosca breach and must be earned,
not asserted by detection volume. It does mean the headline number's range is narrower than it
was before A4, which is the honest reading of a scan with no data classification behind it.

---

### A5. CBOM export (CycloneDX 1.7) `next` **P0**

Target **1.7** — released 2025-10-21, standardised as ECMA-424. `verified 2026-08-01`. CBOM
represents algorithms, keys and certificates and their relationships to software components.

**Acceptance:** output validates against the official CycloneDX 1.7 JSON schema.

---

### A6. CBOM import `planned` **P2**

Ingest CBOMs/SBOMs the customer already has. Cheap coverage, and it makes us a hub rather than
another silo.

---

## B. Collectors (coverage track)

| # | Collector | Status | Pri | Notes |
|---|---|---|---|---|
| B1 | Source code (regex) | `built` | — | Now `SourceRegexCollector` behind A2 (`lib/collectors/`). **Key size (G-05): partially closed** — extracts a same-line literal modulus or named-curve size, undetermined (not defaulted) otherwise; no cross-line/AST resolution. **Confidence (G-11): closed** for this collector — `0.7`, persisted. **EdDSA (G-06): still open** — out of scope for this change, no new pattern added — see [09](09-open-gaps.md) |
| B2 | Dependency / SBOM | `next` | **P0** | Biggest coverage jump. Parse lockfiles → map to known crypto libs + versions |
| B3 | TLS / cipher suite prober | `planned` | **P1** | Active handshake against hosts. Records *negotiated* KEX, not configured |
| B4 | Certificate / X.509 | `planned` | **P1** | Key type, size, expiry. Expiry-vs-Q-Day is the killer chart |
| B5 | KMS / secret stores | `planned` | **P2** | Vault, AWS KMS, Azure Key Vault, GCP KMS. Read-only creds |
| B6 | Protocol config | `planned` | **P2** | SSH, IPsec, JWT `alg`, SAML/OIDC signing |
| B7 | Data-at-rest | `planned` | **P2** | DB TDE, backup/archive encryption — the true HNDL targets |
| B8 | Manual OT/embedded register | `planned` | **P1** | A *form*, not a scanner. Longest lead time, so it enters the plan first |
| B9 | Vendor / third-party | `planned` | **P3** | Questionnaire + contractual PQC clause tracking |
| B10 | Binaries / firmware | `deferred` | **P3** | Hard. Defer until coverage elsewhere is complete |

### On B2 — say this out loud

The current scanner cannot see crypto inside dependencies, and that is where most enterprise
crypto lives. B2 is not an incremental improvement; it is the difference between a demo and a
product. Prioritise accordingly.

---

## C. Compliance & mapping

| # | Feature | Status | Pri |
|---|---|---|---|
| C1 | Dynamic mapping engine (data-driven) | `next` | **P0** |
| C2 | Versioned `mappings/` data + provenance | `next` | **P0** |
| C3 | NIST FIPS 203/204/205 algorithm mapping | `built`* | **P0** |
| C4 | NIST IR 8547 deprecation timeline mapping | `planned` | **P1** |
| C5 | CNSA 2.0 timeline mapping | `planned` | **P1** |
| C6 | CISA quantum-readiness roadmap alignment | `planned` | **P1** |
| C7 | NSM-10 / OMB M-23-02 inventory format | `planned` | **P2** |
| C8 | Waivers / exceptions register | `planned` | **P1** |
| C9 | Control framework crosswalk (ISO 27001, SOC 2, PCI DSS 4, DORA) | `planned` | **P3** |

\* C3 exists as a static by-name lookup over `mappings/algorithms.json`
(`lib/collectors/src/algorithm-mapping.ts`, added by A2 — it replaced the hardcoded copies in
`scanner.ts`'s pattern table). C1/C2 are the real work: deadline resolution, security-strength
keying and crosswalks, none of which that lookup does.

Detail: [05-compliance-mapping.md](05-compliance-mapping.md)

---

## D. CISO surface

| # | Feature | Status | Pri |
|---|---|---|---|
| D1 | CISA quantum-readiness dashboard | `planned` | **P1** |
| D2 | Mosca exposure view (per scenario) | `planned` | **P1** |
| D3 | Coverage/confidence meter — *what we haven't looked at* | `planned` | **P1** |
| D4 | Drift detection + alerting | `planned` | **P1** |
| D5 | Crypto-agility score | `planned` | **P1** |
| D6 | Migration wave planner | `planned` | **P2** |
| D7 | Trend/history view | `planned` | **P2** |

### D3 deserves special mention

Most security dashboards only show what they found, which silently implies complete coverage.
For an inventory product that is a *credibility-destroying* omission — a CISO who presents our
report to an auditor and gets asked "does this include your mainframe?" needs the answer to be
on the page.

Show unscanned surfaces as explicit gaps with an estimated blind-spot size. **The honest
version is the more sellable one**, because it converts the gap into next quarter's budget ask.

Detail: [06-cisa-dashboard.md](06-cisa-dashboard.md)

---

## E. Reports

| # | Report | Status | Pri |
|---|---|---|---|
| E1 | Board / executive pack | `planned` | **P1** |
| E2 | Regulator / auditor inventory submission | `planned` | **P1** |
| E3 | CBOM (machine-readable) | `next` | **P0** |
| E4 | Technical remediation backlog | `planned` | **P2** |
| E5 | Vendor assessment pack | `planned` | **P3** |
| E6 | Scheduled report delivery | `planned` | **P2** |

Detail: [07-reports.md](07-reports.md)

---

## F. Platform & security

| # | Feature | Status | Pri |
|---|---|---|---|
| F1 | Authentication + RBAC | `partial` | **P0**† |
| F2 | Multi-tenancy with hard isolation | `partial` | **P0**† |
| F3 | Audit logging | `planned` | **P1** |
| F4 | Source-code handling controls (ephemeral, no-retention mode) | `planned` | **P0**† |
| F5 | Self-hosted / on-prem deployment | `planned` | **P1**‡ |
| F6 | SSO / SAML | `planned` | **P2** |
| F7 | Secrets management (no `.env` in git) | `partial` | **P0** |
| F8 | Ticket sync (Jira / ServiceNow) | `deferred` | **P3** |

† **F1 `partial` — the authorisation half exists, the authentication half does not.**
Organisation-scoped authorisation is enforced in the database (see F2), and a default-deny shared
API key protects `/api`. There is still **no per-user identity**: no sign-in, no sessions, no
identity providers, so a person cannot be a principal and no action can be attributed to one. The
sign-in design is specified in [13-auth-and-tenancy.md](13-auth-and-tenancy.md) §3 and is not
built. Do not read `partial` as "nearly done" — it is the larger and more visible half that
remains.

**F2 `partial` — the isolation is real; the tenants are not yet.** Every organisation-scoped table
carries `organization_id` under a PostgreSQL row-level-security policy, the runtime connects as a
role without `BYPASSRLS`, and every route goes through `withOrg`, so a forgotten `where` clause
returns zero rows rather than another tenant's data. An automated cross-tenant suite proves it,
with a negative control demonstrated able to fail. What is missing is the ability to *create* a
second tenant: there is one organisation, and the shared API key is bound to it. Detail and
deploy order: [13-auth-and-tenancy.md](13-auth-and-tenancy.md) §5, §9, §10.

**F7 `partial`** — `.env` is out of git and gitignored (S5/G-13). Secret scanning in CI is not
done.

F1/F2/F4 are P0 the moment a second organisation's data enters the system. The mechanism for F2
now exists ahead of that moment, which is the intended order.

‡ Promote to **P0** if design partners refuse SaaS source-code ingestion.

Detail: [08-security.md](08-security.md), [13-auth-and-tenancy.md](13-auth-and-tenancy.md)

---

## Deliberate non-features `won't`

Automated remediation PRs · IDE plugins · our own PQC crypto library · quantum-safe VPN
products · blockchain/wallet tooling · real-time traffic interception.

Each has been considered and rejected for the first 12 months. Reopening one requires updating
[01-strategy.md](01-strategy.md), not just this list.
