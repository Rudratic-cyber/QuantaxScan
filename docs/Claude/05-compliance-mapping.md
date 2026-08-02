# 05 — Dynamic compliance mapping

## The problem with what exists

Standards data used to be literals in the detection layer's pattern table. A2 moved it out: the
pattern table now carries detection only, and `nistReplacement` / `nistStandard` / `explanation` /
`severity` are derived by canonical algorithm name from `mappings/algorithms.json`
(`lib/collectors/src/algorithm-mapping.ts`) as each finding is built. See
[04-architecture.md](04-architecture.md) for the before/after.

That is a lookup, not the engine below. Of the three original failures, one is addressed and two
are not:

1. ~~**Standards change; code must not.**~~ Mostly addressed — a NIST revision is now a
   `mappings/algorithms.json` edit rather than a source edit. It still needs a rebuild and deploy,
   because the JSON is imported as a JSON module and esbuild inlines it into the API bundle at
   build time (see [mappings/README.md](mappings/README.md)).
2. **History becomes inconsistent.** Still true — `routes/scans.ts` copies the derived
   `nistReplacement`/`nistStandard`/`explanation` into every `findings` row at write time, and
   every route reads `findings`. Rows written before an update permanently disagree with rows
   written after. The `observations` table deliberately stores no standards data, so once reads
   cut over to it this failure goes away; that cutover is not built.
3. **Only one framework.** Still true — there is nowhere to put CNSA 2.0, CISA, NSM-10, PCI, or
   DORA without adding a column per framework.

For a product whose entire value is *"here is your defensible compliance position"*, a compliance
answer that cannot be re-derived — and that only speaks one framework — is not defensible.

---

## Target: data-driven mapping engine

```
observation (algorithm, keySize, surface, confidence)
        │
        ▼
┌───────────────────────┐     ┌──────────────────────────────┐
│   Mapping engine      │◀────│ mappings/algorithms.json     │  versioned
│   (pure function)     │     │ mappings/frameworks.json     │  data, not code
└───────────────────────┘     │ mappings/controls.json       │
        │                     └──────────────────────────────┘
        ▼
obligations[] — {framework, requirement, deadline, replacement, severity, citation}
```

**Contract:** the engine is a pure function of `(observation, mappings@version, asOfDate)`.
Same inputs always produce the same output. That is what makes historical reports
reproducible — a report from 2026-Q1 can be regenerated exactly, because the mapping version it
used is recorded with it.

```ts
interface MappingEngine {
  resolve(obs: NormalisedObservation, asOf: Date, version?: string): Obligation[];
}

interface Obligation {
  framework: string;        // "NIST-FIPS" | "NIST-IR-8547" | "CNSA-2.0" | "CISA-QR" | "OMB-M-23-02"
  requirement: string;
  severity: "critical" | "high" | "medium" | "informational";
  replacement?: { algorithm: string; standard: string; parameterSet?: string };
  deadline?: { date: string; type: "deprecated" | "disallowed" | "required"; appliesTo: string };
  citation: { document: string; section?: string; url: string; retrievedAt: string };
  confidence: "verified" | "needs-check";
}
```

### Why deadlines must be data, not constants

The single most valuable output for a CISO is not *"RSA is bad"* — everyone knows that. It is:

> *"This certificate expires 2034-06-01. Under NIST IR 8547 draft guidance, RSA-2048 is
> disallowed after 2035. Under your conservative Q-Day scenario it is exposed from 2030.
> You have one renewal cycle to fix this."*

Every number in that sentence comes from versioned data with a citation. None of it should be
in a `.ts` file.

---

## Data files

Live in [`mappings/`](mappings/), versioned in git, loaded and schema-validated at boot by
`lib/mappings/`.

| File | Contains |
|---|---|
| `algorithms.json` | Canonical algorithms → PQC replacements, deprecation timelines, citations |
| `frameworks.json` | Framework definitions, versions, applicability, source URLs |
| `controls.json` | Crosswalk to control frameworks (ISO 27001, SOC 2, PCI DSS 4, DORA) |

