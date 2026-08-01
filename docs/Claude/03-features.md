# 03 — Feature catalog

Status: `built` · `next` · `planned` · `deferred` · `won't`

Priority: **P0** blocks a milestone · **P1** milestone scope · **P2** valuable, cuttable ·
**P3** later

---

## A. Inventory core

### A1. Asset/observation data model `next` **P0**

Replace per-scan findings with persistent assets and time-stamped observations.

- An asset is a *thing that has crypto* — a file, a dependency, an endpoint, a certificate, a key
- An observation is *a collector saw this at a point in time*, with confidence and provenance
- Assets carry `firstSeen`, `lastSeen`, `status` (`active` / `remediated` / `waived` / `gone`)
- Stable identity across re-scans via a deterministic fingerprint

**Acceptance:** re-scanning an unchanged repo produces zero new assets and updates `lastSeen` on
existing ones. Removing the vulnerable line marks the asset `gone`, and it stays in history.

**Depends on:** nothing. **Blocks:** literally everything else.

---

### A2. Collector interface `next` **P0**

Generalise `scanner.ts`'s `VULNERABILITY_PATTERNS` array into a pluggable collector contract.
Regex-over-source becomes one implementation.

**Acceptance:** a new collector can be added without modifying `scanner.ts` or the API routes.

---

### A3. Data classification `next` **P0**

`secrecyLifetimeYears` plus a classification label per asset/project. Sensible presets:

| Preset | X (years) | Examples |
|---|---|---|
| Public | 0 | Marketing sites, published docs |
| Internal | 3 | Internal tooling, non-sensitive ops |
| Confidential | 7 | Commercial contracts, financials |
| Regulated | 25 | Health records, insurance, government |
| Indefinite | 50 | State secrets, genomic data, identity roots |

**Acceptance:** every asset has an X value, defaulting to a project-level setting, overridable
per asset, with the default clearly marked as an assumption in reports.

---

### A4. Mosca risk engine `next` **P0**

Split risk from detection. Input `(asset, X, Y, Z-scenario)` → verdict + score.

**Acceptance:** returns a verdict per Q-Day scenario, and the UI shows *why* — the three input
values, not just a number.

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
| B1 | Source code (regex) | `built` | — | Exists. Needs to move behind A2 |
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

\* C3 exists but is **hardcoded** in `scanner.ts`. C1/C2 move it to data. That's the real work.

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
| F1 | Authentication + RBAC | `planned` | **P0**† |
| F2 | Multi-tenancy with hard isolation | `planned` | **P0**† |
| F3 | Audit logging | `planned` | **P1** |
| F4 | Source-code handling controls (ephemeral, no-retention mode) | `planned` | **P0**† |
| F5 | Self-hosted / on-prem deployment | `planned` | **P1**‡ |
| F6 | SSO / SAML | `planned` | **P2** |
| F7 | Secrets management (no `.env` in git) | `next` | **P0** |
| F8 | Ticket sync (Jira / ServiceNow) | `deferred` | **P3** |

† **There is currently no authentication at all.** Every API route is open, and `app.ts:27`
sets `cors({ origin: true })` which reflects any origin. That is fine for a Replit demo and
disqualifying for an enterprise pilot. F1/F2/F4 are P0 the moment a second organisation's data
enters the system.

‡ Promote to **P0** if design partners refuse SaaS source-code ingestion.

Detail: [08-security.md](08-security.md)

---

## Deliberate non-features `won't`

Automated remediation PRs · IDE plugins · our own PQC crypto library · quantum-safe VPN
products · blockchain/wallet tooling · real-time traffic interception.

Each has been considered and rejected for the first 12 months. Reopening one requires updating
[01-strategy.md](01-strategy.md), not just this list.
