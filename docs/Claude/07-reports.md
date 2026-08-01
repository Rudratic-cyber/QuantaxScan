# 07 — Reports

**The report is the product.** The dashboard is how the customer checks their work; the report
is what they hand to someone who can hurt them. Design for the second audience.

Four reports, one per audience. Current state: `routes/reports.ts` is 46 lines and produces a
shareable scan link — a good primitive, not yet any of these.

---

## E1 — Board / executive pack `P1`

**Audience:** board, audit committee, CFO. **Length:** 1 page + 3 appendix pages.
**Reader has:** four minutes and no cryptography background.

Must answer exactly four questions:

1. **Are we exposed?** One sentence, plain English, no jargon.
2. **How badly, and by when?** The Mosca verdict across three scenarios.
3. **What is it going to cost?** Effort hours → currency, with the assumed rate stated.
4. **Are we on track?** Trend against last quarter.

Rules:
- No algorithm names on page 1. "Encryption that quantum computers will break" beats "ECDH".
- Every number stated with its assumption inline. `$2.1M (at £95/hr blended, 14,200 est. hours)`
- **Include the coverage gap on page 1.** "This covers 31% of estimated estate" is the honest
  framing and it is also how the CISO gets budget for the other 69%.
- Trend arrows require ≥2 collection runs — until then, say "baseline", not "0% change".

The existing `generateExecutiveSummary()` in `scanner.ts` is the seed of this, but it currently
describes *a scan* ("We scanned 10 lines of python code"). Rewrite it to describe *the estate*.

---

## E2 — Regulator / auditor inventory submission `P1`

**Audience:** an auditor who will try to find holes. **Length:** as long as it takes.

This is the artifact that justifies the price. Requirements:

| Requirement | Why |
|---|---|
| Every asset carries provenance — collector, version, timestamp, confidence | "Says who?" must have an answer |
| Every compliance claim carries a citation with retrieval date | See [05](05-compliance-mapping.md#provenance-and-freshness) |
| Mapping `dataVersion` pinned in the document header | Report must be reproducible in 2 years |
| Coverage limitations stated **prominently**, not in a footnote | Undisclosed gaps are the finding that sinks an audit |
| Waivers listed with owner, justification, expiry, approver | Exceptions are normal; undocumented exceptions are not |
| Methodology appendix — how detection works, what its limits are | Regex has false positives; say so before they find one |
| Immutable, versioned, signed | A report that can be silently edited is not evidence |

**Only `verified` mappings may appear here.** Anything `needs-check` renders as "indicative,
pending verification" or is omitted. This is enforced in CI.

For US federal customers this doubles as the OMB M-23-02 / NSM-10 annual submission — but the
required format must be verified before we claim conformance (see `frameworks.json`).

---

## E3 — CBOM export `P0` — **build this first**

**Audience:** other tools, and auditors' tooling.

CycloneDX 1.7 cryptographic BOM. `needs-check`: confirm the current spec version.

Why it is P0 despite being the least glamorous:

- It is **cheap** — a serialiser over the asset model
- It **externally validates the asset model** — if our data does not fit CycloneDX, our model is
  wrong, and it is much better to learn that now than after the schema has customer data in it
- It makes us a **hub rather than a silo** — we can import what they already have (A6)
- It is what the ecosystem actually consumes

**Acceptance:** output validates against the official CycloneDX JSON schema; round-trips through
import without loss; includes provenance for every component.

---

## E4 — Technical remediation backlog `P2`

**Audience:** the engineering team who will do the work.

Prioritised, grouped by **crypto-agility cluster** rather than by file — because fixing one
wrapper module resolves 40 findings, and a flat list of 40 findings hides that entirely. This is
where the agility score pays off operationally.

Per item: asset, evidence, target algorithm + parameter set, effort estimate, owner, wave,
dependencies (e.g. "blocked until vendor X ships PQC support").

Deliberately **not** a ticket integration yet — export CSV/JSON and let them import. Ticket sync
is F8, `deferred`.

---

## E5 — Vendor assessment pack `P3`

Outbound questionnaire + inbound response tracking for CISA roadmap stage 4. Low priority until
the vendor collector (B9) exists.

---

## E6 — Scheduled delivery `P2`

Quarterly board pack, monthly technical backlog, annual regulator submission — generated and
emailed on a schedule. Pairs with drift alerting.

---

## Cross-cutting requirements

### Reproducibility

Every report records, in its header:

```
Generated:        2026-08-01T14:32:00Z
Inventory as of:  2026-08-01T12:00:00Z
Mapping version:  1.4.2
Q-Day scenario:   central (2035)
Collectors:       source-regex@2.1.0, dependency@1.0.3, tls@1.1.0
Coverage:         31% (7 of 10 surfaces unconfigured — see §4)
```

Without this a report is an opinion. With it, it is evidence.

### Assumption marking

Any value the customer did not supply renders visibly as an assumption. Default data
classifications, blended hourly rates, Q-Day scenarios — all defaults, all marked. A report full
of unmarked vendor defaults presented as customer facts is how trust gets destroyed.

### Rendering

HTML source of truth → PDF via headless Chrome (already a dependency of the dev environment).
Do not build two renderers.

**Note on the existing share feature:** `routes/reports.ts` creates public shareable report
links. Before this handles real inventory data, it needs authentication, expiry, and revocation
— an unauthenticated URL exposing an enterprise's complete cryptographic weaknesses is close to
a worst-case data leak for this product category. See
[08-security.md](08-security.md#shared-report-links).
