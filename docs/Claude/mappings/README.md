# mappings/ — versioned standards data

**These files are data, not code.** They are what makes compliance mapping dynamic. Standards
change; nothing in `src/` should have to change when they do.

| File | Purpose |
|---|---|
| `algorithms.json` | Canonical algorithms → PQC replacements, deprecation timelines |
| `frameworks.json` | Framework definitions, versions, applicability rules |
| `controls.json` | Crosswalk to general control frameworks |

See [../05-compliance-mapping.md](../05-compliance-mapping.md) for the engine design.

**Sharp edge — these are build inputs, not runtime files.** `lib/mappings/src/data.ts` (and
`lib/collectors/src/algorithm-mapping.ts`) import them as JSON modules (`with { type: "json" }`)
so esbuild inlines them into the API bundle; there is no runtime read of these paths. Editing the
JSON therefore has no effect until the API is rebuilt and redeployed. That is a *deploy* step, not
a code change, which is why the M2 exit criterion still holds.

Since C1, `algorithms.json` and `frameworks.json` **are** schema-validated — `parseMappingData()`
runs at module initialisation, i.e. at API boot, so a malformed file fails startup loudly instead
of becoming a missing obligation halfway through a report. The schema is deliberately lenient
(unknown keys pass; the deadline-type vocabulary is open) so a data pull request is never blocked
by the code not recognising a new field. `controls.json` still has no consumer.

**Three blocks exist so the engine never hardcodes a rule.** Change any of them and behaviour
changes with no TypeScript edit:

| Block | File | What it drives |
|---|---|---|
| `deadlineTypes` | `algorithms.json` | The whole deadline vocabulary — label, `effect` (`prohibition`/`caution`/`permitted`) and severity per term. Adding a term here teaches the engine a new kind of rule. |
| `detectionConfidence` | `algorithms.json`, per entry | Confidence multiplier, `reviewRequired` and the customer-facing reason for algorithms whose answer depends on call-site context (`dsa`, `sha1`). |
| `findingObligations` | `frameworks.json`, per framework | Framework-level requirements matched to an algorithm entry by `quantumVulnerable` / `algorithmIds` / `families` / `purposes`. How CISA-QR and CNSA 2.0 attach to a finding. |

---

## Verification status — `dataVersion 0.2.0`, verified 2026-08-01

| Entry | Status |
|---|---|
| FIPS 203 / 204 / 205 — status, parameter sets, security categories | ✅ `verified` |
| SP 800-208 — LMS/HSS, XMSS | ✅ `verified` |
| FN-DSA (Falcon), HQC — **not yet published** | ✅ `verified as unpublished` |
| NIST IR 8547 — **still an initial public draft**, all timeline rows | ✅ `verified` |
| CISA/NSA/NIST factsheet — sections, discovery targets, quotes | ✅ `verified` |
| CycloneDX — **1.7**, released 2025-10-21 | ✅ `verified` |
| AES / symmetric guidance | ✅ `verified` |
| SHA-1 security strengths | ✅ `verified` |
| DSA — FIPS 186-5 Appendix E, unapproved for signature generation | ✅ `verified` |
| SHA-1 — SP 800-131A Rev 2 §9, all three use-dependent rules | ✅ `verified` |
| MD5 — never NIST-approved (absent from FIPS 180-4) | ✅ `verified` |
| AES-ECB — approved mode per SP 800-38A, not a violation | ✅ `verified` |
| PCI DSS 4.0 §12.3.3 | ⚠️ `needs-check` — secondary sources only, PCI SSC doc is gated |
| CNSA 2.0 per-category timeline | ⚠️ `needs-check` — **blocked, see below** |
| OMB M-23-02 submission format | ⚠️ `needs-check` |
| `controls.json` — every crosswalk | ⚠️ `needs-check` — Phase 3 concern, seeded only |

### Blocked on human verification

`nsa.gov`, `media.defense.gov` and `cisa.gov` all return **HTTP 403** to automated fetches. A
human must open these directly:

