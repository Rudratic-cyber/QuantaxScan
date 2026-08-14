# 10 — Community and Enterprise editions

**This document is the authority on which edition a feature belongs to.**
[03-features.md](03-features.md) remains the authority on what a feature *is* and its build
status. If the two disagree, the catalog wins on scope and this file wins on tiering.

---

## The recommendation

Ship **open core**: an Apache-2.0 Community edition covering detection and single-project
scanning, a **CC BY 4.0** standards dataset, and a commercially-licensed Enterprise edition
covering everything organizational, continuous, and evidentiary.

### Why open core fits this product specifically

**1. Detection was never the moat.** [G-17](09-open-gaps.md) established that NIST SP 1800-38B
names a consortium of vendors already building cryptographic discovery tools — Cisco, IBM,
Infosec Global, ISARA, Keyfactor, Microsoft, SafeLogic, Samsung SDS, SandboxAQ, wolfSSL. We are
not going to out-cover IBM on detection breadth. Since detection breadth is not the defensible
position, **giving it away costs almost nothing** and buys adoption, contribution, and
credibility. That makes this decision much easier than it looks.

**2. Security tools are trusted in proportion to their inspectability.** A closed-box detector
that tells a CISO their cryptography is inadequate invites the obvious question: *"based on
what?"* Open detection logic answers it. This is the same argument as citing primary sources in
`mappings/` — and we have already committed to that discipline everywhere else.

**3. The long tail of collectors is community-shaped work.** New languages, ecosystems, crypto
libraries and lockfile formats are exactly the contributions outsiders make well and we would
otherwise fund forever.

**4. The buyer split already exists in the strategy.** [01-strategy.md](01-strategy.md) chose the
CISO as buyer and deprioritised the developer. Community serves the engineer who finds us;
Enterprise serves the CISO who buys. Community is **top-of-funnel and credibility, not a revenue
path** — say that out loud internally so nobody optimises it for monetisation.

---

## The boundary principle

> **Community: one repo, one scan, one person.**
> **Enterprise: an estate, over time, for an organization.**

Every tiering call below follows from that single line. When a new feature appears, apply the
line rather than negotiating case by case.

| Dimension | Community | Enterprise |
|---|---|---|
| Scope | One project | Portfolio / estate |
| Time | Point-in-time | Continuous, with history |
| Users | One person | Organization, roles |
| Output | A report you read | Evidence you hand to an auditor |
| Deployment | Self-serve, local | Hosted or on-prem, supported |

### The two hard calls

**Mosca (A4) — arithmetic open, apparatus paid.** `X + Y > Z` is a published inequality. It is
not defensible as intellectual property and pretending otherwise would be embarrassing. So the
calculation ships open. What is genuinely hard and genuinely valuable is the *operational*
layer: managing data classifications across an estate, maintaining Q-Day scenarios, and rolling
verdicts up to a portfolio view. That is Enterprise.

**Crypto-agility (D5) — metric open, clustering paid.** Same shape. The definition and
single-repo score are open, because publishing the metric is how it becomes *the* metric.
Cross-repo clustering that identifies shared wrapper modules across an estate is Enterprise.

Both follow the boundary principle exactly, which is a good sign the line is real.

---

## Feature alignment

All 46 features from [03-features.md](03-features.md). Status is mirrored from the catalog;
**Edition** is set here.

Legend — **C** Community (Apache 2.0) · **E** Enterprise (commercial) · **C→E** open core with a
paid extension

### A. Inventory core

| # | Feature | Status | Edition | Rationale |
|---|---|---|---|---|
| A1 | Asset/observation data model | `built`* | **C** | The schema is the foundation everything reads; forking it would fragment the ecosystem |
| A2 | Collector interface | `built`* | **C** | The contract third parties write collectors against. Must be open or nobody writes one |
| A3 | Data classification | `next` | **C→E** | Field and presets open; estate-wide classification management and inheritance Enterprise |
| A4 | Mosca risk engine | `built`* | **C→E** | Inequality open (`lib/risk`, and scenarios are a parameter at every entry point); scenario management + portfolio rollup Enterprise |
| A5 | CBOM export (CycloneDX 1.7) | `built` | **C** | Interoperability is the whole point. Paywalling export makes us the silo we criticise |
| A6 | CBOM import | `planned` | **C** | Same |

