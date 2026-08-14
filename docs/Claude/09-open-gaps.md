# 09 — Open gap register

Every known gap in one place, with what closes it and what it blocks. Updated 2026-08-14.

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
| G-05 | **Key size is never detected** | **Critical, partially closed** | Design | B1 rework — model + source extraction landed. Neither A4 nor C1 closed the deadline half: A4 keys on `quantumVulnerable`, which needs no key size, and C1 returns both IR 8547 rows **without** marking either an assumption. The "key size undetermined — assumed 112-bit" label is still unwritten |
| ~~G-06~~ | ~~EdDSA not detected at all~~ | **Closed** | Pattern added 2026-08-13 (B2) | — |
| ~~G-07~~ | ~~DSA mis-framed as a future problem~~ | **Closed** | Done 2026-08-14 (C1) | — |
| ~~G-08~~ | ~~SHA-1 rule is use-dependent; we alert blindly~~ | **Closed** | Done 2026-08-14 (C1) | — |
| ~~G-09~~ | ~~AES-ECB framed as a compliance violation~~ | **Closed** | Done 2026-08-14 (C1) | — |
| ~~G-10~~ | ~~Hygiene findings inflate the PQC risk score~~ | **Closed** | Done 2026-08-14 (A4) | — |
| G-11 | No confidence score on findings | High, partially closed | Design | A2 — carried on `observations`; no UI/report consumer yet |
| G-12 | Security findings S1–S8 | High | Interim auth + org scoping shipped; needs deploy | See [08](08-security.md), [13](13-auth-and-tenancy.md) |
| ~~G-13~~ | ~~`.env` tracked in git~~ | **Closed** | Done 2026-08-03 | — |
| G-14 | No re-verification trigger for standards data | Medium | Process | Calendar + CI |
| G-15 | Observation model not aligned to SP 1800-38B data elements | Medium, partially closed | Design | A2 — profile + modality landed; no network collector populates it |
| G-16 | Binary scanning deferred; NIST treats it as core | Medium | Roadmap call | Re-scope B10 |
| G-17 | Competitive framing understates the field | High | Wrong assumption | Marketing rewrite |
| G-18 | `package.json` says MIT, no LICENSE file exists | High | Two-line fix | Before any publication |
| G-19 | `attached_assets/` unaudited, 4 MB of Replit scraps | Medium | Nobody has looked | Delete or audit |

---

## G-05 — Key size is never detected `Critical, partially closed`

**The most consequential gap in this register, and verification is what exposed it.**

> **Update, 2026-08-02 (A1/A2).** `RawObservation.keySize` and `assets.keySize`/
> `observations.evidence.keySize` now exist and are exercised end to end
> (`lib/collectors/src/source-regex-collector.ts`'s `extractKeySizeFromLine`,
> `lib/db/src/schema/asset-model.test.ts`). `SourceRegexCollector` extracts a literal modulus
> size or a named curve's bit size **when it appears on the same line as the matched
> algorithm** — `RSA.generate(2048)`, `elliptic.P384()`, `createECDH('secp256k1')` all resolve;
> `RSA.generate(bits)` (a variable) or a constant defined on a different line do not, and
> correctly stay `keySize: null` rather than defaulting to anything. Which *kind* of literal
> counts is gated on the matched algorithm: a curve name is only a key size for the EC
> algorithms, and a modulus only for RSA/DSA. A line naming both — e.g. an SSH preferred-key
> list `["rsa-sha2-256", "ecdsa-sha2-nistp256"]` — must not report the curve as the RSA key's
> size; a wrong value here is worse than `null`, because A4 will key security strength off it.
> **What this does not close:**
> this is a regex/line-based detector, not a parser — it cannot fold constants or read
> cross-line context, so most real code (like the pattern above) still resolves to
> undetermined. C1 (built 2026-08-13) now returns **both** IR 8547 rows as separate obligations
> and does not choose between them, so the two candidates are at least visible; what is still
> missing is the explicit "key size undetermined — assumed 112-bit" flag and A4 consuming it. The
> register's
> severity stays `Critical` because the customer-facing consequence (correct deadline reporting)
> is still unresolved; what changed is that the model can now carry the fact when a collector
> does determine it, instead of the field not existing.