Each file carries a `schemaVersion`, a `dataVersion`, and a `retrievedAt` per entry.

### Update workflow

Standards data changes through a **pull request against the JSON**, never a code change:

1. Update the entry, bump `dataVersion`, set `retrievedAt`, attach the citation URL
2. CI validates against the JSON schema and fails on any `confidence: "needs-check"` entry that
   is referenced by a *customer-facing* report template
3. Merge → reports regenerate with new mappings; historical reports keep their pinned version

---

## Provenance and freshness

**Every regulatory claim we surface must carry a citation and a confidence tag.**

This is not bureaucracy. A CISO hands our report to an auditor; the auditor asks "says who?";
if the answer is "the vendor's dashboard" the report is worthless. If it is "NIST IR 8547 §3.2,
retrieved 2026-07-14, link" the report does its job.

| Tag | Meaning | Allowed in customer reports? |
|---|---|---|
| `verified` | Checked against the primary source on `retrievedAt` | ✅ yes |
| `needs-check` | Believed correct, not confirmed against the primary source | ⚠️ internal only — renders as "indicative, unverified" |

### Standards status — verified 2026-08-01

| Item | Status | Confidence |
|---|---|---|
| FIPS 203 — ML-KEM | **Final**, published 2024-08. Sets: ML-KEM-512/768/1024 (cat 1/3/5) | ✅ `verified` |
| FIPS 204 — ML-DSA | **Final**, published 2024-08. Sets: ML-DSA-44/65/87 (cat 2/3/5) | ✅ `verified` |
| FIPS 205 — SLH-DSA | **Final**, published 2024-08. SHA2/SHAKE at 128/192/256 | ✅ `verified` |
| SP 800-208 — LMS/HSS, XMSS | Final. Stateful hash-based signatures | ✅ `verified` |
| FN-DSA (Falcon) | **NOT published.** "Selected for ongoing standardization; that process is underway" | ✅ `verified as unpublished` |
| HQC | **NOT published.** 4th-round selection, standardization underway | ✅ `verified as unpublished` |
| NIST IR 8547 | **STILL AN INITIAL PUBLIC DRAFT.** Published 2024-11-12, comments closed 2025-01-10 | ✅ `verified` |
| CISA/NSA/NIST factsheet | "As of August 17, 2023", TLP:CLEAR. **No numbered stages — named sections** | ✅ `verified` |
| CycloneDX | **1.7**, released 2025-10-21. ECMA-424. CBOM = algorithms, keys, certificates | ✅ `verified` |
| PCI DSS 4.0 §12.3.3 | Mandatory since 2025-03-31 — crypto inventory, annual review | ⚠️ `needs-check` (secondary sources only) |
| CNSA 2.0 | Per-category timeline; indicative 2025/2030/2033 dates | ⚠️ `needs-check` (**nsa.gov returns 403**) |
| NSM-10 / OMB M-23-02 | 2035 target corroborated by IR 8547 §4. Format unconfirmed | ⚠️ `needs-check` |

#### Three corrections this verification produced

1. **`FIPS 206` does not exist as a published standard.** Falcon is still in standardization.
   Any content citing "FIPS 206" is wrong.
2. **CycloneDX is 1.7, not 1.6.** Target 1.7 for the exporter.
3. **The CISA factsheet has no five-stage roadmap.** Earlier drafts of these docs invented one.
   It uses named sections. Corrected in [06-cisa-dashboard.md](06-cisa-dashboard.md).

#### The most important nuance: bigger keys do not buy time

IR 8547 Tables 2 and 4 give **two** rows per algorithm family:

| Security strength | Transition |
|---|---|
| 112 bits | Deprecated after **2030**, disallowed after **2035** |
| ≥ 128 bits | Disallowed after **2035** |

