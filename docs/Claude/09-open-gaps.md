# 09 — Open gap register

Every known gap in one place, with what closes it and what it blocks. Updated 2026-08-14.

Three families:

- **G-01…G-04** — standards still unverified
- **G-05…G-11**, **G-20…G-21** — detection quality, surfaced by the verification work
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
| G-11 | No confidence score on findings | Medium, mostly closed | Design | A2 + D3 — carried on `observations`, now read and shown; no *filtering* yet |
| G-12 | Security findings S1–S8 | High | Interim auth + org scoping shipped; needs deploy. S7 closed and S6 rate-limited (queue deferred) 2026-08-14 | See [08](08-security.md), [13](13-auth-and-tenancy.md) |
| ~~G-13~~ | ~~`.env` tracked in git~~ | **Closed** | Done 2026-08-03 | — |
| ~~G-14~~ | ~~No re-verification trigger for standards data~~ | **Closed (CI half); calendar half open** | Done 2026-08-14 | — |
| G-15 | Observation model not aligned to SP 1800-38B data elements | Medium, partially closed | Design | A2 — profile + modality landed; no network collector populates it |
| G-16 | Binary scanning deferred; NIST treats it as core | Medium | Roadmap call | Re-scope B10 |
| ~~G-17~~ | ~~Competitive framing understates the field~~ | **Closed** | Done 2026-08-14 | — |
| ~~G-18~~ | ~~`package.json` says MIT, no LICENSE file exists~~ | **Closed** | Done 2026-08-14 | — |
| ~~G-19~~ | ~~`attached_assets/` unaudited, 4 MB of Replit scraps~~ | **Closed in the tree; history caveat stands** | Done 2026-08-14 | Gate 2 |
| G-20 | Dependency findings do not distinguish direct from transitive | Medium | Lockfile format | B2 follow-up — caveat shipped, detection not |
| G-21 | The package table applies one claim to every version of a package | Medium | Design | B2 follow-up |

---

## B2 provenance audit `2026-08-14`

`CRYPTO_PACKAGES` was the last customer-facing claim set in this repository with no citation and
no `verified`/`needs-check` status. It escaped the discipline in
[`mappings/`](mappings/README.md) only because it was TypeScript rather than data — the same
class of unverified claim that produced G-05, G-07, G-08 and G-09, feeding the same reports.

It is now [`docs/Claude/mappings/crypto-packages.json`](mappings/crypto-packages.json): every
package carries a status, and every `verified` one a verbatim quote from the package's own
documentation with a retrieval date. `pnpm run check:standards` walks it like every other file in
that directory, so a claim expires after 180 days and demands a re-read — which matters here more
than for a standards document, because a library's algorithm set changes under a version bump and
nothing else in this repository would have noticed.

Auditing 29 packages against their own documentation corrected three claims:

| Package | Was | Is | Source |
|---|---|---|---|
| `pypi/pyopenssl` | ECDSA (multi-primitive) | **claim removed** | pyOpenSSL's `PKey` documents `TYPE_RSA` and `TYPE_DSA` and no EC key type. Its only EC surface is `get_elliptic_curves()`, documented for choosing the curve in TLS **ECDHE key exchange** — not a key object and not ECDSA |
| `pypi/ecdsa` | ECDSA only, `dedicated` (0.8) | ECDSA + EdDSA + ECDH/DH, all `multi-primitive` (0.5) | The package's own description: *"an easy-to-use implementation of ECC … with support for ECDSA …, EdDSA … and ECDH"*. It is a general ECC library, so `dedicated` overstated the inference and two real primitives were invisible |
| `npm/secp256k1`, `npm/@noble/secp256k1` | ECDSA only | ECDSA + ECDH/DH | Both document ECDH key agreement (`ecdh` / `getSharedSecret`); `@noble/secp256k1`'s own headline is *"secp256k1 signatures & ECDH"* |

