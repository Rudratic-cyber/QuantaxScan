# 06 — CISA quantum-readiness dashboard

## Why mirror the CISA factsheet

`verified 2026-08-16` against the joint CISA/NSA/NIST factsheet *"Quantum-Readiness: Migration
to Post-Quantum Cryptography"*, dated **As of August 17, 2023**, TLP:CLEAR. Re-read in full that
day (all seven sections, every bullet) via the NCCoE-hosted copy — `cisa.gov` still returns
HTTP 403 to automated fetches.

> **The machine-readable form of the table below is `CISA-QR.roadmapAlignment` in
> [mappings/frameworks.json](mappings/frameworks.json), added by C6 on 2026-08-16.** That block is
> the authority; this table is its prose summary and must not drift from it. It carries all seven
> named sections (this table lists the five with a product role) and a three-valued `productRole`,
> so "we evidence this" cannot be rendered as "we do this".

> ⚠️ **Correction to earlier drafts of this document.** The factsheet does **not** define a
> numbered five-stage roadmap. An earlier version of this file invented one. The factsheet is
> organised into named sections, listed below. Never present numbered stages as a CISA
> quotation — a buyer who has read the source will catch it.

Structuring the dashboard around **the buyer's own reference document** rather than around our
data model means a CISO can point at it in a board meeting and say *"this is the CISA guidance,
and here is where we are against it."* That is worth more than any chart we could invent.

| Factsheet section | Who does it | Our role | `productRole` |
|---|---|---|---|
| Why prepare now? | Customer | Exposure evidence (A3 secrecy lifetime, Mosca) | `evidenced` |
| Establish a quantum-readiness roadmap | Customer | Evidence + template | `customer-process` |
| **Prepare a cryptographic inventory** | **QuantaXscan** | **Automated** | `automated` |
| Discuss post-quantum roadmaps with technology vendors | Customer, tracked in QuantaXscan | Vendor register (B9) | `evidenced` |
| Supply chain quantum-readiness | Customer, tracked in QuantaXscan | Vendor + dependency collectors | `evidenced` |
| Technology vendor responsibilities | Vendors | Out of scope | `context` |

(BACKGROUND is framing with no product claim — `context` — and is omitted here for the same
reason. It is present in `roadmapAlignment` so the seven sections are complete there.)

### Two things the factsheet says that directly validate this design

**On coverage gaps** — CISA states plainly that tools have blind spots:

> *"Discovery tools may not be able to identify embedded cryptography used internally within
> products, hindering discoverability or documentation. Organizations should ask vendors for
> lists of embedded cryptography within their products."*

That is primary-source justification for the coverage panel (D3). We are not being unusually
humble; we are reflecting what the guidance already says.

**On data lifetime** — the factsheet asks for exactly the X input Mosca needs. Under
**PREPARE A CRYPTOGRAPHIC INVENTORY**:

> *"Organizations should include in their inventory when and where quantum-vulnerable
> cryptography is being leveraged to protect the most sensitive and critical datasets and
> include estimates on length of protection for these datasets."*

and — **corrected 2026-08-16** — under **SUPPLY CHAIN QUANTUM-READINESS**, not the inventory
section where this file previously grouped it:

> *"Prioritization should be given to high impact systems, industrial control systems (ICSs),
> and systems with long-term confidentiality/secrecy needs."*

Cite these when a buyer asks why we require a data classification. It is not our invention — but
cite each to the section it is actually printed under. A buyer who opens the factsheet checks the
heading first, and secrecy lifetime is only one of the three prioritisation axes that second quote
names.

### The three named discovery targets

The factsheet names exactly three places discovery tools should look. Our collector roadmap
should map onto them explicitly, because this is the checklist an auditor will use:

| CISA target | Our collector |
|---|---|
| Network protocols | B3 TLS prober, B6 protocol config |
| Assets on end user systems and servers, including applications and associated libraries | B1 source, B2 dependencies |
| Cryptographic code or dependencies in the CI/CD pipeline | B1, B2 |

---

## Layout

### Row 1 — Readiness posture

A tracker across the factsheet's sections, each showing percent complete with a real definition
behind it (not a vibe):

| Section | "Complete" means |
|---|---|
| Roadmap | A roadmap document is attached and dated within 12 months |
| Cryptographic inventory | ≥N surfaces collected, last collection within SLA, coverage gaps acknowledged |
| Prioritisation | Every asset has a data classification and a Mosca verdict |
| Vendor engagement | Every third-party in the register has a recorded PQC position and a review date |
| Supply chain | Dependency coverage above threshold; COTS and cloud providers assessed |

Label this **"aligned to CISA/NSA/NIST quantum-readiness guidance (August 2023)"** — not
"CISA stages", which would imply a numbering the source does not use.

### Row 2 — Mosca exposure

