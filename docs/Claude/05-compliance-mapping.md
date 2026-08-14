# 05 — Dynamic compliance mapping

## The problem with what exists

Standards data used to be literals in the detection layer's pattern table. A2 moved it out: the
pattern table now carries detection only, and `nistReplacement` / `nistStandard` / `explanation` /
`severity` are derived by canonical algorithm name from `mappings/algorithms.json`
(`lib/collectors/src/algorithm-mapping.ts`) as each finding is built. See
[04-architecture.md](04-architecture.md) for the before/after.

That lookup still exists and still backs `severity`/`effortHours` on a `ScanFinding`. C1, below,
is the engine, and it is now built. All three original failures are addressed:

1. ~~**Standards change; code must not.**~~ A NIST revision is a `mappings/*.json` edit. It still
   needs a rebuild and deploy, because the JSON is imported as a JSON module and esbuild inlines
   it into the API bundle at build time (see [mappings/README.md](mappings/README.md)) — but that
   is a deploy step, not a code change.
2. ~~**History becomes inconsistent.**~~ Obligations are resolved on the way *out* of every
   findings route and never written to a row (`artifacts/api-server/src/lib/compliance.ts`). A
   finding stored in 2026 and read in 2028 answers with 2028's mapping data. The legacy
   `nistReplacement`/`nistStandard`/`explanation` columns are still written and still frozen —
   they are the pre-C1 display path and go away with the `observations` read cutover, which is
   still not built.
3. ~~**Only one framework.**~~ Obligations carry their framework, and frameworks are rows in
   `frameworks.json`, not columns. Adding NSM-10 or DORA is a data pull request.

For a product whose entire value is *"here is your defensible compliance position"*, a compliance
answer that cannot be re-derived — and that only speaks one framework — is not defensible.

---

## The engine: `lib/mappings` `built` (C1)

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

**Contract:** the engine is a pure function of `(input, mappings@version, asOf, profile)`.
Same inputs always produce the same output. That is what makes historical reports
reproducible — a report from 2026-Q1 can be regenerated exactly, because the mapping version it
used is recorded with it.

```ts
import { mappingEngine } from "@workspace/mappings";

const mapping = mappingEngine.resolve(
  { algorithm: "DSA", keySize: null, confidence: 0.7 },
  { asOf: new Date(), version: "0.4.0", profile: { jurisdiction: "US" } },
);
```

Full types are in `lib/mappings/src/types.ts`. The shape that matters to a consumer:

```ts
interface MappingResult {
  algorithm: string; algorithmId: string;
  quantumVulnerable: boolean;
  riskTrack: "post-quantum" | "classical-hygiene";
  complianceStatus: "immediate-failure" | "future-obligation" | "no-obligation";
  bucket: "immediate-compliance-failure" | "pqc-migration" | "classical-hygiene"
        | "best-practice" | "no-obligation";
  headline: string;                 // composed from data fields; safe to print
  useDependent: boolean;            // true when the standard's answer depends on the use
  useConditions: Array<{ use: string; status: string; permitted: boolean; framework: string }>;
  obligations: Obligation[];
  detection: { multiplier: number; adjustedConfidence?: number; reviewRequired: boolean; reason: string | null };
  reportingNote: string | null;
  caveats: string[];
  citation: Citation;
  dataVersion: string;              // pin this with the report
  asOf: string;
}

interface Obligation {
  framework: string;                // framework id exactly as frameworks.json writes it
  frameworkName?: string;
  requirement: string;
  severity: "critical" | "high" | "medium" | "informational";
  replacement?: { algorithm: string; standard: string; purpose?: string; note?: string };
  deadline?: { type: string; label: string; effect: "prohibition" | "caution" | "permitted";
               inEffect: boolean; after?: string; in?: string; since?: string; appliesTo?: string };
  citation: { document: string; section?: string; url: string; retrievedAt?: string };
  confidence: string;               // "verified" | "needs-check", from the data, never upgraded
  draftStatus?: string;             // present when the citing document is a draft
  caveats: string[];
  source: "algorithm-deadline" | "algorithm-replacement" | "algorithm-best-practice" | "framework";
}
```

### The rule that makes it C1 rather than a bigger lookup

No algorithm name, date, citation or standards claim appears in `lib/mappings`'s TypeScript. Even
the deadline vocabulary is data: `algorithms.json` carries a `deadlineTypes` block declaring, for
each term (`disallowed`, `not-approved`, `legacy-use`, `acceptable`, ...), its customer-facing
label, its `effect` (`prohibition` / `caution` / `permitted`) and its severity. The engine reads
that instead of switching on strings, so a revision that introduces a new *kind* of rule is still
a JSON pull request. A term the block does not define is surfaced with a caveat and treated
conservatively — it can never manufacture a compliance failure.

`lib/mappings/src/engine.test.ts` is where the M2 exit criterion is actually proven: it clones the
bundled data, changes RSA's disallowance from 2035 to 2040, adds an algorithm that did not exist
when the file was written, and adds a new deadline type — then asserts the output follows, with
no TypeScript edit. If that test ever needs a code change to pass, C1 has regressed.

### Where obligations are resolved

