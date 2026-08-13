# 04 — Architecture

Three seams need to change, in order of how much they hurt.

> **Status, 2026-08-02: seam 1 and seam 2 are implemented.** `assets`,
> `observations` and `collection_runs` exist in `lib/db/src/schema/`, real
> FKs were added to `findings.scanId`/`scans.projectId`, and the
> `Collector`/`RawObservation` contract lives in the new `@workspace/collectors`
> package with `SourceRegexCollector` as its first implementation. What
> changed from the design below, and why, is called out inline. Seam 3 (the
> Mosca risk engine, A4) is not built by this change. See
> [09-open-gaps.md](09-open-gaps.md) G-05/G-11/G-15 for exactly how far this
> closes each gap, and "Migration path" below for what is deliberately not
> done yet (read cutover, dropping `findings`, dropping `scans.code`).

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
// lib/db/src/schema/assets.ts (as built)
export const assetsTable = pgTable("assets", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull(),  // no FK yet — no organizations table (F2 is out of scope)
  fingerprint: text("fingerprint").notNull(),      // deterministic identity — unique per (organizationId, fingerprint), not globally
  surface: text("surface").notNull(),              // source | dependency | tls | certificate | kms | config | ot | binary — CHECK constraint
  algorithm: text("algorithm").notNull(),
  keySize: integer("key_size"),                    // parameter size (2048, 384, ...), null when undetermined — never a guessed default. See G-05.
  location: text("location").notNull(),            // path, host:port, cert serial, key ARN
  locationDetail: jsonb("location_detail"),        // validated discriminated LocationDetail at the app boundary — see @workspace/collectors

  // lifecycle
  status: text("status").notNull().default("active"),  // active | remediated | waived | gone — CHECK constraint
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
// lib/db/src/schema/observations.ts (as built)
export const observationsTable = pgTable("observations", {
  id: serial("id").primaryKey(),
  assetId: integer("asset_id").notNull().references(() => assetsTable.id, { onDelete: "cascade" }),
  collectionRunId: integer("collection_run_id").notNull().references(() => collectionRunsTable.id, { onDelete: "cascade" }),
  collector: text("collector").notNull(),          // which collector, which version
  collectorVersion: text("collector_version").notNull(),
  confidence: real("confidence").notNull(),        // 0..1 — regex is not certainty
  discoveryModality: text("discovery_modality").notNull(), // added per the qx-sp1800-38b report — see "Discovery modality" below. CHECK constraint.
  evidence: jsonb("evidence"),                     // line number, snippet, handshake detail — and this observation's own algorithm/keySize/location facts
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Note what is **absent** from `assets`: `nistReplacement`, `nistStandard`, `explanation`,
`severity`. Those are all *derived* at read time from `docs/Claude/mappings/algorithms.json`
(`lib/collectors/src/algorithm-mapping.ts`) rather than a full mapping engine (C1 is separate,
out of scope here). That is the whole point.

**Divergence from the original sketch above:** `algorithm`/`keySize`/`location`/`locationDetail`
live on `assets` only, not duplicated onto `observations` — an observation's own facts (including
a per-observation `keySize`, determined or not) are recorded in that observation's `evidence`
jsonb instead of dedicated columns. This keeps `observations` matching the shape actually
specified here, while still letting an ingestion path preserve per-observation history (which
collection run determined which `keySize`) without a schema that grows a column per surface.

### Asset fingerprint

Identity must be stable across re-scans but sensitive to real change.

| Surface | Fingerprint inputs |
|---|---|
| Source | `repo + path + algorithm + normalised-symbol` — **not** line number (line numbers shift on unrelated edits) |
| Dependency | `ecosystem + package + algorithm` |
| TLS | `host + port + algorithm` |
| Certificate | `issuer + serial` |
| KMS | `provider + key ARN/ID` |
| Binary (added — see below) | `target-or-repository + packageIdentity-or-componentName + artifactPath + binaryFormat + architecture + algorithm + evidenceDiscriminator` — **not** a content digest/sha256 |

**Anti-requirement:** do not include line number or file hash in the source fingerprint.
Reformatting a file must not orphan every asset in it and recreate them as new — that would
show up as a mass remediation followed by a mass regression, which is worse than useless in a
trend chart. The same anti-requirement applies to binary: do not put a content digest (sha256)
in a binary asset's fingerprint — a routine rebuilt binary would otherwise orphan-and-recreate
the asset the same way a reformatted source file would. Store the digest in observation
evidence instead, where a changed digest simply records a new observation of the same asset.
[Source: qx-sp1800-38b investigation report, §"Binary fingerprint rule".]

**As built:** `computeFingerprint()` in `lib/collectors/src/fingerprint.ts` hashes (SHA-256) a
JSON-encoded, explicitly ordered array of the fields above per surface — not a delimiter-joined
string — so a field value that happens to contain the delimiter cannot collide two distinct
inputs into the same fingerprint. It currently implements `source`, `dependency`, `tls`,
`certificate`, `kms` and `binary`; `config`/`ot` have no fingerprint rule yet because no
collector for them exists.

### Migration path

The existing data is a smoke test. Do this now, while that is true.

1. ✅ **Add new tables alongside the old ones** — `assets`, `observations`, `collection_runs`
   (`lib/db/src/schema/`); migration generated at `lib/db/drizzle/`.
2. ✅ **Backfill `assets` from `findings` (one-time, best-effort)** — `scripts/src/backfill-assets.ts`.
   Run `pnpm --filter @workspace/scripts run cleanup-orphans` first — deleting orphaned
   `findings`/`scans` rows so the new foreign keys below can actually be added — then the
   generated migration (or `pnpm --filter @workspace/db run push`, this project's existing
   convention), then `pnpm --filter @workspace/scripts run backfill-assets`.
   Not executed against the live database by this change: the sandboxed environment this change
   was authored in has no credentials for it. All three steps were exercised against a real
   (embedded) Postgres via `@electric-sql/pglite` in tests instead — see
   `lib/db/src/schema/asset-model.test.ts` and `artifacts/api-server/src/lib/asset-ingest.test.ts`.
3. ✅ **Dual-write from the scanner during transition** — `POST /scans` and `POST /scans/multi`
   in `artifacts/api-server/src/routes/scans.ts` now also call
   `artifacts/api-server/src/lib/asset-ingest.ts`'s `ingestSourceObservations()` alongside the
   existing `findings` insert. Dual-write failures are logged, not propagated — the legacy path
   must keep working during the transition even if the new path has an issue. This same function
   also drives the `active` → `gone` lifecycle transition: any previously-active asset at a
   location this call fully rescanned but did not reobserve is marked `gone` in place (never
   deleted), and reobserving it later reactivates the same row (`gone` → `active` only; `waived`
   and `remediated` survive re-observation untouched). Reconciliation is scoped per scanned file,
   not per repo — see the function for why. The whole ingest is one transaction and a fixed number
   of statements regardless of detection count: observations are collapsed to one row per
   fingerprint and upserted with `ON CONFLICT DO UPDATE`, so a concurrent scan of the same project
   cannot lose the dual-write to a unique-index violation, and `collection_runs.observationCount`
   cannot outlive a partial write.
4. ⬜ **Cut reads over to `assets`** — **deliberately not done in this change.** `stats.ts`,
   `projects.ts` (`GET /projects/:id/findings`) and `reports.ts` all read `findings` today, and
   there is no `GET /api/inventory/assets` yet. Cutting reads over is a real piece of work (new
   endpoints, a frontend that consumes them) and doing it half-way — some reads on `assets`, some
   still on `findings` — is exactly the two-sources-of-truth state this migration exists to avoid.
   Treat it as the next scoped change, not a loose end of this one.
5. ⬜ **Keep `scans` as a collection run record, drop `scans.code`** — not done. `scans.code`
   still stores the full submitted source (see "Also: stop storing customer source code" below);
   this change did not touch that, since it is a data-retention decision, not a schema-migration
   one, and touches the security work track ([08-security.md](08-security.md)) rather than A1/A2.
6. ⬜ **Drop `findings`** — blocked on step 4.

### Also: add foreign keys ✅

`findings.scanId` now `references(() => scansTable.id, { onDelete: "cascade" })` and
`scans.projectId` now `references(() => projectsTable.id, { onDelete: "cascade" })` — see
`lib/db/src/schema/findings.ts` / `scans.ts`. `scripts/src/cleanup-orphans.ts` must run first
against any database old enough to have orphaned rows, or the `ADD CONSTRAINT` in the generated
migration fails outright.

`assets`/`observations` deliberately have **no** foreign key to a project: an asset is
organization-scoped and cross-surface, and a `tls`/`kms`/`certificate` asset has no project at
all. So `DELETE /api/projects/:id` cannot rely on a cascade for them — it reconciles them
explicitly by the `project:<id>:` location prefix (`observations` then cascade off `assets`),
which is what keeps the submitted `codeSnippet` in `observations.evidence` from outliving the
project delete. The `project:<id>` convention itself has one owner, `projectRepoId()` in
`lib/db/src/schema/assets.ts`, used by the scan routes, the backfill script, and that handler.

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

### Target — as built (`lib/collectors/`)

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
  keySize?: number;           // parameter size (2048, 384, ...), not a security-strength category. Undefined when undeterminable — never a guessed default.
  location: string;
  locationDetail?: LocationDetail;  // validated discriminated union — see "CPE 2.3 and the network locationDetail profile" below
  discoveryModality: DiscoveryModality;  // added — see "Discovery modality" below
  confidence: number;         // regex ≈ 0.7, TLS handshake ≈ 1.0
  evidence: Record<string, unknown>;
}
```

Two fields were added beyond the original sketch above, both from the qx-sp1800-38b
investigation report (`data/qx-sp1800-38b/report.md` in the firstmate workspace this change was
authored under — not part of this repo): `keySize` closes [G-05](09-open-gaps.md), and
`discoveryModality` closes the modality half of [G-15](09-open-gaps.md). `locationDetail`'s type
changed from `Record<string, unknown>` to a validated discriminated union for the same reason.

The existing regex scanner becomes `SourceRegexCollector` (`lib/collectors/src/source-regex-collector.ts`)
— one implementation, unchanged in detection behaviour (same 7 patterns, same "one finding per
line, first pattern wins" order), with `nistReplacement` / `nistStandard` / `explanation` /
`severity` **removed** from its pattern table because those now come from
`docs/Claude/mappings/algorithms.json` via `lib/collectors/src/algorithm-mapping.ts` — a small,
deliberately non-dynamic lookup (canonical name → severity/replacement/standard/
explanation/effort), not the C1 mapping engine (deadline resolution, crosswalks — still out of
scope). Note where that lookup runs: the shim resolves it when it builds each `ScanFinding`, and
`routes/scans.ts` still writes the resolved strings into `findings` rows, so a mappings edit
changes *future* scans, not existing rows. `observations` deliberately stores none of it, so the
lookup only becomes a true read-time derivation once reads cut over (step 4 of the migration
path above). `artifacts/api-server/src/lib/scanner.ts`'s `scanCode()` is now a thin back-compat shim
over the collector, kept because four existing routes call it synchronously; see the file for
why its copy text can now legitimately differ from the pre-refactor hardcoded strings.

**Acceptance for this seam:** adding the dependency collector requires zero edits to
`scanner.ts` and zero edits to the API routes. **Not yet demonstrated** — B2 is out of scope for
this change, so this acceptance criterion is architecturally true (nothing in `Collector`/
`RawObservation` assumes a source-only collector) but unverified by an actual second collector.

### NIST reached the same conclusion — align with it

**NIST SP 1800-38B** (*preliminary draft*, December 2023 — SP 1800-38A/B/C are all preliminary
drafts, not final NIST publications; treat every citation below as alignment to the cited draft,
to be re-checked when NIST publishes a replacement) is the NCCoE practice guide for
*cryptographic discovery tools*, i.e. our exact product category.
[https://www.nccoe.nist.gov/sites/default/files/2023-12/pqc-migration-nist-sp-1800-38b-preliminary-draft.pdf]
Its §4.1.4 identifies the same normalisation problem this seam solves:

> *"The reports produced by the discovery platforms in this demonstration are unique in that they
> do not use a common format for representing the discovery results. In a contrived example, a
> network discovery platform may identify a host system as `host.example.com:443`, whereas
> another may omit the port number (`host.example.com`). Therefore, we identified the need for a
> common format to represent normalized discovery reports."*
> — SP 1800-38B §4.1.4, p. 25. [verified]

That is `RawObservation`. The design is right — and §4.1.4.1 Table 6 specifies seven network
data elements as a genuinely separate concept from `assets.location`: `assets.location` is the
stable locator that feeds the fingerprint; these seven are contextual observations that can
change between observations of the same asset (a host seen first passively, then actively
probed) and so belong on `locationDetail`, not as new top-level asset columns.

| NIST Table 6 element | Representation | `locationDetail.network` field (as built) |
|---|---|---|
| IP (v4/v6) address | String | `ipAddresses?: string[]` — plural; a certificate or host observation can have several |
| Destination port | Number | `destinationPort?: number` (0–65535) |
| Hostname | String | `hostname?: string` |
| Application layer protocol | IANA Service Name or TLS ALPN ID (RFC 6335 §5.1 / RFC 7301) | `applicationLayerProtocol?: { kind: "iana-service-name" \| "tls-alpn" \| "other"; value: string }` |
| Application software | **CPE 2.3** (NIST IR 7695) | `applicationSoftwareCpe?: Cpe23FormattedString` (`part = "a"`) |
| Operating system | **CPE 2.3** | `operatingSystemCpe?: Cpe23FormattedString` (`part = "o"`) |
| Device vendor | **CPE 2.3**, with a qualification — see below | `deviceVendorCpe?: Cpe23FormattedString` (`part = "h"`) or `deviceVendorOui?: string` |

[Source: SP 1800-38B §§4.1.4–4.1.4.1, pp. 25–27. `verified`]

**"Device Vendor" qualification:** Table 6 labels this element "Device Vendor", but its
accompanying text and worked CBOM example identify a *hardware device* with CPE `part=h` —
and CPE identifies product classes, not a bare vendor/OUI. Its own example instead gives an
OUI-like value (`D0-43-1E`) in the device-vendor property. So `deviceVendorCpe` is populated only
when a hardware product class is actually identified; otherwise the non-CPE `deviceVendorOui`
carries the vendor identifier. **Never manufacture a CPE from an OUI.** [Source: SP 1800-38B
§4.1.4.1, pp. 27–28. `verified`]

`locationDetail` is validated at the application boundary (`lib/collectors/src/location-detail.ts`,
a `zod` discriminated union keyed on `kind: "source" | "network" | "dependency" | "binary"`), not
freeform `jsonb` at the type level — the column itself is still `jsonb`, but nothing outside that
one module constructs or reads it as arbitrary JSON. §4.1.4 explicitly *"does not define a
schema, but instead defines descriptive data elements"* — so this is alignment guidance, not a
serialisation target. CycloneDX CBOM remains the wire format. **Not yet built:** no collector
populates the `network` profile — B3/B4 (TLS prober, certificate collector) are the ones that
would, and neither is in scope here. This is why [G-15](09-open-gaps.md) is partially, not fully,
closed.

#### CPE 2.3: no dependency, a small internal implementation

No well-maintained CPE 2.3 parser/formatter/matcher exists for Node/TypeScript (checked; the
closest npm candidate was last published 2022-04-07) — not a reasonable dependency to add to a
security product's trust path. `lib/collectors/src/cpe.ts` implements only the formatted-string
binding against **NIST IR 7695**, "Common Platform Enumeration: Naming Specification Version
2.3": eleven colon-delimited attributes after `cpe:2.3:` (`part`, `vendor`, `product`, `version`,
`update`, `edition`, `language`, `sw_edition`, `target_sw`, `target_hw`, `other`), `part ∈ {a, o,
h}`, and — the specific bug a naive implementation gets wrong — a backslash-escaped colon inside
an attribute value is not a delimiter, so `split(":")` fragments it incorrectly. Full CPE name
matching and dictionary resolution (turning a CPE into a match against a vulnerability database)
are a deliberate non-goal here; see [G-15](09-open-gaps.md).
[Source: NIST IR 7695 §§5.3.3, 6.2–6.2.3, pp. 11–13, 31–36.
https://nvlpubs.nist.gov/nistpubs/Legacy/IR/nistir7695.pdf — `verified`]

### Confidence should encode modality, not just a number

SP 1800-38B §4.1.4 names four ways discovery data is obtained — **passive network observations,
active network scans, endpoint monitoring, and configuration information** — without normatively
defining them. These have genuinely different evidential weight, and an auditor will ask which
one produced a given finding. The operational meaning below is this project's reading of the
document's architectural descriptions (§§4.1.2–4.1.4.1), not an invented quotation:

| Modality | Operational meaning | Example collector, this project |
|---|---|---|
| `passive_network_observation` | Analysis of observed/mirrored traffic — real-time capture or historical PCAP, no connection initiated | A future PCAP-ingestion feature (not B3 as currently planned) |
| `active_network_scan` | A probe/scan that interacts with the target | B3 (TLS/cipher-suite handshake) |
| `endpoint_monitoring` | Endpoint-deployed sensor/EDR data, continuous | B10 (binary/firmware), if agent-deployed |
| `configuration_information` | Declared/queried configuration or inventory metadata | B5 (KMS), B6 (protocol config), B7 (data-at-rest, local) |
| `static_artifact_analysis` *(extension)* | Offline analysis of a static artifact — source, dependency manifest, or uploaded binary | B1 (`SourceRegexCollector`, this change), B2, B10 (offline) |
| `manual_attestation` *(extension)* | A human-entered assertion, not discovered configuration | B8 (manual OT register), B9 (vendor questionnaire) |

[Source: SP 1800-38B §§4.1.2–4.1.4.1, pp. 23–27. The four NIST-named modalities are `verified`
to this document; the two extensions and the collector-to-modality mapping are this project's own
addition, not attributed to NIST.]

**As built — six values, not four.** Four of this project's planned collectors (source regex,
dependency/SBOM, manual OT register, vendor questionnaire) do not fit any of NIST's four labels;
calling a source-code match "configuration information" would hide a real evidence distinction.
`lib/collectors/src/enums.ts` defines `DiscoveryModality` as all six —
`passive_network_observation`, `active_network_scan`, `endpoint_monitoring`,
`configuration_information`, `static_artifact_analysis`, `manual_attestation` — as a **confirmed,
permanent enum** (captain decision, 2026-08-02). An earlier draft of this work treated the two
extensions as provisional pending a possible narrowing back to NIST's four; that reservation has
been resolved. The enum is defined in exactly one place — narrowing or widening it later is a
one-file change, not a hunt through string literals — and the database `CHECK` constraint and the
TypeScript type are both derived from that same const tuple (a `CHECK`, not a Postgres `ENUM`
type, specifically so that a future change stays a one-line diff rather than a type-recreation
migration).

Carried on the observation alongside the numeric confidence, rather than collapsing both into one
float — `SourceRegexCollector` emits `static_artifact_analysis` at confidence `0.7` for every
observation.

### Binary surface — contract only, no collector

§4.1.2 puts **binary scanning inside the core operational-systems domain**, specifically to
catch *"algorithms that there might not be a source code for, as, for example, in third-party"*
components. [Source: SP 1800-38B §4.1.2, p. 23. `verified`] We have binaries as B10, `deferred`,
`P3` in [03-features.md](03-features.md) — re-scoping that priority is a roadmap decision the
captain has not made, tracked as [G-16](09-open-gaps.md), and this change does not make it.

**What this change does:** add `binary` to `Surface`, and define (but not implement) the
binary-evidence profile so a future B10 collector needs a scoped addition, not a contract
redesign:

```ts
type BinaryLocationDetail = {
  artifactPath: string;
  binaryFormat: "elf" | "pe" | "macho" | "jar" | "unknown";
  architecture?: string;
  packageIdentity?: string;      // package-manager identity, if known — not a CPE
  componentName?: string;        // stable logical artifact name
  evidenceDiscriminator: string; // import/symbol/signature rule ID used in the fingerprint
};
```

`lib/collectors/src/location-detail.ts` and `fingerprint.ts` implement this profile and its
fingerprint rule (above); no collector uses it yet. [Source: qx-sp1800-38b investigation report,
§"Binary observation profile and interface consequence", itself built on SP 1800-38B §§3.2.2.2,
4.1.2 and Appendix C.3–C.6.]

### Confidence is not decoration

A regex match on `\bDH\b` in a comment and a completed TLS handshake advertising
`ECDHE-RSA-AES128-GCM-SHA256` are not the same quality of evidence. The current 7 patterns are
broad — `/\bRSA/i` matches prose, variable names, and the string "RSAT". Carrying confidence
through to the UI and filtering reports by it is how the inventory stays credible when someone
audits it.

**As built:** `observations.confidence` is persisted and round-trips correctly (see
`lib/db/src/schema/asset-model.test.ts`). **Not built:** no UI or report filters by it yet — that
is D3/reporting work, not A1/A2. This closes the data-model half of [G-11](09-open-gaps.md), not
the presentation half.

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

**As built (2026-08-14, A4).** `@workspace/risk` implements the sketch above with three
deliberate differences, all recorded in the code:

- `assessMoscaRisk()` takes `now` as an injected parameter. Z is *years remaining*, so a
  function that reads the clock itself has no reproducible tests and quietly changes meaning
  every January.
- `MoscaInput` carries `hasQuantumVulnerableCrypto`. Without it, an asset holding a 50-year
  secret and nothing but MD5 reports a Mosca breach — [G-10](09-open-gaps.md#g-10--hygiene-findings-inflate-the-pqc-risk-score)'s
  error relocated from the score into the verdict.
- `RiskInput` takes findings plus a line count rather than an `Asset`. Reads have not cut over
  to the asset model (see "Migration path"), so the engine deliberately does not depend on it;
  its input type is the structural minimum (`{ algorithm, effortHours }`), which an `Asset`
  will also satisfy.

`score` is decomposed into `detection` (0-60, density of quantum-vulnerable findings) and
`moscaBreach` (0-40, proportion of scenarios breached) and both are returned, because a score a
CISO cannot take apart in front of a board is the thing A4 exists to replace.

---

## Package layout

```
lib/
  db/            ✅ extended with assets/observations/collection_runs
  collectors/    ✅ NEW — Collector interface + SourceRegexCollector (built).
                    algorithm-mapping.ts is a small read-time lookup over
                    docs/Claude/mappings/algorithms.json — NOT the C1
                    loader/validator package below, which remains unbuilt.
  mappings/      NEW, unbuilt — loader + validator for docs/Claude/mappings/*.json (C1/C2)
  risk/          ✅ NEW — Mosca engine + the PQC/classical-hygiene track split (A4,
                    closes G-10). Depends on @workspace/collectors for the
                    algorithms.json lookup, never the reverse. Agility scoring
                    (D5) is still unbuilt; Y uses a neutral agility of 1.
  cbom/          NEW, unbuilt — CycloneDX 1.7 import/export (A5)
  api-spec/      existing — extend OpenAPI, regenerate (not done here)
artifacts/
  api-server/    routes/scans.ts dual-writes via lib/asset-ingest.ts; other routes unchanged
  quantaxscan/        existing
```

`@workspace/collectors` deliberately has **no dependency on `@workspace/db`** — `lib/db` depends
on it (for the shared enum tuples feeding `CHECK` constraints), not the other way around. Keeping
collectors dependency-free of the database package means they can also run as a standalone
on-prem agent — which matters a great deal if the SaaS-source-code risk in
[01-strategy.md](01-strategy.md#what-would-falsify-this-thesis) materialises.

---

## API surface changes

**None of this table is built yet.** `POST /api/scans` and `POST /api/scans/multi` now
dual-write (see "Migration path" above) but their request/response shape is unchanged; every row
below remains a planned change, not a status update.

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