The headline. Three columns, one per Q-Day scenario:

```
   CONSERVATIVE (2030)     CENTRAL (2035)      AGGRESSIVE (2040)
   847 assets breach       312 assets breach   96 assets breach
   ▓▓▓▓▓▓▓▓░░ 68%          ▓▓▓░░░░░░░ 25%      ▓░░░░░░░░░ 8%
```

Clicking a scenario re-scores the whole page. **Do not pick one scenario for the customer** —
a CISO who can say "we are exposed under all three" has a stronger case than one quoting a
vendor's number, and we cannot defend a single date. State plainly that these are regulatory
deadlines, not physics predictions.

### Row 3 — Coverage and confidence *(the most important panel)*

**What we have not looked at**, given equal visual weight to what we found.

```
SURFACE COVERAGE
  Source code        ████████░░  8 of 10 repos      last: 2h ago
  Dependencies       ██████░░░░  6 of 10 repos      last: 2h ago
  TLS endpoints      ███░░░░░░░  42 of ~300 hosts   last: 3d ago
  Certificates       ░░░░░░░░░░  NOT CONFIGURED     ⚠ blind spot
  Key stores         ░░░░░░░░░░  NOT CONFIGURED     ⚠ blind spot
  Data at rest       ░░░░░░░░░░  NOT CONFIGURED     ⚠ blind spot
  OT / embedded      ░░░░░░░░░░  NOT CONFIGURED     ⚠ longest lead time
  Vendors            ██░░░░░░░░  3 of 40 assessed

  Estimated inventory completeness: 31%
```

Most security dashboards show only what they found, silently implying complete coverage. For an
inventory product that omission is **credibility-destroying** — the CISO presents our report,
the auditor asks "does this include the mainframe?", and the answer must already be on the page.

The honest version is also the more sellable one: every grey bar is next quarter's budget ask,
stated in the customer's own language.

### Row 4 — Inventory breakdown

Filterable asset table — by surface, algorithm, status, owner, risk, confidence. This is where
the existing algorithm-breakdown chart belongs, but sourced from `assets` rather than per-scan
findings, and **excluding classical-hygiene findings** (MD5, SHA-1, AES-ECB) from PQC risk
totals.

> Those three are currently 3 of the 7 detection patterns and they are **not quantum
> vulnerabilities**. Counting them in a post-quantum risk score inflates it and a knowledgeable
> buyer will notice immediately. Report them in a separate "classical hygiene" panel — still
> useful, honestly labelled. `algorithms.json` already carries a `reportingNote` for this.

### Row 5 — Time pressure

Two charts that make the abstract concrete:

1. **Certificate expiry vs Q-Day** — a timeline with certs plotted by `notAfter` against
   scenario lines. Certificates whose validity extends past the conservative Q-Day are
   highlighted: *"this cert will still be live when its crypto is broken."*
2. **Deprecation runway** — assets bucketed by their NIST IR 8547 deadline, showing how many
   renewal/refresh cycles remain. For OT assets with 10-year refresh cycles this is often
   **zero or negative**, which is exactly the point.

### Row 6 — Drift

New / changed / resolved since last collection. An inventory that does not detect newly
introduced RSA is a report, not an inventory.

---

## Design notes

**Restraint.** The current UI is heavy — animated galaxy canvas, particles, typewriter, intro
splash. That works for the marketing site and demos. It works against a dashboard a CISO will
screenshot into a board deck. Give the CISO surface a quieter mode: no animation, high contrast,
print/PDF-safe, legible at 50% zoom on a projector.

Suggest keeping the existing theme for `/` and `/scan`, and a calmer variant for `/dashboard`
and reports. Same brand, different register.

**Every number is clickable.** "847 assets breach" must drill to the list, then to an asset,
then to the observation and its evidence. A CISO gets challenged on numbers and needs to be able
to defend any figure in under 30 seconds.

**Show the inputs, not just the output.** Beside every Mosca verdict, show X, Y and Z with their
sources — and mark defaults as assumptions. `X = 25 years (default for "Regulated" — not
confirmed by asset owner)` is far more trustworthy than a bare score, and it prompts the
customer to fix their own data.

**Empty states are a feature.** Before collectors are configured, this dashboard is mostly grey
bars. That is a correct and useful state — it should read as a configuration checklist, not as a
broken page.

---

## API dependencies

| Panel | Endpoint |
|---|---|
| Readiness posture | `GET /api/compliance/readiness` |
| Mosca exposure | `GET /api/inventory/assets?groupBy=moscaVerdict` |
| Coverage | `GET /api/inventory/coverage` |
| Inventory table | `GET /api/inventory/assets` |
| Cert expiry | `GET /api/inventory/assets?surface=certificate` |
| Drift | `GET /api/drift?since=` |

All defined in [04-architecture.md](04-architecture.md#api-surface-changes).