- **CNSA 2.0 FAQ (Ver 2.1, December 2024)** — the per-category timeline. The seed data
  previously implied a single "~2033" end state; the real timeline differs by system category
  and 2033 appears to apply only to custom applications and legacy equipment.
  `https://media.defense.gov/2022/Sep/07/2003071836/-1/-1/0/CSI_CNSA_2.0_FAQ_.PDF`
- **PCI DSS v4.0.1 §12.3.3** — exact wording and numbering. Requires PCI SSC registration.

The CISA factsheet *was* verified — via the NIST NCCoE-hosted copy of the same TLP:CLEAR
document, which is fetchable.

---

## Changes in 0.4.1 — the key-size → security-strength bridge (G-05)

No standards claim changed and no `retrievedAt` moved. Added the structure the engine needs to
apply IR 8547's rules correctly, which are keyed on security *strength* while collectors report a
parameter *size*.

| Added | Where | Why |
|---|---|---|
| `securityStrengthBands` | `algorithms.json` | Two bands (`112 bits`, `>= 128 bits`) with the modulus and curve ranges that land in each, sourced from IR 8547 Table 2 and Table 4. `assumedWhenUndetermined` marks the conservative band used when a collector could not establish a key size, so an undetermined key is never given more runway than it might have. |
| `keySizeKind` on rsa/dsa/ecdsa/ecdh/eddsa | `algorithms.json` | Whether the entry's key size is a modulus or a curve. Mirrors `KEY_SIZE_SOURCE` in the collectors; here as data so the engine needs no algorithm-name list. |

| Entry | Status |
|---|---|
| Band boundaries and their examples | ✅ `verified` (IR 8547 Table 2 / Table 4, same retrieval as the deadlines that use them) |
| `keySizeKind` assignments | ✅ `verified` — a property of the algorithms, not a judgement |

---

## Changes in 0.4.0 — machine-readable reporting semantics

No standards claim changed and no `retrievedAt` moved: every citation in 0.4.0 is the same
primary source, read on the same date, as in 0.3.0. What was added is the structure the C1
mapping engine needs so that the corrections recorded in 0.3.0 actually reach a report.

| Added | Where | Why |
|---|---|---|
| `deadlineTypes` vocabulary block | `algorithms.json` | Six terms (`deprecated`, `disallowed`, `not-approved`, `never-approved`, `legacy-use`, `acceptable`), each with a label, an `effect` and a severity. Previously the engine would have had to switch on these strings in TypeScript. Verified against the same sources as the deadlines that use them. |
| `detectionConfidence` on `dsa` and `sha1` | `algorithms.json` | Closes the confidence half of G-07 and G-08. A regex cannot tell DSA signing from verification, or SHA-1 signing from HMAC, so those findings carry a multiplier and a review flag. |
| `bestPractice` on `aes-ecb` | `algorithms.json` | Closes G-09. Gives the finding a requirement and an SP 800-38A citation *without* a deadline, so it cannot render as a compliance failure. |
| Framework entries for `FIPS 186-5`, `SP 800-131A Rev 2`, `FIPS 180-4`, `SP 800-38A` | `frameworks.json` | The ids match the `framework` strings the algorithm deadlines already used, so obligations resolve a real framework name and applicability instead of a bare document string. |
| `findingObligations` on `CISA-QR` and `CNSA-2.0` | `frameworks.json` | Lets a framework attach an obligation to a finding by matching on the algorithm entry. CNSA 2.0's keeps its `needs-check` confidence and its per-category caveat. |

