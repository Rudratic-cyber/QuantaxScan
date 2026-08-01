# 09 — Open gap register

Every known gap in one place, with what closes it and what it blocks. Updated 2026-08-01.

Three families:

- **G-01…G-04** — standards still unverified
- **G-05…G-11** — detection quality, surfaced by the verification work
- **G-12…G-14** — platform and process

Severity is **for the enterprise product**, not for today's demo.

---

## Summary

| # | Gap | Severity | Blocked by | Closes |
|---|---|---|---|---|
| G-01 | CNSA 2.0 per-category timeline unverified | High | `nsa.gov` HTTP 403 | Human, 30 min |
| G-02 | PCI DSS §12.3.3 wording unverified | Medium | PCI SSC registration | Human, 30 min |
| G-03 | OMB M-23-02 submission format unknown | Medium | Not researched | Human, 2 h |
| G-04 | `controls.json` crosswalks all seeded | Low | Deliberate — C9 is P3 | Defer to C9 |
| G-05 | **Key size is never detected** | **Critical** | Design | B1 rework |
| G-06 | EdDSA not detected at all | High | Missing pattern | 1 line |
| G-07 | DSA mis-framed as a future problem | High | Mapping data (now fixed) | Reporting change |
| G-08 | SHA-1 rule is use-dependent; we alert blindly | Medium | Regex can't see context | Confidence + copy |
| G-09 | AES-ECB framed as a compliance violation | Medium | Wrong citation (now fixed) | Copy change |
| G-10 | Hygiene findings inflate the PQC risk score | High | `computeScanResult` | A4 |
| G-11 | No confidence score on findings | High | Design | A2 |
| G-12 | Security findings S1–S8 | Critical | Not started | See [08](08-security.md) |
| G-13 | `.env` tracked in git | Low now, High later | One command | 2 min |
| G-14 | No re-verification trigger for standards data | Medium | Process | Calendar + CI |
| G-15 | Observation model not aligned to SP 1800-38B data elements | Medium | Design | A2 |
| G-16 | Binary scanning deferred; NIST treats it as core | Medium | Roadmap call | Re-scope B10 |
| G-17 | Competitive framing understates the field | High | Wrong assumption | Marketing rewrite |
| G-18 | `package.json` says MIT, no LICENSE file exists | High | Two-line fix | Before any publication |
| G-19 | `attached_assets/` unaudited, 4 MB of Replit scraps | Medium | Nobody has looked | Delete or audit |

---

## G-05 — Key size is never detected `Critical`

**The most consequential gap in this register, and verification is what exposed it.**

NIST IR 8547's rules are keyed on **security strength**, not algorithm name:

| Security strength | Transition |
|---|---|
| 112 bits (RSA-2048, P-256) | Deprecated after 2030, disallowed after 2035 |
| ≥ 128 bits (RSA-3072+, P-384+) | Disallowed after 2035 |

The scanner detects the string `RSA`. It does not extract the modulus size. So **we cannot
determine which row of the table applies** — meaning we cannot correctly state whether an asset
faces a 2030 deprecation milestone or only the 2035 disallowance.

Right now `scanner.ts` emits `algorithm: "RSA"` with no `keySize`, and `RawObservation.keySize`
in the target model is optional. Every mapping that depends on security strength is currently
unresolvable.

**What closes it**

- Extract key size where the source makes it available (`RSA.generate(2048)`, `secp256r1`,
  `P-384`, cert `notAfter`/SPKI parsing)
- Where it is genuinely undeterminable, emit `keySize: null` and have the mapping engine return
  **both** candidate obligations, flagged as "key size undetermined — assumed 112-bit"
- Never silently pick one

**Blocks:** correct deadline reporting, therefore the certificate-expiry-vs-deadline chart
(Row 5 of [06](06-cisa-dashboard.md)), therefore the strongest visual in the product.

**Note:** collectors on other surfaces get this for free — a TLS handshake and an X.509
certificate both state key size explicitly. This is a source-code-collector limitation
specifically, and another argument for prioritising B3/B4.

---

## G-06 — EdDSA not detected `High`

Ed25519/Ed448 are quantum-vulnerable, appear explicitly in IR 8547 Table 2, and were added to
FIPS 186-5 as an approved algorithm — so they are in active new deployment. `VULNERABILITY_PATTERNS`
has no pattern for them.

**What closes it:** one entry in the pattern table (aliases already recorded in
`mappings/algorithms.json` under `eddsa`, tagged `detectionGap: true`).