NIST IR 8547's rules are keyed on **security strength**, not algorithm name:

| Security strength | Transition |
|---|---|
| 112 bits (RSA-2048, P-256) | Deprecated after 2030, disallowed after 2035 |
| ≥ 128 bits (RSA-3072+, P-384+) | Disallowed after 2035 |

The original diagnosis: the scanner detects the string `RSA` and does not extract the modulus
size, so **we cannot determine which row of the table applies** — meaning we cannot correctly
state whether an asset faces a 2030 deprecation milestone or only the 2035 disallowance.

Before A1/A2, `scanner.ts` emitted `algorithm: "RSA"` with no `keySize` field at all. The field
now exists and is populated same-line (see the update above), but `keySize` is optional by
design, so every mapping that depends on security strength must still handle `null` — and
nothing resolves it yet.

**What closes it**

- ✅ Extract key size where the source makes it available same-line (`RSA.generate(2048)`,
  `secp256r1`, `P-384`) — done for the source collector. ⬜ Cert `notAfter`/SPKI parsing needs B4,
  not built.
- ⬜ Where it is genuinely undeterminable, emit `keySize: null` and have the mapping engine
  return **both** candidate obligations, flagged as "key size undetermined — assumed 112-bit" —
  the model carries `null` through persistence and read-back (tested), and C1 returns both
  candidate obligations — but neither is labelled as an assumption, and A4 does not consume them
  yet.
- ✅ Never silently pick one — the ingestion boundary converts `undefined` → `null` explicitly;
  there is no code path that defaults a missing `keySize` to a number.
- ✅ **The export boundary now has the same rule, and states the gap rather than hiding it.**
  A5's CycloneDX exporter (`lib/cbom`) emits **no** numeric field for `keySize: null` — no
  `parameterSetIdentifier`, no `relatedCryptoMaterialProperties.size` — and names the component
  `RSA`, not `RSA-2048`. Because a missing optional field is indistinguishable from an exporter
  that never considered key size, every crypto component additionally carries
  `quantaxscan:asset:keySize`, valued either with the digits or with the literal `undetermined`.
  That is the decision this gap forces on any consumer-facing serialisation: **absence must be
  explicit**. `classicalSecurityLevel` and `nistQuantumSecurityLevel` are never populated —
  deriving a security strength from a key size is A4's call, and doing it in a serialiser is this
  gap's forbidden default wearing a different name. Asserted in
  `lib/cbom/src/build-cbom.test.ts` and again over the HTTP response in
  `artifacts/api-server/src/api-feature.test.ts`.

**Blocks:** correct deadline reporting, therefore the certificate-expiry-vs-deadline chart
(Row 5 of [06](06-cisa-dashboard.md)), therefore the strongest visual in the product.

**Note:** collectors on other surfaces get this for free — a TLS handshake and an X.509
certificate both state key size explicitly. This is a source-code-collector limitation
specifically, and another argument for prioritising B3/B4.

---

## G-06 — EdDSA not detected `Closed 2026-08-13`

