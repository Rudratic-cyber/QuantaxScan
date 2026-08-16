# 07 — Reports

**The report is the product.** The dashboard is how the customer checks their work; the report
is what they hand to someone who can hurt them. Design for the second audience.

Four reports, one per audience. Current state: `routes/reports.ts` is 46 lines and produces a
shareable scan link — a good primitive, not yet any of these.

---

## E1 — Board / executive pack `P1` — **built 2026-08-16**

`GET /api/report-packs/board`, `.html`, `.pdf`. Computed by
`artifacts/api-server/src/lib/board-pack.ts` over `report-common.ts`, both pure and drizzle-free
like their siblings; the route does one `withOrg` read with one `now`.

**Not `/reports/board`.** `PUBLIC_ROUTES` matches the share link with `/^\/reports\/[^/]+$/`, so a
pack under that prefix would have been served to anonymous callers — a complete map of an
organisation's cryptographic weaknesses, with no credential. The prefix is different so that
cannot happen by accident. `tests/e2e/21-report-packs.spec.ts` asserts the near-miss stays one.

**One deviation from the spec below, deliberate.** "Include the coverage gap on page 1 — *this
covers 31% of estimated estate*" cannot be honoured as written: `coverage.ts` rule 4 says the
denominator is surfaces, not assets, and nothing this product holds supports a figure for how much
cryptography sits in an unexamined surface. `estateFraction` is therefore a field that is always
`null`, alongside `estateFractionReason`; the gap is on page one, stated as surfaces examined out
of the collector catalogue. A null with a reason is what stops the next person filling it in.

The rest is honoured: no algorithm name reaches page one (`page1.coverage` is the coverage block
minus `unmappedAlgorithms`, and `board-pack.test.ts` asserts it against every algorithm the input
holds — plus the complement, so dropping the names everywhere fails too); every number carries its
assumption inline; the trend says `baseline`, never `0% change`, until two distinct collection
instants exist. The assumption register rides in Appendix C so page one stays one page.

`generateExecutiveSummary()` in `scanner.ts` is untouched — it is a *scan* summary and still
correct as one. This pack describes the estate and does not call it.

---

## E1 — the original design

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

## E2 — Regulator / auditor inventory submission `P1` — **built 2026-08-16**

`GET /api/report-packs/regulator`, `.html`, `.pdf`, computed by
`artifacts/api-server/src/lib/regulator-submission.ts`. Each row of the requirements table below
is a field rather than a paragraph a renderer might forget: `inventory[].provenance`,
`inventory[].obligations[].citation`, `header.mappingDataVersion`, `coverageLimitations` (before
the inventory in the payload as well as in the rendering), `exceptions`, `methodology`,
`integrity`.

**One of the seven is answered by an honest refusal, and that is why it is a field.**

- **Waivers — answered by data since C8 merged, and worth reading as a cautionary tale.** This
  block used to read `exceptions.registerAvailable: false` with a statement that no exception
  carried an owner, justification, expiry or approver, because the register genuinely did not
  exist. E2 and C8 were built in parallel lanes on the same night. **When both landed, nothing
  failed** — a regulator-facing document went on asserting the absence of a feature the product
  ships, and no suite in the repository could see it. It was caught by a human reading two lanes'
  reports side by side, which is not a control.

  It now carries `waivers` — the register's entries, each with a justification, a signatory, a
  sign-off date and an expiry — and `statusWaivedWithoutRegisterEntry` separately, for assets
  carrying the inventory's older `waived` status with nothing behind it. Those two lists stay
  apart because merging them would present four missing fields as present. Two limits are stated
  rather than implied: the register records **one signatory, not a separate owner and approver**,
  and `attribution` distinguishes a signature made by an authenticated user from a name asserted
  through the shared API key — a distinction a printed page loses unless it is said.

  The submission also states in terms that a waiver suppresses nothing: every waived asset appears
  in the inventory, and no coverage, readiness or risk figure in the document is computed with any
  knowledge that a waiver exists.
- **Signed.** `integrity.signed` is `false`. There is a SHA-256 content digest over the document,
  and the statement beside it says a digest detects alteration against a value you already hold
  and proves nothing about origin. Calling an unsigned document signed is the first thing an
  auditor checks.

The `verified`-only rule is enforced structurally rather than by a filter a renderer must
remember: `obligations` carries `verified` claims and `indicativeObligations` carries the rest,
they are never merged, and `regulator-submission.test.ts` asserts the split is exhaustive — every
obligation the engine resolved lands in exactly one list, so nothing is silently dropped.

---

## E2 — the original design

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

CycloneDX 1.7 cryptographic BOM. `verified 2026-08-13` — 1.7 released 2025-10-21, confirmed
against the specification repository's release list; the schema is vendored under
`lib/cbom/schema/`. Export is built (A5); import (A6) is not.

Why it is P0 despite being the least glamorous:

- It is **cheap** — a serialiser over the asset model
- It **externally validates the asset model** — if our data does not fit CycloneDX, our model is
  wrong, and it is much better to learn that now than after the schema has customer data in it
- It makes us a **hub rather than a silo** — we can import what they already have (A6)
- It is what the ecosystem actually consumes

**Acceptance:** output validates against the official CycloneDX JSON schema ✅ (vendored 1.7
schema + ajv, `lib/cbom/src/build-cbom.test.ts`); round-trips through import without loss ⬜
(needs A6); includes provenance for every component ✅ (each crypto component carries its
`quantaxscan:asset:*` surface, status, fingerprint and first/last-seen properties, plus an
`evidence.occurrences` entry for its stable locator).

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

**Built as described.** `artifacts/api-server/src/lib/report-html.ts` is the one renderer; the
`.pdf` routes print exactly the markup the `.html` routes serve, so a defect visible in one is
visible in the other. The markup is dependency-free and inline-styled with no external stylesheet,
script, font or image — a report is evidence and has to render from a saved file with no network,
years later. Everything interpolated is escaped: asset locations are attacker-controllable and
this markup reaches both a browser and headless Chromium.

`playwright-core` is an api-server dependency (it ships no browser, unlike `playwright`, which
would download ~150 MB on every install in every worktree) and is imported dynamically, so a
deployment with no Chromium still starts and the `.pdf` routes answer **503 naming the `.html`
route** rather than 500. `Dockerfile.api` installs no browser today; `QUANTAXSCAN_CHROMIUM_PATH`
points at one when it does.

**Note on the existing share feature:** `routes/reports.ts` creates public shareable report
links. Before this handles real inventory data, it needs authentication, expiry, and revocation
— an unauthenticated URL exposing an enterprise's complete cryptographic weaknesses is close to
a worst-case data leak for this product category. See
[08-security.md](08-security.md#shared-report-links).