On the way **out**, in `artifacts/api-server/src/lib/compliance.ts`, on every route that returns
findings. Nothing is persisted: no migration, no new column, and a mappings update reaches
findings written before it. One `asOf` is used per response so two findings in the same report can
never land on opposite sides of a deadline.

The one deliberate exception is a **shared report** (`POST /api/reports`), which stores the
client's snapshot verbatim. That is the pinning contract below working as intended — the snapshot
carries the `dataVersion` and `asOf` that produced it, and re-rendering it later must not silently
restate the obligations under newer data.

### What A4 (the Mosca risk engine) consumes

A4 must not re-derive any of this. The contract:

| Field | A4 uses it for |
|---|---|
| `riskTrack` / `countsTowardPostQuantumScore` | **G-10.** `false` for MD5, SHA-1 and AES-ECB. A hygiene finding must not enter the post-quantum risk score; report it in a separate panel. |
| `bucket` | Grouping and ordering. `immediate-compliance-failure` outranks `pqc-migration` — a present-tense failure is not a scheduled migration and must not be scored as one. |
| `obligations[].deadline` | The Y (migration time) and deadline side of Mosca. `inEffect` says whether the rule already binds at `asOf`; `after`/`in`/`since` give the date. Do not parse `requirement` prose for a year. |
| `detection.reviewRequired` / `multiplier` | Confidence weighting. A DSA or SHA-1 finding is not established until a human classifies the call site. |
| `obligations[].confidence` and `caveats` | A `needs-check` obligation renders as "indicative, unverified" and must not contribute to a compliance percentage. |
| `dataVersion` | Record it on the scored result, so the score is reproducible. |

`keySize` is accepted on the input and is not yet used to select between the 112-bit and ≥128-bit
IR 8547 rows — see G-05. Both rows are returned as obligations today; A4 must not assume exactly
one applies.

### Versioning: what `version` actually does

`resolve(..., { version })` asserts that the loaded data *is* that version and throws
`MappingVersionError` otherwise. It does not load a historical snapshot — the engine holds exactly
one version, the one inlined at build time. Regenerating a 2026-Q1 report byte-identically in 2028
therefore means building against that git revision of `mappings/`, not asking the running engine
for it. A loader that reads a pinned version at runtime is not built.

### Why deadlines must be data, not constants

The single most valuable output for a CISO is not *"RSA is bad"* — everyone knows that. It is:

> *"This certificate expires 2034-06-01. Under NIST IR 8547 draft guidance, RSA-2048 is
> disallowed after 2035. Under your conservative Q-Day scenario it is exposed from 2030.
> You have one renewal cycle to fix this."*

Every number in that sentence comes from versioned data with a citation. None of it should be
in a `.ts` file.

---

## Data files

Live in [`mappings/`](mappings/) (i.e. `docs/Claude/mappings/` — the doc-relative path the
repository actually uses), versioned in git, loaded and schema-validated at boot by
`lib/mappings/`. Validation runs at module init in `lib/mappings/src/data.ts`, so a malformed
file fails API startup rather than turning into a missing obligation mid-report. The schema is
deliberately lenient — unknown keys pass, and the deadline-type vocabulary is open — because a
data pull request must never be blocked by the code refusing to recognise a new field.

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
   is referenced by a *customer-facing* report template — **not built.** What exists today is
   boot-time validation (above) and `lib/mappings/src/engine.test.ts`; nothing blocks a
   `needs-check` entry from reaching a template, only the `confidence` field travelling with the
   obligation so the renderer can label it.
3. Merge → reports regenerate with new mappings; historical reports keep their pinned version

Two blocks in `algorithms.json` exist purely so the engine never has to hardcode a rule:

| Block | Purpose |
|---|---|
| `deadlineTypes` | Declares every value `deadlines[].type` may take, with its label, `effect` and severity. Add a term here and the engine understands it. |
| `detectionConfidence` (per entry) | A `multiplier`, `reviewRequired` flag and customer-facing `reason` for algorithms whose compliance answer depends on call-site context a collector cannot see. Present on `dsa` and `sha1` (G-07, G-08). |

`frameworks.json` entries may carry `findingObligations` — framework-level requirements matched
against an algorithm entry by `quantumVulnerable`, `algorithmIds`, `families` or `purposes`. That
is how CISA-QR's inventory obligation and CNSA 2.0's suite requirement attach to a finding without
either being named in TypeScript.

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
engine filters by the customer's declared profile (`resolve(..., { profile })`). Frameworks that
do not apply are hidden, not shown at 0%.

The default is conservative: an axis a framework restricts, and the profile does not declare, is
treated as *not matching*. Call `resolve` with no profile and only universally-applicable
frameworks come back — CNSA 2.0 is absent unless the caller says
`{ jurisdiction: "US", sector: "government", systemType: "national-security-system" }`, and even
then every CNSA obligation carries `confidence: "needs-check"` and the G-01 caveat, because the
primary source is still unverified.

---

## Worked example

Abridged — the real `Obligation` shape is above, and the engine also returns the surrounding
`MappingResult` (bucket, use conditions, detection qualifier, `dataVersion`).

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