Ed25519/Ed448 are quantum-vulnerable, appear explicitly in IR 8547 Table 2, and were added to
FIPS 186-5 as an approved algorithm — so they are in active new deployment. `SOURCE_PATTERNS`
(`lib/collectors/src/source-regex-collector.ts`, formerly `scanner.ts`'s `VULNERABILITY_PATTERNS`)
had no pattern for them.

**Closed by** an eighth `SOURCE_PATTERNS` entry, `/\b(EdDSA|Ed25519|Ed448)/i`, placed after
ECDSA and before ECDH/DH. Two things this exposed that "one line" understated:

- The rest of the plumbing existed but was **unreachable**: `KEY_SIZE_SOURCE` already had
  `EdDSA: "curve"` and the curve table already had `ed25519`/`ed448`, yet with no pattern
  emitting the algorithm neither entry could ever fire. Ed25519 → 256 and Ed448 → 448 are now
  asserted (`source-regex-collector.test.ts`).
- The pattern must **not** match `X25519`/`Curve25519`: those are Diffie-Hellman key agreement
  and belong to the `ECDH/DH` entry. A bare `25519` alternative would have silently
  reclassified them as signatures.
- `algorithms.json`'s `eddsa` entry has had its `detectionGap: true` flag cleared, and its
  `explanation` no longer tells the customer we cannot detect it (mappings `dataVersion 0.3.1`).

**Still true:** one finding per line means a line naming both `ssh-rsa` and `ssh-ed25519`
reports RSA only. That is a parser problem, not a pattern problem — tested and documented
rather than papered over.

**Cross-ref:** B1 in [03-features.md](03-features.md), not a mappings issue — the data was
there, the detection was not.

---

## G-07 — DSA mis-framed as a future problem `Closed 2026-08-13`

`verified 2026-08-01` — FIPS 186-5 Appendix E:

> *"DSA is no longer approved for digital signature generation. DSA may be used to verify
> signatures generated prior to the implementation date of this standard."*

DSA has been **unapproved for signature generation since 2023-02-03**, independent of anything
quantum. Its specifications were removed from FIPS 186-5 entirely.

Today we report DSA alongside RSA/ECDSA as a PQC migration item with a 2035 horizon. That
understates it: a DSA signing site is **non-compliant now**, with no runway.

This also explains why DSA appears in no IR 8547 transition table — there was nothing left to
transition. My earlier seed data assumed the RSA dates transferred to DSA. They do not.

**What closed it:** the C1 mapping engine. An in-effect prohibition now outranks the PQC horizon
when bucketing (`lib/mappings/src/engine.ts`), so DSA resolves to
`bucket: "immediate-compliance-failure"` while RSA and ECDSA stay in `pqc-migration`. No 2035
deadline is emitted for DSA and none appears in its headline. The report page groups by bucket,
and the executive summary leads with the findings that have no runway.

**Nuance, handled:** verification of pre-2023 signatures appears in the finding's use-condition
table as permitted legacy use. Because a pattern match cannot distinguish generation from
verification, `algorithms.json`'s `dsa` entry carries `detectionConfidence` — a `0.6` multiplier,
`reviewRequired: true` and a customer-facing reason — which the engine surfaces and the UI renders
as a "needs review" badge. The multiplier is data, not a constant in TypeScript.

---

## G-08 — SHA-1 rule is use-dependent `Closed 2026-08-13`

`verified 2026-08-01` — SP 800-131A Rev 2 §9 gives **three different answers** depending on use:

| Use | Status |
|---|---|
| Digital signature generation | **Disallowed** (except where NIST protocol guidance allows) |
| Digital signature verification | **Legacy use** — allowed |
| Non-signature applications not requiring collision resistance | **Acceptable** |

So `HMAC-SHA1` — which does not depend on collision resistance — is **acceptable per NIST**. We
currently flag every SHA-1 occurrence identically as an alert. That is incorrect for a
meaningful share of real matches, and a knowledgeable reviewer will challenge it.

**What closed it:** the engine returns `useConditions` — one row per use, each marked permitted or
not, with the framework that says so — whenever the data records both permitted and prohibited
uses. SHA-1 therefore reports a three-row table instead of a verdict on the algorithm, and the
non-signature/HMAC row renders as *acceptable*. Confidence is reduced through the same
`detectionConfidence` block as DSA (`0.5`, review required).

**Still true:** full resolution needs call-site context the regex does not have. What changed is
that the report now says so explicitly instead of asserting a ban. Automatic classification
remains a candidate for the crypto-agility clustering work (D5).

---

## G-09 — AES-ECB framed as a compliance violation `Closed 2026-08-13`

`verified 2026-08-01`. Two errors in the original seed, both now fixed in `algorithms.json`:

1. It cited **SP 800-38D**, which is the *GCM* specification (November 2007). The string "ECB"
   appears **zero times** in it.
2. ECB is defined in **SP 800-38A** as one of five **approved** confidentiality modes.

So "AES-ECB violates NIST SP 800-38D" — which is roughly what we would have printed — is a
**false compliance claim**. ECB's problem is that it lacks semantic security, which is a
best-practice concern, not a standards violation.

**What closed it:** AES-ECB has no `deadlines`, so the engine resolves it to
`complianceStatus: "no-obligation"` and `bucket: "best-practice"`. Its one obligation comes from a
new `bestPractice` block in `algorithms.json` that carries the requirement (move to an
authenticated mode), the basis ("NOT a NIST compliance requirement") and the SP 800-38A citation —
the document that *approves* ECB, so an auditor checking it finds agreement rather than a
contradiction. `lib/mappings/src/engine.test.ts` asserts no obligation on AES-ECB can contain
"violat", "non-compliant" or "prohibited".

---

## G-10 — Hygiene findings inflate the PQC risk score ~~`High`~~ — **CLOSED 2026-08-14**

Three of the seven detection patterns — MD5, SHA-1, AES-ECB — are **not quantum
vulnerabilities**. `computeScanResult()` counts them into the same severity totals and risk
score as RSA and ECDSA.

Observed in the live smoke test: a 10-line file scored **risk 100, 3 critical / 2 alert**, where
2 of the 5 findings had nothing to do with quantum computing.

A CISO presenting a post-quantum risk score inflated by MD5 findings will be corrected in the
room.

**What closes it:** A4 risk engine split. `algorithms.json` carries `reportingNote` on each
hygiene entry, and C1 now exposes the machine-readable half of that decision:
`riskTrack: "classical-hygiene"` and `countsTowardPostQuantumScore: false` on every finding's
`compliance` block. The executive summary already honours it. `computeScanResult()`'s
`riskScore`/`criticalCount`/`alertCount` are deliberately untouched — re-keying them is A4's job,
and the contract it should consume is in [05](05-compliance-mapping.md) §"What A4 consumes".

> **Closed 2026-08-14 by A4** (`lib/risk/`, `@workspace/risk`). `computeRiskProfile()` splits
> findings into a post-quantum track and a classical-hygiene track and computes `pqc.riskScore`
> over the former alone: **a scan containing only MD5/SHA-1/AES-ECB now scores zero
> post-quantum risk**, regression-tested at both the engine level
> (`lib/risk/src/risk-profile.test.ts`) and at `computeScanResult()`, where the bug actually
> lived (`artifacts/api-server/src/lib/scanner.test.ts`). The register's observed case — a
> ten-line file at risk 100 with 3 of 5 findings unrelated to quantum computing — is pinned as
> a test and now scores 60, from the three asymmetric findings only.
>
> **The split is derived from the mappings data, not from a list of algorithm names in code.**
> `deriveAlgorithmMapping()` now surfaces `algorithms.json`'s `quantumVulnerable` flag verbatim
> and `lib/risk/src/tracks.ts` keys on it, so the next algorithm added to the data lands on the
> right track without a code change. Each hygiene algorithm's own `reportingNote` is attached to
> its panel entry rather than paraphrased, which is what makes G-09's "best practice, not a
> compliance violation" framing reach the report.
>
> Two smaller overclaims went with it: the executive summary no longer describes hygiene
> findings as "non-PQC-safe" (there is no PQC successor to MD5) and no longer recommends
> migration to FIPS 203/204/205 on a scan that found no quantum-vulnerable cryptography.
>
> **Not claimed:** no UI renders the hygiene panel yet, and `openapi.yaml`/the Orval client are
> not regenerated, so the typed frontend client cannot see `pqc`/`hygiene`/`mosca`. The data
> contract exists; the panel is D2/reporting work. **G-07, G-08 and G-09 stay open** — A4
> carries their `reportingNote`s through so they have something to act on, which is the "cheap
> once A4 exists" the ordering below refers to, but it does not act on them.

---

## G-11 — No confidence score on findings `High, partially closed`

Every finding is presented as equally certain. `/\bRSA/i` matches prose, comments, variable
names and unrelated acronyms; `/\bDH\b/i` matches initials and `DHCP` often enough to matter.

An inventory whose findings cannot be filtered by evidence quality will not survive an audit.

**What closes it:** A2 collector interface — `RawObservation.confidence` is already in the target
design. Regex ≈ 0.7, TLS handshake ≈ 1.0.

> **Update, 2026-08-02 (A1/A2).** ✅ `RawObservation.confidence` exists, `SourceRegexCollector`
> emits `0.7` for every observation, and it persists on `observations.confidence` (tested in
> `lib/db/src/schema/asset-model.test.ts`). ⬜ Not closed: no route, report, or UI element
> reads or filters by it yet — an inventory that carries confidence in the database but never
> shows it is not yet "an inventory whose findings can be filtered by evidence quality." That is
> D3/reporting scope, not A1/A2.

> **Update, 2026-08-13 (B2).** The dependency collector is the first evidence that the scale is
> doing real work rather than being a constant: it emits `0.8` for a single-purpose crypto
> library (`node-rsa`, `@noble/ed25519` — parse-exact presence of a package that exists to do
> one thing, stronger evidence than a regex over prose at `0.7`) and `0.5` for a
> general-purpose one (`cryptography`, `elliptic` — the primitive is *available*; which of
> several the caller invokes is not in a lockfile). Two observations in the same inventory now
> differ by evidence quality, which makes the missing consumer (D3) the visible next gap.

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

## G-12 — Security findings S1–S8 `High` — **MITIGATED IN CODE, PENDING DEPLOY**

Full detail in [08-security.md](08-security.md). Headline was: no authentication anywhere,
share-link IDs from `Math.random()`, full customer source persisted, `cors({ origin: true })`
with credentials.

> **Escalated 2026-08-01.** The application is deployed at **https://quantaxscan.swotpam.com**
> with the unauthenticated API publicly reachable. `GET /api/projects` returns every project in
> the production database, including real internal names. `DELETE /api/projects/:id` is equally
> open. This is not a future risk — it is current.

> **Interim mitigation landed 2026-08-02.** Default-deny shared-API-key middleware on `/api`
> (`artifacts/api-server/src/lib/auth.ts`), an explicit CORS origin allowlist, and CSPRNG
> share-link IDs. The API server refuses to start without `QUANTAXSCAN_API_KEYS`, so the open
> state cannot be redeployed by accident.
>
> **The live exposure is not closed until the deployment sets `QUANTAXSCAN_API_KEYS` and
> redeploys** — and because the control fails closed, deploying *without* that variable takes the
> API down rather than leaving it open. Setting the secret is part of shipping this, not a
> follow-up.
>
> **The hosted `/scan` journey goes dark on deploy.** It calls `/api/github/fetch`,
> `/api/github/scan-files`, `/api/scans/multi`, `/api/chat` and `/api/reports`, all of which are
> now protected, and the browser bundle holds no key. That is the product's headline flow, not a
> peripheral page. `/demo/*` stays public, so the demo repositories still work end to end. Expect
> an outage on the main path until F1, not graceful degradation.
>
> **Frontend follow-up, 2026-08-03.** The Dashboard and the Scan page now report an API refusal
> as a refusal rather than as "no scans yet" / "check the URL" — see
> [11-ui-defect-fixes.md](11-ui-defect-fixes.md). That is honesty about the gate, not a narrowing
> of it; the gated journeys still fail until F1.
>
> **Organisation scoping landed 2026-08-03 (P1).** Every organisation-scoped table now carries
> `organization_id` with a row-level-security policy enforcing it, the runtime connects as a role
> with no `BYPASSRLS`, and every route reads and writes through `withOrg`. A forgotten `where`
> clause now returns zero rows rather than another tenant's data. Design and evidence:
> [13-auth-and-tenancy.md](13-auth-and-tenancy.md).
>
> **This is the org-scoping half of S1 and nothing else.** There is still no per-user identity —
> no sign-in, no sessions, no providers — so the shared API key remains the only credential, now
> bound to organisation 1. **S1 stays open.** The change is deliberately invisible: no
> user-facing behaviour differs, which is what makes a regression show up as zero rows rather
> than as a subtle authorisation bug.
>
> Severity drops from `Critical` to `High` on deploy, not on merge. It does not reach closed:
> S1 still lacks per-user identity (F1), S2 still lacks the expiry and revocation *interface*
> (the columns and the policy now exist), and S3, S6, S7, S8 are untouched. Real project names
> are still in the production database and that needs database access, not a code change.

**Blocks:** the first pilot with real customer data — F1 and the remaining S-findings are still
required for that. The immediate anonymous-access problem is addressed.

---

## G-13 — `.env` tracked in git ~~`Low now, High later`~~ — **CLOSED 2026-08-03**

`.env` was tracked and `.gitignore` did not cover it. It held only `API_BASE_URL`, so nothing
leaked — but it is where `QUANTAXSCAN_API_KEYS` and, shortly, `SESSION_SECRET` and two database
passwords are meant to live locally.

> **Closed 2026-08-03** by `git rm --cached .env` plus `.gitignore` entries for `.env` and
> `.env.*` (keeping `.env.example`). The `git rm --cached` is the part that mattered: adding an
> already-tracked file to `.gitignore` does nothing.
>
> **No history rewrite was performed, and none is warranted** — the file's history contains no
> secret, and a rewrite is a destructive, force-push-shaped operation with real cost to everyone
> holding a clone. If a secret is ever committed, that calculus changes and the credential must be
> rotated regardless.
>
> **Still outstanding, and deliberately not claimed as part of this:** a pre-commit or CI secret
> scanner. `08-security.md`'s pre-pilot checklist keeps S5 open on that basis.

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

## G-15 — Observation model not aligned to SP 1800-38B `Medium, partially closed`

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

> **Update, 2026-08-02 (A1/A2).** ✅ The `network` `locationDetail` profile (all seven Table 6
> elements, `Cpe23FormattedString` for software/OS/vendor with the "Device Vendor" OUI
> qualification), the internal CPE 2.3 parser/formatter (NIST IR 7695), and the six-value
> `discoveryModality` enum (now **confirmed permanent**, not provisional — captain decision,
> 2026-08-02) are all built — see `lib/collectors/src/{location-detail,cpe,enums}.ts` and
> [04-architecture.md](04-architecture.md#nist-reached-the-same-conclusion--align-with-it).
> `locationDetail` is `jsonb` validated at the application boundary rather than the database
> layer, matching the investigation's recommendation not to explode it into per-surface columns.
> ⬜ Not closed: **no collector populates the `network` profile.** B3 (TLS prober) and B4
> (certificate) are the collectors that would put real CPE/hostname/port data into it, and
> neither is built. This gap stays open until one of them lands; the schema and validation being
> ready is necessary but not sufficient for "aligned to SP 1800-38B", which is about what the
> product actually reports, not what its types permit.

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

1. ~~**G-13**~~ (closed 2026-08-03), **G-18** — minutes each, and free only while the repo is
   private
2. **G-17** — the positioning is wrong *now*, and it is a document edit
3. ~~**G-06**~~ (closed 2026-08-13, alongside B2) — one pattern, closed a real detection hole
4. **G-01** — 30 minutes, unblocks a whole customer segment
5. **G-16** — a roadmap decision to make before committing to A2's surface priorities
6. ~~**G-10**~~ (closed 2026-08-14 by A4), **G-05, G-11, G-15** — land together with A2/A4; they
   are the same refactor. **Update, 2026-08-02:** the A1/A2 half landed (G-05/G-11/G-15 partially
   closed — see each entry above). **Update, 2026-08-14:** A4 landed and closed G-10. Neither A4
   nor C1 touched G-05's deadline-resolution half — A4 splits on `quantumVulnerable`, which needs
   no key size, and C1 returns both IR 8547 rows without labelling either an assumption. That
   label is the remaining work.
7. ~~**G-07, G-08, G-09** — reporting/copy changes, cheap once A4 exists~~ **Closed 2026-08-14**
   by C1, which turned out to be the dependency rather than A4: they needed bucketing, use
   conditions and citations, not the risk engine.
8. **G-12, G-19** — before any pilot, and hard gates on open-sourcing. G-12's interim auth and
   organisation scoping are shipped; per-user identity (F1) and the remaining S-findings are the
   pilot blockers
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