Two claims are now marked `needs-check` rather than deleted, because the gap being visible is the
point: `pypi/pycryptodomex` (its claims are transposed from `pycryptodome`, whose codebase it
shares under a different namespace — an inference, not a citation) and `pypi/pycrypto`
(unmaintained since 2014, no authoritative documentation read). One *claim inside* a verified
package is marked too: `paramiko`'s DSA, which its changelog removed in 4.0.0 — see G-21.

Also corrected without changing an algorithm claim: `jsrsasign`'s RSA rationale, which said
"signature and encryption"; v11.0.0 removed RSA encryption entirely over CVE-2024-21484.

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
- ✅ **Done 2026-08-14.** Where it is genuinely undeterminable, the engine returns **both**
  candidate obligations, each flagged *"Key size undetermined — assumed 112 bits … Confirm the
  key size before acting on either date."* And where the key size **is** known it now narrows to
  the band that actually applies: RSA-2048 gets the 2030 deprecation, RSA-4096 does not. That
  narrowing is the "correct deadline reporting" this gap was always about — returning both rows
  for a key we *can* size is as wrong as returning one for a key we cannot.

> **How the band table is kept out of the code.** IR 8547 keys its rules on security *strength*;
> a collector reports a parameter *size*. That bridge is `securityStrengthBands` in
> `algorithms.json`, with `keySizeKind` on each algorithm entry saying whether its size is a
> modulus or a curve — both data, following C1's rule. A test moves the band boundary in a cloned
> copy and asserts the answer follows with no TypeScript edit.
>
> Three deliberate choices: the assumed band is the **conservative** one (the earlier deadline),
> so an undetermined key is never reported as having more runway than it might; a size falling in
> **no** band is treated as undetermined rather than forced into the nearest one; and an algorithm
> with no `keySizeKind` — a hash, a cipher mode — is untouched by any of it.
>
> **What is still open is detection reach, not reporting:** the source collector still cannot
> fold constants or read cross-line context, and certificate SPKI parsing needs B4.
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

## G-11 — No confidence score on findings `Medium, mostly closed`

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

> **Update, 2026-08-14 (D3).** ✅ `observations.confidence` now has its first consumer:
> `GET /api/projects/:id/coverage` returns a distribution over it and the dashboard's coverage
> meter renders it, with the empty 0.8–1.0 band shown deliberately so "nothing here is verified
> evidence" is visible rather than inferred. The distribution is **one point per active asset**
> (its most recent observation), not one per observation — weighting it by observation count
> would describe our scan schedule rather than our evidence quality — and the payload states that
> basis and how many assets it excluded. ⬜ Still open: **filtering**. The findings list the
> product actually shows comes from `findings`, which has no confidence column; joining it to
> `observations` is the read cut-over that
> [04-architecture.md](04-architecture.md) defers. Severity drops to `Medium` because the
> evidence quality is now *visible* to anyone reading a report — but the gap's own wording is
> about filtering, so it is not closed.
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

> **S6 and S7 addressed 2026-08-14.** Rate limiting and the GitHub SSRF surface were the two
> S-findings that were self-contained and needed no product decision, so they were taken
> together. Detail and the honesty caveats are in [08-security.md](08-security.md); the summary
> for this register:
>
> - **S7 is closed** and the pre-pilot checklist is ticked. Host validation is now an exact
>   allowlist rather than `hostname.includes("github.com")`, with `https`-only, no embedded
>   credentials, owner/repo charset validation and encoding, per-hop redirect validation and
>   request timeouts. **The finding's severity was overstated:** the caller's host never reached
>   `fetch` — every request was already built against two hardcoded GitHub hosts — so this was
>   path injection into fixed hosts, not a request-forgery primitive against internal networks.
>   The register's "redirect token leak" was likewise already mitigated by the Node runtime, and
>   that is stated in 08 rather than claimed as a fix. Two of the bypasses named in the original
>   write-up did not reproduce; the corrections are recorded there and asserted by tests.
> - **S6 is not closed and stays unticked.** Two-layer rate limiting shipped with per-route
>   budgets keyed per API key — per key rather than per org because the shared key is the only
>   principal that exists — but the checklist item is "rate limits + **scan queue**", and the
>   queue is deliberately deferred as an architectural change. The store is in-process, so every
>   budget is per replica, and body limits are only partly per-route.
>
> The remaining S-findings are unchanged: S1 (per-user identity), S2 (share expiry/revocation
> interface), S3 (full source persisted), S5 (secret scanning), S8 (audit logging).

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

