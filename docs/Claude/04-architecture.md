# 04 — Architecture

Three seams need to change, in order of how much they hurt.

---

## 1. `findingsTable` keyed to `scanId` — the biggest structural problem

### What exists today

```ts
// lib/db/src/schema/findings.ts
export const findingsTable = pgTable("findings", {
  id: serial("id").primaryKey(),
  scanId: integer("scan_id").notNull(),   // ← findings belong to a run
  fileName: text("file_name").notNull(),
  lineNumber: integer("line_number").notNull(),
  severity: text("severity").notNull(),
  algorithm: text("algorithm").notNull(),
  nistReplacement: text("nist_replacement"),  // ← denormalised standards data
  nistStandard: text("nist_standard"),
  effortHours: real("effort_hours").notNull().default(1),
  explanation: text("explanation"),            // ← denormalised prose
});
```

**Findings are ephemeral per-run.** Every scan creates a fresh set. Consequences:

- ❌ Cannot answer *"has this been remediated?"* — only *"was it present in run 47?"*
- ❌ Cannot do drift detection — every scan is an island
- ❌ Cannot trend anything over time
- ❌ Cannot attach an owner, a waiver, or a due date to a thing that persists
- ❌ Standards data (`nistReplacement`, `nistStandard`, `explanation`) is **frozen into every
  row at write time** — when NIST updates guidance, historical rows silently disagree with new
  ones and there is no way to re-derive

That last point is what makes the mapping engine in [05](05-compliance-mapping.md) impossible
without this migration. You cannot have dynamic mapping when the mapping is copied into the
fact table.

### Target model

Three concepts instead of one:

```
asset          — a thing that has crypto, persists across scans
  ↑
observation    — a collector saw this at a point in time
  ↑
collection_run — one execution of one collector
```

```ts
// assets — stable identity, survives re-scans
export const assetsTable = pgTable("assets", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull(),
  fingerprint: text("fingerprint").notNull(),      // deterministic identity
  surface: text("surface").notNull(),              // source | dependency | tls | certificate | kms | config | ot
  algorithm: text("algorithm").notNull(),
  keySize: integer("key_size"),
  location: text("location").notNull(),            // path, host:port, cert serial, key ARN
  locationDetail: jsonb("location_detail"),        // surface-specific structured context

  // lifecycle
  status: text("status").notNull().default("active"),  // active | remediated | waived | gone
  firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
  lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),

  // ownership + risk inputs
  ownerId: integer("owner_id"),
  dataClassification: text("data_classification"),     // → X
  secrecyLifetimeYears: integer("secrecy_lifetime_years"),
  effortHours: real("effort_hours"),                   // → Y
  agilityScore: real("agility_score"),                 // 0..1, feeds Y
});

// observations — evidence, with provenance
export const observationsTable = pgTable("observations", {
  id: serial("id").primaryKey(),
  assetId: integer("asset_id").notNull().references(() => assetsTable.id),
  collectionRunId: integer("collection_run_id").notNull().references(() => collectionRunsTable.id),
  collector: text("collector").notNull(),          // which collector, which version
  collectorVersion: text("collector_version").notNull(),
  confidence: real("confidence").notNull(),        // 0..1 — regex is not certainty
  evidence: jsonb("evidence"),                     // line number, snippet, handshake detail
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Note what is **absent** from `assets`: `nistReplacement`, `nistStandard`, `explanation`,
`severity`. Those are all *derived* at read time by the mapping engine from versioned data.
That is the whole point.

### Asset fingerprint

Identity must be stable across re-scans but sensitive to real change.

| Surface | Fingerprint inputs |
|---|---|
| Source | `repo + path + algorithm + normalised-symbol` — **not** line number (line numbers shift on unrelated edits) |
| Dependency | `ecosystem + package + algorithm` |
| TLS | `host + port + algorithm` |
| Certificate | `issuer + serial` |
| KMS | `provider + key ARN/ID` |

**Anti-requirement:** do not include line number or file hash in the source fingerprint.
Reformatting a file must not orphan every asset in it and recreate them as new — that would
show up as a mass remediation followed by a mass regression, which is worse than useless in a
trend chart.

### Migration path

The existing data is a smoke test. Do this now, while that is true.

1. Add new tables alongside the old ones
2. Backfill `assets` from `findings` (one-time, best-effort)
3. Dual-write from the scanner during transition
4. Cut reads over to `assets`
5. Keep `scans` as a **collection run** record, drop `scans.code` (see below)
6. Drop `findings`

### Also: add foreign keys

`findings.scanId`, `scans.projectId` are plain `integer` columns with no `references()`. There
is nothing stopping orphaned rows today. Add real FKs during the migration.

### Also: stop storing customer source code

`scans.code` is `text` holding the **entire submitted file**, and `routes/scans.ts:38` writes it
unconditionally. For an enterprise product ingesting customer source, a full copy of that source
sitting in the primary database is a liability with no corresponding benefit — the findings are
what matter, not the input.

Store a **bounded snippet** on the observation for evidence (already done via `codeSnippet`),
and drop the full body. If replay is genuinely needed, make it opt-in per project and document
retention. See [08-security.md](08-security.md#source-code-handling).

---

## 2. `VULNERABILITY_PATTERNS` → collector interface

### What exists today

```ts
// artifacts/api-server/src/lib/scanner.ts:26
const VULNERABILITY_PATTERNS: Array<{
  pattern: RegExp; algorithm: string; severity: "critical" | "alert";
  nistReplacement: string; nistStandard: string; baseEffort: number; explanation: string;
}> = [ /* 7 entries */ ];

