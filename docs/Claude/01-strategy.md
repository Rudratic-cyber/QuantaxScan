# 01 — Strategy

## The buyer

**A CISO (or the security architect who briefs them) at a regulated enterprise.**

Not the developer. This decision is deliberate and it constrains everything downstream.

What this buyer is actually trying to do:

1. **Answer a mandate.** A regulator, board, auditor, or parent company has asked "what is your
   post-quantum exposure and what is your plan?" They cannot currently answer it.
2. **Produce a defensible artifact.** Not a dashboard screenshot — a signed, dated, versioned
   inventory they can hand over and stand behind.
3. **Justify budget.** PQC migration is a multi-year line item competing with everything else.
   They need a risk number that survives challenge from a CFO.
4. **Not be the person who did nothing.** Harvest-now-decrypt-later means today's inaction is
   tomorrow's breach, and the timeline is public.

What this buyer is **not** doing: writing code, triaging findings, or opening pull requests.
Features that assume they will are misaimed.

### Why this beats the developer-first framing

The developer-tool version of Q-Vuln competes with every SAST vendor adding a PQC rule pack —
a feature, not a product, and it gets commoditized within a year. The inventory version
competes on **coverage breadth and evidentiary quality**, which compound and are hard to copy.

The trade-off, stated plainly: we deprioritize remediation workflow (ticket sync, PR
generation, developer IDE integration). Those matter, and we will need them eventually to
retain accounts past year one. But they are Phase 4, not Phase 1.

---

## The thesis: Mosca's inequality is the product

Everything else is instrumentation for computing this per asset.

> **X + Y > Z → you are already too late.**
>
> - **X** — how long this data must remain confidential
> - **Y** — how long it will take us to migrate this asset
> - **Z** — time remaining until a cryptographically-relevant quantum computer exists

### We already have two of the three variables

| Variable | Where it lives today | Work needed |
|---|---|---|
| **Y** — migration time | `scans.totalEffortHours`, summed from `baseEffort` per pattern in `scanner.ts:26-108` | none — already computed |
| **Z** — time to Q-Day | The Q-Day countdown component (hardcoded `2027-01-01`) | make it a configurable, scenario-driven estimate |
| **X** — data secrecy lifetime | ❌ does not exist | **one new field** on the asset/project |

That asymmetry is the highest value-per-line-of-code opportunity in the entire plan. Add
`secrecyLifetimeYears`, and the risk score stops being a detection artifact and becomes a
business claim:

> *"This asset breaches Mosca by 4 years. Data must stay secret until 2041. Migration takes
> 14 months. Q-Day central estimate is 2032."*

That sentence is what a CISO puts in a board deck. `riskScore: 100` is not.

### The problem this fixes

`computeScanResult()` derives risk purely from what was detected. An RSA key protecting a
public marketing site and an RSA key protecting 30-year patient records score **identically**
today. That is the first thing a sophisticated buyer will attack, and they will be right.

**Fix:** split the risk engine out of detection. It takes
`(asset, dataClassification, effortEstimate, qDayEstimate)` and returns a Mosca verdict plus a
score. See [04-architecture.md](04-architecture.md#3-split-the-risk-engine-from-detection).

### On Z, honestly

Nobody knows when Q-Day is. A product that asserts a single date is making a claim it cannot
defend. Ship **scenarios** instead — conservative / central / aggressive — and let the customer
pick, or show the verdict across all three. A CISO who can say "we are exposed under all three
scenarios" has a much stronger case than one quoting a number from a vendor's marketing page.

Default scenario set (customer-overridable):

| Scenario | Q-Day | Rationale |
|---|---|---|
| Conservative | 2030 | Aligns with NIST IR 8547 draft deprecation of 112-bit classical crypto `needs-check` |
| Central | 2035 | Aligns with the NIST draft "disallowed after" date and CNSA 2.0 end-state `needs-check` |
| Aggressive | 2040 | Slower-than-expected hardware scaling |

Note these are **regulatory** deadlines, not physics predictions — which is arguably the more
useful framing anyway, since compliance dates bind long before quantum computers do. Say so in
the UI.

---

## The second differentiator: crypto-agility

Nobody is selling this, and we can derive it from code we already parse.

Not *"is this vulnerable"* but ***"how hard is it to change?"***

An organisation with 200 RSA call sites behind a single crypto provider interface is in
dramatically better shape than one with 20 inlined across unrelated modules. Vulnerability
count says the opposite. **Agility score is a fundamentally different and more actionable
number.**

Approximation available today, without an AST:

- Cluster call sites by file, module, and import path
- Count distinct entry points vs total occurrences → `agility = 1 - (entrypoints / occurrences)`
- Detect wrapper patterns (a single `crypto/` or `security/` module owning all imports)
- Flag algorithm names appearing in config vs hardcoded in source — config is far more agile

This directly feeds **Y** in Mosca. A high-agility asset has a short migration time; a
low-agility one does not. That closes the loop between the two differentiators.

---

## Positioning

**Q-Vuln is the cryptographic asset inventory of record for post-quantum readiness.**

| We are | We are not |
|---|---|
| A discovery and inventory platform | A SAST tool |
| A compliance evidence generator | A remediation/ticketing system *(Phase 4)* |
| Continuous — inventory drifts | A one-shot audit report |
| Multi-surface | Source-code only |
| Interoperable — CBOM in and out | A data silo |

### Against the alternatives

| Alternative | Their weakness | Our answer |
|---|---|---|
| **Consultancy audit** (Big 4) | Point-in-time, six figures, stale on delivery | Continuous, drift-detecting, a fraction of the cost |
| **SAST vendor PQC rule pack** | Source code only — misses dependencies, TLS, certs, KMS | Multi-surface inventory; source is one collector of ten |
| **Certificate lifecycle managers** | Certs only; no code, no data-lifetime context | Certs are one surface; we compute Mosca across all |
| **Spreadsheet** (the real incumbent) | Manual, instantly stale, unauditable | Automated collection with provenance on every record |

**The incumbent is the spreadsheet.** Price and position against that, not against tools.

---

## What "good" looks like at 12 months

- A CISO exports a CycloneDX 1.7 CBOM and hands it to an auditor without editing it
- The inventory covers ≥5 surfaces, not just source code
- Every asset has a Mosca verdict with a defensible data-classification input
- Re-scans detect drift and alert on newly-introduced quantum-vulnerable crypto
- Two design-partner logos willing to be referenced

## What would falsify this thesis

Stated up front so we notice if it happens:

- Design partners consistently ask for remediation workflow before inventory breadth → the
  buyer is really the engineering org, and we should re-read the fork from the brainstorm
- CBOM export turns out to be something nobody consumes → interoperability is not the wedge
- Buyers will not share source code with a SaaS at all → we need an on-prem/agent model
  **first**, not as a later enterprise tier (see [08-security.md](08-security.md))

That third one is the most likely, and it is the biggest risk in this plan.