**Cross-ref:** B1 in [03-features.md](03-features.md), not a mappings issue — the data is there,
the detection is not.

---

## G-07 — DSA mis-framed as a future problem `High`

`verified 2026-08-01` — FIPS 186-5 Appendix E:

> *"DSA is no longer approved for digital signature generation. DSA may be used to verify
> signatures generated prior to the implementation date of this standard."*

DSA has been **unapproved for signature generation since 2023-02-03**, independent of anything
quantum. Its specifications were removed from FIPS 186-5 entirely.

Today we report DSA alongside RSA/ECDSA as a PQC migration item with a 2035 horizon. That
understates it: a DSA signing site is **non-compliant now**, with no runway.

This also explains why DSA appears in no IR 8547 transition table — there was nothing left to
transition. My earlier seed data assumed the RSA dates transferred to DSA. They do not.

**What closes it:** reporting change — DSA findings surface as immediate compliance failures
with no deadline, in a different bucket from PQC migration items. Mapping data already fixed in
`algorithms.json` 0.3.0.

**Nuance:** verification of pre-2023 signatures is permitted legacy use, and the regex cannot
distinguish generation from verification. DSA findings need reduced confidence pending review.

---

## G-08 — SHA-1 rule is use-dependent `Medium`

`verified 2026-08-01` — SP 800-131A Rev 2 §9 gives **three different answers** depending on use:

| Use | Status |
|---|---|
| Digital signature generation | **Disallowed** (except where NIST protocol guidance allows) |
| Digital signature verification | **Legacy use** — allowed |
| Non-signature applications not requiring collision resistance | **Acceptable** |

So `HMAC-SHA1` — which does not depend on collision resistance — is **acceptable per NIST**. We
currently flag every SHA-1 occurrence identically as an alert. That is incorrect for a
meaningful share of real matches, and a knowledgeable reviewer will challenge it.

**What closes it:** confidence scoring plus copy that states which uses are disallowed rather
than asserting the algorithm is banned. Full resolution needs call-site context the regex does
not have — a candidate for the crypto-agility clustering work (D5).

---

## G-09 — AES-ECB framed as a compliance violation `Medium`

`verified 2026-08-01`. Two errors in the original seed, both now fixed in `algorithms.json`:

1. It cited **SP 800-38D**, which is the *GCM* specification (November 2007). The string "ECB"
   appears **zero times** in it.
2. ECB is defined in **SP 800-38A** as one of five **approved** confidentiality modes.

So "AES-ECB violates NIST SP 800-38D" — which is roughly what we would have printed — is a
**false compliance claim**. ECB's problem is that it lacks semantic security, which is a
best-practice concern, not a standards violation.

**What closes it:** report ECB as a best-practice finding, not a compliance finding. An auditor
will check the citation.

---

## G-10 — Hygiene findings inflate the PQC risk score `High`

Three of the seven detection patterns — MD5, SHA-1, AES-ECB — are **not quantum
vulnerabilities**. `computeScanResult()` counts them into the same severity totals and risk
score as RSA and ECDSA.

Observed in the live smoke test: a 10-line file scored **risk 100, 3 critical / 2 alert**, where
2 of the 5 findings had nothing to do with quantum computing.

A CISO presenting a post-quantum risk score inflated by MD5 findings will be corrected in the
room.

**What closes it:** A4 risk engine split. `algorithms.json` already carries `reportingNote` on
each hygiene entry; the engine must honour it and report a separate "classical hygiene" panel.

---

## G-11 — No confidence score on findings `High`

Every finding is presented as equally certain. `/\bRSA/i` matches prose, comments, variable
names and unrelated acronyms; `/\bDH\b/i` matches initials and `DHCP` often enough to matter.

An inventory whose findings cannot be filtered by evidence quality will not survive an audit.

**What closes it:** A2 collector interface — `RawObservation.confidence` is already in the target
design. Regex ≈ 0.7, TLS handshake ≈ 1.0.

---

## G-01 — CNSA 2.0 per-category timeline `High` `BLOCKED`

`nsa.gov` and `media.defense.gov` both return **HTTP 403** to automated fetches. Indicative
dates gathered from secondary sources (2025 support / 2030 equipment / 2033 custom-and-legacy)
are recorded in `frameworks.json` as `needs-check`.

The seed's single "~2033 end state" looks **wrong** — the real timeline is per-category and 2033
appears to apply only to custom applications and legacy equipment.