export function scanCode(code: string, fileName: string, language: string): ScanFinding[]
```

`scanCode()` walks lines and tests regexes. It is hardcoded to one surface and it bakes
standards data into the pattern definitions.

### Target

```ts
export interface Collector {
  readonly name: string;
  readonly version: string;
  readonly surface: Surface;
  readonly capabilities: { confidence: number; canDetermineKeySize: boolean };

  collect(target: CollectionTarget, ctx: CollectorContext): AsyncIterable<RawObservation>;
}

// Every collector emits this — the normalised currency of the system
export interface RawObservation {
  algorithm: string;          // canonical name, matched against mappings/algorithms.json
  keySize?: number;
  location: string;
  locationDetail?: Record<string, unknown>;
  confidence: number;         // regex ≈ 0.7, TLS handshake ≈ 1.0
  evidence: Record<string, unknown>;
}
```

The existing regex scanner becomes `SourceRegexCollector` — one implementation, unchanged in
behaviour, with `nistReplacement` / `nistStandard` / `explanation` / `severity` **removed** from
its pattern table because those now come from `mappings/`.

**Acceptance for this seam:** adding the dependency collector requires zero edits to
`scanner.ts` and zero edits to the API routes.

### NIST reached the same conclusion — align with it

**NIST SP 1800-38B** is the NCCoE practice guide for *cryptographic discovery tools*, i.e. our
exact product category. Its §4.1.4 identifies the same normalisation problem this seam solves:

> *"The reports produced by the discovery platforms in this demonstration are unique in that they
> do not use a common format for representing the discovery results. In a contrived example, a
> network discovery platform may identify a host system as `host.example.com:443`, whereas
> another may omit the port number (`host.example.com`). Therefore, we identified the need for a
> common format to represent normalized discovery reports."*

That is `RawObservation`. The design is right — but NIST also specifies **data elements we do
not currently carry**, and matching them is cheap interoperability:

| Element | Representation |
|---|---|
| IP (v4/v6) address | String |
| Destination port | Number |
| Hostname | String |
| Application layer protocol | IANA Service Name or TLS ALPN ID (RFC 6335 §5.1 / RFC 7301) |
| Application software | **CPE 2.3** (NIST IR 7695) |
| Operating system | **CPE 2.3** |
| Device vendor | **CPE 2.3** |

Our `locationDetail` is freeform `jsonb`. For network-surface assets it should carry these named
fields, with **CPE 2.3** for software/OS/vendor identification rather than free text. CPE also
gives us a join key against existing vulnerability tooling the customer already runs — which is
the same argument as CBOM export, applied to identity instead of format.

§4.1.4 explicitly *"does not define a schema, but instead defines descriptive data elements"* —
so this is alignment guidance, not a serialisation target. CycloneDX CBOM remains the wire
format. Tracked as [G-15](09-open-gaps.md).

### Confidence should encode modality, not just a number

SP 1800-38B names four ways discovery data is obtained: **passive network observations, active
network scans, endpoint monitoring, and configuration information**. These have genuinely
different evidential weight, and an auditor will ask which one produced a given finding.

Carry the modality on the observation alongside the numeric confidence, rather than collapsing
both into one float.

### One reprioritisation signal

§4.1.2 puts **binary scanning inside the core operational-systems domain**, specifically to
catch *"algorithms that there might not be a source code for, as, for example, in third-party"*
components. We have binaries as B10, `deferred`, `P3`. NIST treats it as central to discovery,
not as an advanced extra. Worth revisiting — see [02-roadmap.md](02-roadmap.md).

### Confidence is not decoration

A regex match on `\bDH\b` in a comment and a completed TLS handshake advertising
`ECDHE-RSA-AES128-GCM-SHA256` are not the same quality of evidence. The current 7 patterns are
broad — `/\bRSA/i` matches prose, variable names, and the string "RSAT". Carrying confidence
through to the UI and filtering reports by it is how the inventory stays credible when someone
audits it.

---

## 3. Split the risk engine from detection

### What exists today

```ts
// scanner.ts
export function computeScanResult(findings: ScanFinding[], totalLines: number): ScanResult
```

Risk is derived purely from what was detected. Two assets with identical crypto and wildly
different business exposure score identically.

### Target

```ts
interface RiskInput {
  asset: Asset;
  secrecyLifetimeYears: number;    // X
  effortYears: number;             // Y — from effortHours ÷ agility
  qDayScenario: QDayScenario;      // Z
}