### B. Collectors

**All collectors are Community.** This is the deliberate core of the strategy — coverage breadth
is not the moat, and community contribution is highest-leverage here.

| # | Collector | Status | Edition | Note |
|---|---|---|---|---|
| B1 | Source code (regex) | `built` | **C** | Already exists |
| B2 | Dependency / SBOM | `built`* | **C** | Collector only — nothing submits lockfiles or persists what it finds yet |
| B3 | TLS / cipher suite prober | `planned` | **C** | |
| B4 | Certificate / X.509 | `planned` | **C** | |
| B5 | KMS / secret stores | `planned` | **C→E** | Collector open; **managed credential handling** Enterprise — customer secrets need audited storage |
| B6 | Protocol config | `planned` | **C** | |
| B7 | Data-at-rest | `planned` | **C→E** | Same pattern as B5 |
| B8 | Manual OT/embedded register | `planned` | **E** | A register of record with owners and review dates — organizational by nature |
| B9 | Vendor / third-party | `planned` | **E** | Vendor questionnaire tracking is workflow, not detection |
| B10 | Binaries / firmware | `deferred` | **C** | See [G-16](09-open-gaps.md) — NIST treats this as core discovery, so it belongs open |

\* A1/A2: schema, fingerprint, backfill, `SourceRegexCollector` and `DependencyCollector` (B2)
are built; the read cutover and dependency-asset persistence are not. See [03-features.md](03-features.md#a-inventory-core) for the exact
built/not-built split — this table mirrors its status column, not a separate assessment.

### C. Compliance and mapping

| # | Feature | Status | Edition | Rationale |
|---|---|---|---|---|
| C1 | Dynamic mapping engine | `built` | **C** | The engine is a pure function over open data |
| C2 | Versioned `mappings/` data | `next` | **C** | **CC BY 4.0** — see below. The authority play |
| C3 | FIPS 203/204/205 mapping | `built` | **C** | |
| C4 | IR 8547 timeline mapping | `planned` | **C** | |
| C5 | CNSA 2.0 timeline mapping | `planned` | **C** | |
| C6 | CISA roadmap alignment | `planned` | **C** | |
| C7 | NSM-10 / OMB M-23-02 format | `planned` | **E** | A regulatory submission artifact — squarely evidentiary |
| C8 | Waivers / exceptions register | `planned` | **E** | Sign-off, expiry, approver — organizational governance |
| C9 | Control framework crosswalk | `planned` | **E** | Audit-facing, and the frameworks themselves are licensed |

Mapping *data and engine* open; *regulatory artifacts and governance* paid. Anyone can compute
"this is RSA, here is the NIST deadline." Only Enterprise produces the signed submission.

### D. CISO surface

| # | Feature | Status | Edition | Rationale |
|---|---|---|---|---|
| D1 | CISA quantum-readiness dashboard | `planned` | **E** | Organizational posture view |
| D2 | Mosca exposure view | `planned` | **C→E** | Single-project view open; estate view Enterprise |
| D3 | Coverage / confidence meter | `planned` | **C→E** | Per-scan coverage open; estate completeness Enterprise |
| D4 | Drift detection + alerting | `planned` | **E** | Requires continuity and history — the definition of Enterprise |
| D5 | Crypto-agility score | `planned` | **C→E** | Metric open; cross-repo clustering Enterprise |
| D6 | Migration wave planner | `planned` | **E** | Multi-team programme management |
| D7 | Trend / history view | `planned` | **E** | Continuity |

### E. Reports

| # | Report | Status | Edition | Rationale |
|---|---|---|---|---|
| E1 | Board / executive pack | `planned` | **E** | |
| E2 | Regulator / auditor submission | `planned` | **E** | **The artifact that justifies the price** |
| E3 | CBOM export | `built` | **C** | Machine-readable output stays open, always |
| E4 | Technical remediation backlog | `planned` | **C→E** | Per-project list open; estate backlog with owners Enterprise |
| E5 | Vendor assessment pack | `planned` | **E** | |
| E6 | Scheduled report delivery | `planned` | **E** | Continuity |

The line: **Community tells you what you have. Enterprise proves it to someone else.**

### F. Platform and security

| # | Feature | Status | Edition | Rationale |
|---|---|---|---|---|
| F1 | Authentication + RBAC | `partial` | **C→E** | Basic auth open — never ship an unauthenticated tool. SSO/RBAC Enterprise |
| F2 | Multi-tenancy | `partial` | **E**§ | Definitionally organizational |
| F3 | Audit logging | `planned` | **E** | |
| F4 | Source-code handling controls | `planned` | **C** | **Never paywall a security control.** Ephemeral/no-retention mode ships open |
| F5 | Self-hosted deployment | `planned` | **C** | Community *is* self-hosted. Enterprise adds support and SLA, not capability |
| F6 | SSO / SAML | `planned` | **E** | Classic enterprise line |
| F7 | Secrets management | `partial` | **C** | Hygiene, not a feature |
| F8 | Ticket sync | `deferred` | **E** | |

§ **The tiering is unchanged, and the boundary is worth stating precisely.** What is Enterprise is
*multi-tenancy as a capability* — several organisations, membership, switching between them. The
**isolation mechanism is not tiered and never will be**: row-level security, the non-`BYPASSRLS`
runtime role and the `withOrg` choke point are in the base product, enforced identically in every
edition. Isolation is a security control, and rule one below applies to it. A Community
deployment is an organisation of one that is nonetheless properly scoped. See
[13-auth-and-tenancy.md](13-auth-and-tenancy.md).

> **Two rules that override revenue optimisation:** never paywall a security control (F4), and
> never paywall interoperability (A5/E3). Selling "the version that doesn't leak your source
> code" would be indefensible for a security vendor, and paywalling CBOM export would make us
> the silo the whole strategy criticises.

---

## Build status by edition

| Edition | `built` | `next` | `planned` | `deferred` | Total |
|---|---|---|---|---|---|
| Community (incl. C→E open half) | 2 | 8 | 13 | 1 | 24 |
| Enterprise | 0 | 0 | 21 | 1 | 22 |

**Everything shipped today is Community-tier** — the regex scanner (B1) and the hardcoded FIPS
mapping (C3). There is currently **no Enterprise functionality at all**.

That is the honest position and it has a consequence: there is nothing to sell yet, and the
Community edition is closer to launchable than the Enterprise one. Phase 1 in
[02-roadmap.md](02-roadmap.md) is almost entirely Community work — which means **the open-source
launch can come first**, and should, provided the gates below are met.

---

## Licensing — three separate decisions

### 1. Open core → Apache 2.0

Collectors, detection, asset model, mapping engine, CBOM import/export, CLI.

Apache 2.0 rather than AGPL. AGPL would block the embedding and interoperability we have argued
for throughout, and enterprise legal teams routinely prohibit it. We *want* other tools —
including the SP 1800-38B consortium's — to consume our collectors and CBOM output. The patent
grant is also worth having in a cryptography-adjacent project.

### 2. `mappings/` → CC BY 4.0

**The strongest idea in this document.** The standards dataset is *data*, not code, and should
carry a data licence.

CC BY 4.0 requires attribution. Every tool, consultancy, or auditor that uses our algorithm →
NIST-obligation mappings must credit us. This is the one asset where **being copied is the
win**: it establishes "the reference PQC mapping dataset" as our position, and the authority
compounds. It also invites exactly the community PRs the data needs, because standards decay and
we cannot track every framework alone.

Pairs naturally with the verification discipline already in place — a citable, versioned, cited
dataset is a genuine public good and it is cheap for us to maintain as a by-product of building
the product.

### 3. Enterprise → commercial licence, separate directory or repo

`ee/` directory with a clear licence header, or a separate private repo. Decide before the first
Enterprise line of code, because untangling it later is painful.

### ⚠️ Resolve the existing conflict first

`package.json` declares `"license": "MIT"` and there is **no LICENSE file in the repo**. If the
repository is published as-is, that declaration is what governs — MIT over the entire workspace,
including anything intended to be Enterprise.

Two-line fix now; a genuine mess later. Set the root manifest to the intended licence, add
LICENSE files per tier, and add `mappings/LICENSE` for CC BY 4.0.

---

## Publication gates — hard blockers

The repo is **private today**. Going open publishes things that are currently internal, and
these are blockers rather than advice.

### 🔴 Gate 1 — fix S1–S8 first ([G-12](09-open-gaps.md))

Publishing the repo publishes its vulnerabilities. No authentication on any route,
`Math.random()` share-link IDs, `cors({ origin: true })` with credentials, full customer source
persisted. Today these are internal problems. Public, they are **a ready-made vulnerability
inventory for a security product** — and the first thing a hostile reader will look for.

There is no version of this where we open-source first and fix after.

### 🔴 Gate 2 — audit git history, not just the working tree

`.env` is tracked and **in history**. It currently holds only `API_BASE_URL`, so this is cheap
right now — and it stays cheap only until someone commits a real secret. Note that the
[G-13](09-open-gaps.md) fix (`git rm --cached`) removes the file going forward but **does not
remove it from history**. Publishing publishes history.

### 🟠 Gate 3 — audit `attached_assets/`

Roughly 4 MB of Replit screenshots and pasted-text scraps. **Nobody has reviewed them** for
credentials, internal URLs, customer data, or third-party copyrighted content. They are
currently invisible; publication makes them permanent and indexable.

Recommend deleting the directory outright — it is development detritus with no ongoing value —
rather than auditing 20+ images.

### 🟠 Gate 4 — the docs describe an unbuilt product

This documentation set is candid about what does not exist. That is correct internally and
mostly fine publicly, but `08-security.md` and [G-17](09-open-gaps.md) read differently as
public documents. Decide deliberately what ships with the open repo.

**Recommendation: publish `08-security.md` anyway, once the findings are fixed.** "We ran our own
standards against ourselves and published the findings" is the highest-credibility content
available to us ([marketing C007](marketing/03-content-calendar.md)) and it is *only* credible
if the document is real.

---

## Revenue model

Community is free and self-hosted. Enterprise is priced per estate, not per seat — the value
scales with the size of the inventory, and per-seat pricing would penalise exactly the
organization-wide visibility we are selling.

**Price against the alternative, which is a consultancy engagement**, not against developer
tools. A point-in-time Big 4 cryptographic audit runs to six figures and is stale on delivery;
that is the number the buyer has in their head.

The conversion path: an engineer finds Community, scans one repo, gets a real finding, and shows
their CISO. The CISO asks the estate-level question Community cannot answer — *how much of our
estate does this cover, and can I hand it to an auditor?* That question **is** the Enterprise
product.

---

## Risks

| Risk | Assessment |
|---|---|
| Competitors absorb our detection logic | Accepted deliberately. Detection is not the moat ([G-17](09-open-gaps.md)); they have more coverage already |
| Support burden from free users | Real. Mitigate with strict issue triage and no SLA for Community from day one |
| Community edition cannibalises sales | Unlikely — the boundary is estate/continuity/evidence, and no CISO buys "one repo, one scan" |
| Open-sourcing exposes our own weak security | **Correct, and it is a hard gate.** See Gate 1 |
| CC BY mappings get forked and diverge | Possible. Mitigate by being the best-maintained version — which the product work funds anyway |

### What would falsify this plan

- Community adoption arrives with **zero** Enterprise conversion → the boundary is drawn wrong,
  probably too generously
- Nobody contributes collectors → the main strategic benefit is absent and open-sourcing is pure
  cost
- Enterprise buyers demand source access to *everything* as a condition of purchase → the
  open/closed split fails and a source-available model fits better

---

## Sequencing

1. Resolve the licensing conflict (`package.json` MIT vs no LICENSE) — **now, it is two lines**
2. Decide the `ee/` boundary before writing any Enterprise code
3. Fix S1–S8 ([G-12](09-open-gaps.md)) — gates everything below
4. Audit history and delete `attached_assets/`
5. Complete Phase 1, which is almost entirely Community work
6. **Open-source launch** — Community + `mappings/` under CC BY 4.0
7. Build Enterprise against real Community usage, informed by what people actually ask for

Note step 7: shipping Community first means the Enterprise feature set gets designed against
observed demand rather than our assumptions. Given that the biggest risk in
[01-strategy.md](01-strategy.md) is buyers refusing SaaS source ingestion, an open self-hosted
Community edition is also the cheapest way to test that assumption.