**What closes it:** a human opens the CNSA 2.0 FAQ (Ver 2.1, December 2024) at
`https://media.defense.gov/2022/Sep/07/2003071836/-1/-1/0/CSI_CNSA_2.0_FAQ_.PDF`, transcribes
the per-category table, and flips the entries to `verified`. Roughly 30 minutes.

**Blocks:** any US government or defence customer conversation. Do not show a CNSA figure to
anyone until this is done.

---

## G-02 — PCI DSS §12.3.3 wording `Medium` `BLOCKED`

Consistent across multiple independent secondary sources — mandatory since **2025-03-31**,
requiring a documented cryptographic inventory reviewed at least every 12 months — but the PCI
SSC primary document requires registration and was not opened.

This is potentially the **strongest commercial hook in the whole plan** for card-handling
customers, which is exactly why the wording needs to be exact.

**What closes it:** a human with a PCI SSC account confirms the wording and numbering in
v4.0.1, then a PCI-specific report template gets built.

---

## G-03 — OMB M-23-02 submission format `Medium`

The 2035 target is corroborated from a verified NIST source (IR 8547 §4 cites NSM-10). The
**submission template** — the thing that actually matters for a federal export — is unverified,
and will not be on a policy landing page.

**What closes it:** research the current reporting template; confirm whether M-23-02 is
superseded. ~2 hours. Only needed before pursuing a federal civilian customer.

---

## G-04 — `controls.json` crosswalks `Low` `DEFERRED`

Every entry is seeded, unverified. ISO 27001 and SOC 2 are paywalled; PCI is gated.

**This is deliberate.** C9 is `P3` and the file exists to settle the data shape. Verifying two of
five crosswalks would leave it mixed-confidence with no consumer. Verify when C9 is built, not
before.

---

## G-12 — Security findings S1–S8 `Critical` — **LIVE EXPOSURE**

Full detail in [08-security.md](08-security.md). Headline: no authentication anywhere,
share-link IDs from `Math.random()`, full customer source persisted, `cors({ origin: true })`
with credentials.

> **Escalated 2026-08-01.** The application is deployed at **https://quantaxscan.swotpam.com**
> with the unauthenticated API publicly reachable. `GET /api/projects` returns every project in
> the production database, including real internal names. `DELETE /api/projects/:id` is equally
> open. This is not a future risk — it is current.

**Blocks:** the first pilot with real customer data — and it now also needs an *immediate*
interim mitigation independent of the roadmap. Edge auth on `/api/*` is a minutes-long change
and should not wait for F1.

---

## G-13 — `.env` tracked in git `Low now, High later`

Currently holds only `API_BASE_URL`, so nothing has leaked. But `.gitignore` does not cover
`.env`, and the code already references `DATABASE_URL`, `GITHUB_TOKEN` and
`AI_INTEGRATIONS_OPENAI_API_KEY`.

**What closes it:** add `.env` to `.gitignore`, `git rm --cached .env`, keep `.env.example`, add
a pre-commit secret scanner. Two minutes, and free right now — it stops being free the moment
someone adds a real secret.

---

## G-14 — No re-verification trigger `Medium`

Standards data decays and nothing currently prompts a re-check. IR 8547 is a **draft** that will
presumably be finalised, at which point every date in the system needs revisiting and the
"draft guidance" labels need removing.

**What closes it:**

- Quarterly re-verification task in the content calendar *(already added for marketing —
  extend to `mappings/`)*
- CI check failing when any `retrievedAt` is older than 180 days
- Immediate trigger on: IR 8547 going final, a new FIPS publication, a CycloneDX release, a
  CNSA 2.0 revision

---

## G-15 — Observation model not aligned to SP 1800-38B `Medium`

NIST SP 1800-38B §4.1.4 defines descriptive data elements for normalised discovery output,
including **CPE 2.3** (NIST IR 7695) for application software, operating system and device
vendor, and IANA Service Names / TLS ALPN IDs for application-layer protocol.

Our `locationDetail` is freeform `jsonb`. Free-text software identification cannot be joined
against anything the customer already runs.

**What closes it:** named fields on network-surface assets, CPE 2.3 for software/OS/vendor, and
the discovery **modality** (passive capture / active scan / endpoint monitoring / configuration)
carried on the observation alongside numeric confidence.

**Why bother:** the same reason as CBOM export — interoperability over a private schema. CPE
gives a join key into vulnerability tooling the customer already owns.

---

## G-16 — Binary scanning deferred, but NIST treats it as core `Medium`

We have B10 (binaries/firmware) as `deferred`, `P3`, on the grounds that it is hard.