interface MoscaVerdict {
  scenario: "conservative" | "central" | "aggressive";
  x: number; y: number; z: number;
  breached: boolean;
  breachMarginYears: number;       // negative = safe, positive = already too late
  narrative: string;               // the board-deck sentence
}

function assessRisk(input: RiskInput): { verdicts: MoscaVerdict[]; score: number };
```

Live in a new `lib/risk/` package so it is testable in isolation and shared between the API and
report generation.

**Y is not just effort hours.** `effortHours ÷ agilityScore` — a low-agility asset takes
disproportionately longer than its raw hour count suggests, because the change touches many
places and carries more regression risk.

---

## Package layout

```
lib/
  db/            existing — extend with assets/observations
  collectors/    NEW — Collector interface + implementations
  mappings/      NEW — loader + validator for docs/Claude/mappings/*.json
  risk/          NEW — Mosca engine, agility scoring
  cbom/          NEW — CycloneDX 1.7 import/export
  api-spec/      existing — extend OpenAPI, regenerate
artifacts/
  api-server/    existing — routes get thinner, logic moves to lib/
  quantaxscan/        existing
```

Keeping collectors in `lib/` rather than inside `api-server` means they can also run as a
standalone on-prem agent — which matters a great deal if the SaaS-source-code risk in
[01-strategy.md](01-strategy.md#what-would-falsify-this-thesis) materialises.

---

## API surface changes

| Existing | Change |
|---|---|
| `POST /api/scans` | Keep for demo/single-file. Becomes a thin wrapper over a collection run |
| `POST /api/scans/multi` | Keep |
| `GET /api/projects/:id/findings` | Deprecate → `GET /api/inventory/assets` |
| — | `GET /api/inventory/assets` — filter by surface, algorithm, status, risk |
| — | `GET /api/inventory/assets/:id/observations` — evidence trail |
| — | `GET /api/inventory/cbom` — CycloneDX 1.7 export |
| — | `POST /api/inventory/cbom` — import |
| — | `GET /api/inventory/coverage` — what we have *not* looked at (feeds D3) |
| — | `GET /api/compliance/obligations` — mapped obligations per asset |
| — | `POST /api/waivers` — exception register |
| — | `GET /api/drift` — new/changed/resolved since a timestamp |

Regenerate the Orval client from `lib/api-spec/openapi.yaml` rather than hand-writing — that
pipeline already exists and works.