| Entry | Status |
|---|---|
| `deadlineTypes` — semantics of each term | ✅ `verified` (derived from the definitions already in this file and from IR 8547 §4) |
| `detectionConfidence` — multipliers | ⚠️ engineering judgement, not a standards claim. The *reason* text is verified; the numbers are ours. |
| `bestPractice` on AES-ECB — SP 800-38A citation | ✅ `verified` |
| New framework entries — titles, publishers, dates, URLs | ✅ `verified` |
| `findingObligations` — CISA-QR | ✅ `verified` (quotes the factsheet's inventory section) |
| `findingObligations` — CNSA-2.0 | ⚠️ `needs-check` — inherits G-01, still HTTP 403 |

---

## Changes in 0.3.1

No standards claim changed. `eddsa`'s `detectionGap: true` flag was **cleared**, because the
gap it recorded is closed: `SourceRegexCollector` now has an EdDSA pattern and the dependency
collector maps Ed25519 libraries (09-open-gaps.md G-06). Its `explanation` no longer says "the
current scanner does not detect it" — that sentence was customer-facing copy that stopped being
true. Set the flag again if a future entry is in the same position; it is how an
identified-but-undetected algorithm is tracked.

---

## Corrections made in 0.3.0

Verified against FIPS 186-5, SP 800-131A Rev 2, SP 800-38A and SP 800-38D by downloading each
PDF and reading the relevant section. Two more citations were **wrong**:

4. **MD5 was cited to SP 800-131A Rev 2.** MD5 appears **zero times** in that document. It was
   never a NIST-approved hash, so it does not appear in a transition standard — the correct
   framing is "not approved", not "deprecated", and there is no deadline to cite.
5. **AES-ECB was cited to SP 800-38D.** "ECB" appears **zero times** in SP 800-38D, which is the
   Galois/Counter Mode spec. ECB is defined in SP 800-38A as one of five **approved**
   confidentiality modes. Presenting AES-ECB as a NIST violation would be a false compliance
   claim; it is a best-practice finding.

And two findings that change how results should be reported:

- **DSA has been unapproved for signature generation since FIPS 186-5 (2023-02-03)** and its
  specifications were removed from the standard. It is a present-tense compliance failure with
  no runway, not a 2035 migration item. This is why it appears in no IR 8547 transition table.
- **SHA-1's status is use-dependent**: disallowed for signature generation, legacy-use for
  verification, and *acceptable* for non-signature applications that do not require collision
  resistance — so HMAC-SHA1 is acceptable per NIST. A blanket SHA-1 alert is incorrect.

## Corrections made in 0.2.0

Three claims in the 0.1.0 seed were **wrong**, and this is why the `needs-check` discipline
exists:

1. **`FIPS 206` was cited as a pending standard for Falcon.** No such published standard was
   confirmed. Falcon is "selected for ongoing standardization; that process is underway."
2. **CycloneDX was recorded as 1.6.** Current is **1.7** (2025-10-21).
3. **A five-stage CISA roadmap was invented.** The joint factsheet uses named sections, not
   numbered stages. This one would have been caught in public by any reader of the source.

Two substantive additions:

- **≥128-bit classical algorithms are also disallowed after 2035**, not just 112-bit ones. The
  seed only recorded the 112-bit row. Bigger keys do not buy time.
- **EdDSA** appears in IR 8547 Table 2 and the scanner did not detect it — flagged as
  `detectionGap: true` (flag cleared in 0.3.1; see above).

---

## Updating

Standards data changes by **pull request against these JSON files** — never a code change.

1. Edit the entry
2. Bump `dataVersion` (semver)
3. Set `retrievedAt` to today on every entry you touched
4. Attach `citation.url` and `citation.section`
5. Set `confidence` to `verified` **only if you personally opened the source document**

*Partly built:* the JSON **is** schema-validated, at API boot (see the sharp edge above), and
`lib/mappings/src/engine.test.ts` runs on every CI test job. What is still *not* built is the
check that blocks a `needs-check` entry from reaching a customer-facing report template. The
mitigation today is weaker: `confidence` travels with every obligation, so a renderer can label it
"indicative, unverified" — and the shared report page does — but nothing stops a template that
ignores the field.

### The draft-status rule

NIST IR 8547 is an **initial public draft**. Anything derived from it must be labelled *"NIST
draft guidance (IR 8547 ipd, November 2024)"* in customer-facing output. Verified ≠ final.

## Versioning contract

Reports pin the `dataVersion` they were generated with. A report from 2026-Q1 must be
regenerable byte-identically in 2028 — old versions stay in git history and the engine can load
a pinned version, not just `HEAD`.

## Re-verification cadence

Quarterly, and immediately on any of: IR 8547 going final, a new FIPS publication, a CycloneDX
release, or a CNSA 2.0 revision.
