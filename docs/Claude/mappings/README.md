# mappings/ — versioned standards data

**These files are data, not code.** They are what makes compliance mapping dynamic. Standards
change; nothing in `src/` should have to change when they do.

| File | Purpose |
|---|---|
| `algorithms.json` | Canonical algorithms → PQC replacements, deprecation timelines |
| `frameworks.json` | Framework definitions, versions, applicability rules |
| `controls.json` | Crosswalk to general control frameworks |

See [../05-compliance-mapping.md](../05-compliance-mapping.md) for the engine design.

**Sharp edge — `algorithms.json` is a build input, not a runtime file.**
`lib/collectors/src/algorithm-mapping.ts` imports it as a JSON module (`with { type: "json" }`)
so esbuild inlines it into the API bundle; there is no runtime read of this path, and nothing
schema-validates it at boot. Editing the JSON therefore has no effect until the API is rebuilt
and redeployed, and a malformed entry surfaces as a build error or a missing lookup at scan time
rather than a startup failure. `frameworks.json` and `controls.json` have no consumer yet.

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
- **EdDSA** appears in IR 8547 Table 2 and the current scanner does not detect it — flagged as
  `detectionGap: true`.

---

## Updating

Standards data changes by **pull request against these JSON files** — never a code change.

1. Edit the entry
2. Bump `dataVersion` (semver)
3. Set `retrievedAt` to today on every entry you touched
4. Attach `citation.url` and `citation.section`
5. Set `confidence` to `verified` **only if you personally opened the source document**

*Intended, not yet built:* CI validating against the JSON schema and blocking any `needs-check`
entry referenced by a customer-facing report template. There is no CI in this repo today, and the
sharp edge above is why that matters — nothing checks these files but a rebuild.

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