## G-14 — No re-verification trigger — **CI HALF CLOSED 2026-08-14**

Standards data decays and nothing currently prompts a re-check. IR 8547 is a **draft** that will
presumably be finalised, at which point every date in the system needs revisiting and the
"draft guidance" labels need removing.

**What closes it:**

- ~~CI check failing when any `retrievedAt` is older than 180 days~~ ✅ **Done 2026-08-14** —
  `pnpm run check:standards` (`scripts/src/check-standards-freshness.ts`), wired into both
  `scripts/ci-local.sh` and the workflow. It walks every JSON under `docs/Claude/mappings/`,
  reports the dotted path of each stale entry so it can be found without grepping, and sorts
  oldest first. Currently: 31 dated entries across 3 files, all fresh.
- ⬜ Quarterly re-verification task in the content calendar *(already added for marketing —
  extend to `mappings/`)*
- ⬜ Immediate trigger on: IR 8547 going final, a new FIPS publication, a CycloneDX release, a
  CNSA 2.0 revision

> **Two deliberate limits, so the check is not mistaken for more than it is.**
>
> It is a **date comparison, not a network fetch.** Re-fetching each source and diffing it
> would be a different and much less reliable tool: several primary sources return HTTP 403 to
> automated requests — that is G-01's entire problem — so a network check would fail for
> reasons unrelated to staleness and be muted within a week. A date comparison cannot be wrong
> about what it measures.
>
> It **cannot detect the failure that matters most**: bumping `retrievedAt` without reopening
> the source. Nothing automated can. The check buys a prompt, not assurance, and the honest
> place to record that is here rather than in a green tick.
>
> An **unparseable date is treated as infinitely stale** rather than skipped — otherwise a typo
> creates an entry that never expires, which is strictly worse than one that is merely old.

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

## G-17 — Competitive framing understates the field — **CLOSED 2026-08-14**

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