SP 1800-38B §4.1.2 places binary scanning inside the core *Operational Systems and Applications*
domain, specifically to find *"algorithms that there might not be a source code for, as, for
example, in third-party"* components.

That is the same argument we already make for prioritising the dependency collector — most
enterprise crypto is not in your source. Binaries are where it lives when there is no manifest
to parse either.

**What closes it:** a roadmap decision, not code. Either re-scope B10 upward, or write down why
we are deliberately diverging from the NIST discovery architecture. Either is defensible;
silence is not.

---

## G-17 — Competitive framing understates the field `High`

[marketing/01-positioning.md](marketing/01-positioning.md) says *"The incumbent is a
spreadsheet"* and frames competitors as consultancies, SAST vendors and certificate managers.

SP 1800-38B §5.1 lists the technology collaborators who contributed **cryptographic discovery
tools** to the NCCoE lab:

> Cisco · IBM · Infosec Global · ISARA · Keyfactor · Microsoft · SafeLogic · Samsung SDS ·
> SandboxAQ · wolfSSL

These are direct competitors in precisely this category, several with NIST-convened credibility
we do not have. "The incumbent is a spreadsheet" is true for the *median* enterprise but false
as a statement about the market, and any buyer who has read SP 1800-38 will know it.

**What closes it:** rewrite the competitive section honestly. The differentiators that survive
contact with this list are the ones grounded in specifics — Mosca risk arithmetic tied to data
retention, crypto-agility scoring, and honest coverage reporting — not "nobody else is doing
this."

**Also worth noting:** Appendix C's eight-use-case functional demonstration plan is a plausible
buyer evaluation rubric. Treat it as an acceptance-test suite for our collectors.

---

## G-18 — Licensing conflict `High`

`package.json` declares `"license": "MIT"`. There is **no LICENSE file** in the repository.

The repo is private today so nothing has been granted to anyone. But if it is published as-is,
that manifest declaration is what governs — **MIT over the entire workspace**, including
anything intended to ship as Enterprise. MIT permits unrestricted commercial redistribution.

**What closes it:** set the root manifest to the intended licence, add LICENSE files per tier,
add `mappings/LICENSE` for CC BY 4.0. See [10-editions.md](10-editions.md#licensing--three-separate-decisions).

**Do it now** — it is two lines while the repo is private and a genuine mess afterwards.

---

## G-19 — `attached_assets/` unaudited `Medium`

Roughly 4 MB of Replit screenshots and pasted-text scraps in the repo root. **Nobody has
reviewed them** for credentials, internal URLs, customer data, or third-party copyrighted
content.

Invisible while the repo is private; permanent and indexable once it is not.

**What closes it:** delete the directory. It is development detritus with no ongoing value, and
deleting is cheaper than auditing 20+ images. Note this does **not** remove it from git history
— see Gate 2 in [10-editions.md](10-editions.md#publication-gates--hard-blockers).

---

## Suggested order

1. **G-13, G-18** — minutes each, and both are free only while the repo is private
2. **G-17** — the positioning is wrong *now*, and it is a document edit
3. **G-06** — one pattern, closes a real detection hole
4. **G-01** — 30 minutes, unblocks a whole customer segment
5. **G-16** — a roadmap decision to make before committing to A2's surface priorities
6. **G-05, G-10, G-11, G-15** — land together with A2/A4; they are the same refactor
7. **G-07, G-08, G-09** — reporting/copy changes, cheap once A4 exists
8. **G-12, G-19** — before any pilot, and hard gates on open-sourcing
9. **G-14** — process, set up once
10. **G-02, G-03** — when the relevant customer segment is actually in play
11. **G-04** — with C9

### Read SP 1800-38 properly before starting the A2 refactor

Volume B is the NIST practice guide for our exact product category and we found it late. Before
building the collector interface, someone should read it end to end — the architecture (§4),
the normalisation scheme (§4.1.4) and the eight-use-case test plan (Appendix C). It is the
closest thing to a specification that exists for this product, and a buyer may evaluate us
against it.

---

## What this register demonstrates

Six of these fourteen gaps (**G-05, G-07, G-08, G-09**, plus the FIPS 206 and CycloneDX version
errors already corrected) were invisible until the standards data was checked against primary
sources. Four of them would have produced **incorrect statements in a customer-facing report**.

That is the argument for the `verified` / `needs-check` discipline, and it is also the argument
for the product itself: this is precisely the class of error a cryptographic inventory is
supposed to catch, and we found ours by doing to our own data what we propose to do to
customers'.