So RSA-3072 and P-384 are disallowed on the *same* 2035 date as RSA-2048 and P-256. The larger
parameters only avoid the 2030 deprecation milestone. Vendors routinely get this wrong, and
correcting it is a credibility win in a sales conversation.

> ⚠️ **IR 8547 is a DRAFT.** Every customer-facing use of the 2030/2035 dates must be labelled
> *"NIST draft guidance (IR 8547 ipd, November 2024)"*. Presenting draft dates as final binding
> guidance is exactly the error that loses a technically literate buyer.

#### Still blocked

`nsa.gov`, `media.defense.gov` and `cisa.gov` all return **HTTP 403** to automated fetches. CNSA
2.0's per-category timeline therefore remains unverified and a human must open the CNSA 2.0 FAQ
(Ver 2.1, December 2024) directly. The CISA factsheet was verified via the NIST NCCoE-hosted
copy of the same document.

---

## Applicability — do not over-claim

Not every framework applies to every customer. CNSA 2.0 binds US national security systems;
OMB M-23-02 binds US federal civilian agencies. Showing a UK bank a CNSA 2.0 compliance
percentage is noise that damages credibility.

`frameworks.json` carries an `applicability` block — sector, jurisdiction, system type — and the
engine filters by the customer's declared profile. Frameworks that do not apply are hidden, not
shown at 0%.

---

## Worked example

Input observation:

```json
{ "algorithm": "RSA", "keySize": 2048, "surface": "certificate",
  "location": "cn=api.example.com", "confidence": 1.0,
  "locationDetail": { "notAfter": "2034-06-01" } }
```

Resolved obligations (`asOf: 2026-08-01`):

```json
[
  { "framework": "NIST-FIPS", "requirement": "Migrate key establishment to ML-KEM",
    "severity": "critical",
    "replacement": { "algorithm": "ML-KEM-768", "standard": "FIPS 203" },
    "citation": { "document": "FIPS 203 (final, August 2024)",
                  "url": "https://csrc.nist.gov/projects/post-quantum-cryptography",
                  "retrievedAt": "2026-08-01" },
    "confidence": "verified" },

  { "framework": "NIST-IR-8547", "requirement": "RSA at 112-bit security deprecated after 2030",
    "severity": "high",
    "deadline": { "after": "2030", "type": "deprecated", "appliesTo": "RSA, 112 bits" },
    "citation": { "document": "NIST IR 8547 ipd", "section": "Table 4",
                  "url": "https://csrc.nist.gov/pubs/ir/8547/ipd",
                  "retrievedAt": "2026-08-01" },
    "draftStatus": "INITIAL PUBLIC DRAFT — label as draft guidance",
    "confidence": "verified" },

  { "framework": "NIST-IR-8547", "requirement": "RSA disallowed after 2035 at ALL key sizes",
    "severity": "critical",
    "deadline": { "after": "2035", "type": "disallowed", "appliesTo": "RSA, 112 and >=128 bits" },
    "citation": { "document": "NIST IR 8547 ipd", "section": "Table 4",
                  "url": "https://csrc.nist.gov/pubs/ir/8547/ipd",
                  "retrievedAt": "2026-08-01" },
    "draftStatus": "INITIAL PUBLIC DRAFT — label as draft guidance",
    "confidence": "verified" }
]
```

Combined with the Mosca engine, the asset renders as:

> **api.example.com** — RSA-2048 certificate, valid to **2034-06-01**.
>
> Under NIST draft guidance (IR 8547 ipd, Nov 2024), RSA is **deprecated after 2030** and
> **disallowed after 2035** — at every key size, so re-issuing at RSA-3072 does not help.
> Exposed under the conservative scenario from **2030**, which is **before this certificate
> expires**.
>
> **Action:** do not renew with RSA. Next renewal must be PQC or hybrid.

That is the output the product exists to produce — and every date in it now traces to a cited
primary source with a retrieval date and an explicit draft-status label.