> **Closed 2026-08-14.** `marketing/01-positioning.md` had already been corrected on 2026-08-01;
> what remained open — and was the more consequential half — was
> [01-strategy.md](01-strategy.md#against-the-alternatives), which still instructed the reader to
> *"price and position against [the spreadsheet], not against tools."* That is the sentence that
> would have sent someone into a room unprepared, and it is now corrected in place with the
> SP 1800-38B §5.1 vendor list alongside it.
>
> Independent competitive research (2026-08-13) added Fortanix, the PQCA's open-source CBOMkit
> and several consultancy platforms to the list, and surfaced a finding that is really about us
> rather than about them: **the market is overwhelmingly agentless-first**, reaching cryptography
> through read-only credentials to KMS, HSMs, KMIP, the CA database and Active Directory. Source
> code — our only live collector — is the slowest surface to onboard and among the narrowest.
> That is recorded in both documents, because it should influence which collector is built next
> (B5/PKI over more source languages) rather than sitting in a research note nobody re-reads.

---

## G-18 — Licensing conflict — **CLOSED 2026-08-14**

`package.json` declares `"license": "MIT"`. There is **no LICENSE file** in the repository.

The repo is private today so nothing has been granted to anyone. But if it is published as-is,
that manifest declaration is what governs — **MIT over the entire workspace**, including
anything intended to ship as Enterprise. MIT permits unrestricted commercial redistribution.

**What closes it:** set the root manifest to the intended licence, add LICENSE files per tier,
add `mappings/LICENSE` for CC BY 4.0. See [10-editions.md](10-editions.md#licensing--three-separate-decisions).

> **Closed 2026-08-14**, to the three decisions [10-editions.md](10-editions.md#licensing--three-separate-decisions)
> had already made rather than to a new one:
>
> - `LICENSE` at the root — **Apache 2.0**, the canonical text fetched from apache.org rather than
>   retyped, with the appendix placeholder filled in.
> - `docs/Claude/mappings/LICENSE` — **CC BY 4.0**, because that directory is data, not code. It
>   also states the two conditions that matter for a dataset with provenance: attribute by
>   `dataVersion`, and do not strip the `verified`/`needs-check` status when redistributing, since
>   the status is part of the data.
> - `package.json` — `"license": "Apache-2.0"`. This was the load-bearing line: it, not the absent
>   file, is what would have governed on publication.
>
> **Still outstanding:** the Enterprise tier has no separate `ee/` directory or licence header.
> 10-editions.md says to decide that *before the first Enterprise line of code*, and none exists
> yet, so nothing is mis-licensed today — but the decision is still open.

---

## G-19 — `attached_assets/` unaudited — **CLOSED 2026-08-14 (with a caveat)**

Roughly 4 MB of Replit screenshots and pasted-text scraps in the repo root. **Nobody has
reviewed them** for credentials, internal URLs, customer data, or third-party copyrighted
content.

Invisible while the repo is private; permanent and indexable once it is not.

**What closed it:** the directory is deleted (2.6 MB, 21 files), along with the now-dangling
`@assets` alias in `artifacts/quantaxscan/vite.config.ts` — the alias was defined and never
imported anywhere, so nothing referenced the directory.

The six text files **were** read before deletion: they are pasted component-library snippets
(shadcn/motion install instructions, a bash tokeniser) plus a `Q-VULN` draft. No credentials, no
tokens, no customer data, and the only external URL is `w3.org`. The fifteen images were **not**
individually reviewed — deleting was cheaper, which is what this entry recommended.

> **The caveat is why this entry is not simply "Closed".** Deletion removes the files from the
> working tree, **not from git history**, and they were committed. Anyone with the repository can
> still recover them. That makes this sufficient for tidiness and *insufficient* on its own as a
> publication control: Gate 2 in [10-editions.md](10-editions.md#publication-gates--hard-blockers)
> still applies, and if the repo is ever made public the images need either a history rewrite or a
> decision that they are harmless — which nobody has yet made, because nobody has looked at them.

---

## G-20 — Dependency findings do not distinguish direct from transitive `Medium`

A lockfile pins the **fully resolved** dependency graph. `elliptic` and `sha.js` reach almost
every JavaScript project through the build toolchain — `crypto-browserify` → `browserify-sign` →
`elliptic`, and `crypto-browserify` → `create-hash` → `sha.js` — so B2 fires on nearly every
project scanned, whether or not anyone wrote a line of code that touches them.

**What is true and what is not.** The finding itself is correct: the package really is in the
graph, and it really does implement the primitive. Nothing this collector says asserts that the
customer's own code *calls* it — `crypto-packages.json`'s rationales are all of the form "the
package implements X", and the CBOM and timeline carry presence, not use. So there is no wrong
statement to retract. What there is, is a reading a CISO can very reasonably make and be wrong
about.

**Shipped for it:**

- `toolchainUbiquity: true` on `npm/elliptic` and `npm/sha.js` in the data, carried into every
  observation's `evidence`.
- An `evidenceCaveat` on every `POST /projects/:id/dependencies` response and in the OpenAPI
  description, stating that a match may be transitive.

**Not shipped:** actually determining directness. `pnpm-lock.yaml`'s `importers:` block and
`package-lock.json`'s root `packages[""]` entry both name the direct dependencies, so it is
determinable for the two dominant npm formats; `yarn.lock` and `requirements.txt` carry no such
distinction and would have to stay `undetermined` — which is the honest value, and precisely why
this is its own change rather than a flag bolted onto the current parse.

**Explicitly *not* the fix:** lowering the `multi-primitive` confidence below 0.5. That number
describes the strength of the inference "the library is present, therefore this algorithm is
used", which ubiquity does not change. Bending it to hint at something it does not mean would
understate a fact (the library *is* shipped) in order to gesture at a different question.

---

## G-21 — One claim per package, applied to every version `Medium`

`crypto-packages.json` deliberately does no version-range reasoning: it records the version a
lockfile pins, but has no notion of "implemented from x.y.z". That rule was written about
*advisory* data ("vulnerable before x.y.z"), which is a separate dataset with its own provenance
requirements. The B2 audit found the rule also bites on plain **capability**:

- `paramiko` 4.0.0 (2025-08-03) *"Removed support for the DSA (aka DSS) key algorithm"*. The
  table's DSA claim is true of 3.x and false of 4.x.
- `jsrsasign` 11.0.0 removed RSA *encryption* (CVE-2024-21484) while keeping RSA signature. Here
  the algorithm claim survives and only the rationale needed correcting — but the next such
  change may not be so kind.

**Interim handling:** the affected claim is marked `needs-check` at the *algorithm* level, so one
version-dependent claim does not discredit the rest of an entry, and the reason names the version
and quotes the changelog. The pinned version is already in the observation's `evidence`, so a
reviewer has what they need to settle it.

**What closes it:** a `sinceVersion`/`untilVersion` field on an algorithm claim and a comparison
against the pinned version at collection time. Cheap to add; the reason it is not in this change
is that it needs a version-comparison implementation in a package that is deliberately
dependency-free, and `requirements.txt` ranges resolve to no version at all — so the design has
to answer "unknown version, version-gated claim" before the field is worth having.

---

## Suggested order

1. ~~**G-13**~~ (closed 2026-08-03), ~~**G-18**~~ (closed 2026-08-14) — minutes each, and free
   only while the repo is private
2. ~~**G-17**~~ — closed 2026-08-14 (positioning 2026-08-01, strategy 2026-08-14)
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
9. ~~**G-14**~~ — the CI half is set up (2026-08-14); the calendar half and the event triggers
   are still owed
10. **G-02, G-03** — when the relevant customer segment is actually in play
11. **G-04** — with C9
12. **G-20, G-21** — B2 follow-ups, opened 2026-08-14 by wiring it. Both are visible in the data
    and in every response today; both need a parse or a schema change to close. G-20 first: it is
    the one a customer can misread

### Read SP 1800-38 properly before starting the A2 refactor

Volume B is the NIST practice guide for our exact product category and we found it late. Before
building the collector interface, someone should read it end to end — the architecture (§4),
the normalisation scheme (§4.1.4) and the eight-use-case test plan (Appendix C). It is the
closest thing to a specification that exists for this product, and a buyer may evaluate us
against it.

---

## What this register demonstrates

Six of these gaps (**G-05, G-07, G-08, G-09**, plus the FIPS 206 and CycloneDX version
errors already corrected) were invisible until the standards data was checked against primary
sources. Four of them would have produced **incorrect statements in a customer-facing report**.

The B2 provenance audit (2026-08-14) is the same story a second time, on the one claim set that
had been exempt because it lived in TypeScript rather than in `mappings/`: three more claims
corrected, one of which — reporting ECDSA from a `pyOpenSSL` dependency — would have been a
finding about an algorithm the library has no key type for.

That is the argument for the `verified` / `needs-check` discipline, and it is also the argument
for the product itself: this is precisely the class of error a cryptographic inventory is
supposed to catch, and we found ours by doing to our own data what we propose to do to
customers'.
