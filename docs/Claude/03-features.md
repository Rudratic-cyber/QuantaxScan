# 03 — Feature catalog

Status: `built` · `next` · `planned` · `deferred` · `won't`

Priority: **P0** blocks a milestone · **P1** milestone scope · **P2** valuable, cuttable ·
**P3** later

> **Edition tiering lives in [10-editions.md](10-editions.md), not here.** That document assigns
> every feature below to Community (Apache 2.0) or Enterprise (commercial). This file is the
> authority on what a feature *is* and its build status; 10 is the authority on which edition
> ships it. Keep them in sync when adding a feature — add the row here first, then tier it there.

---

## A. Inventory core

### A1. Asset/observation data model `built`* **P0**

Replace per-scan findings with persistent assets and time-stamped observations.

- An asset is a *thing that has crypto* — a file, a dependency, an endpoint, a certificate, a key
- An observation is *a collector saw this at a point in time*, with confidence and provenance
- Assets carry `firstSeen`, `lastSeen`, `status` (`active` / `remediated` / `waived` / `gone`)
- Stable identity across re-scans via a deterministic fingerprint

**Acceptance:** re-scanning an unchanged repo produces zero new assets and updates `lastSeen` on
existing ones. Removing the vulnerable line marks the asset `gone`, and it stays in history. Both
halves verified (`artifacts/api-server/src/lib/asset-ingest.test.ts`). The `gone` reconciliation
is scoped **per scanned file** (by `location`), not per repo/project: a call that only submits a
subset of a project's files (e.g. `POST /scans` submitting one file) has no information about
files it wasn't given, so those files' assets are left untouched rather than wrongly marked gone.
Reappearance is symmetric — a `gone` asset that is observed again reactivates the same row
(`status` back to `active`) rather than creating a duplicate. Reactivation is *only* `gone` →
`active`: `waived` and `remediated` are human decisions about an asset, not observations of it,
so re-seeing the same line records the observation and advances `lastSeen` without undoing them.

**Depends on:** nothing. **Blocks:** literally everything else.

\* Schema, fingerprint, backfill script, and dual-write from `POST /scans`/`POST /scans/multi`
are built (`lib/db/src/schema/{assets,observations,collection_runs}.ts`,
`lib/collectors/src/fingerprint.ts`, `scripts/src/backfill-assets.ts`,
`artifacts/api-server/src/lib/asset-ingest.ts`). **Not built:** reads are not cut over — every
existing route still reads `findings`, `findings` is not dropped, and `scans.code` (full
submitted source) is still stored. See [04-architecture.md](04-architecture.md#migration-path)
for why that is a deliberate, separately-scoped follow-up rather than a partial migration.

---

### A2. Collector interface `built`* **P0**

Generalise `scanner.ts`'s `VULNERABILITY_PATTERNS` array into a pluggable collector contract.
Regex-over-source becomes one implementation.

**Acceptance:** a new collector can be added without modifying `scanner.ts` or the API routes.
**Verified** by B2's `DependencyCollector` (the second implementation), which adds a whole new
surface with zero edits to `scanner.ts` and zero edits to any route. Nothing in
`Collector`/`RawObservation` assumes a source-only collector, and no new `CollectionTarget`
variant was needed: a lockfile arrives as an ordinary submitted file and the collector selects
what it understands by basename.

\* `@workspace/collectors` (new package): `Collector`/`RawObservation` contract, `SourceRegexCollector`,
CPE 2.3 parser, discriminated `locationDetail`, deterministic fingerprint, and a small lookup
over `docs/Claude/mappings/algorithms.json` for severity/replacement/standard/explanation — not
the C1 dynamic mapping engine (see [05](05-compliance-mapping.md)), and resolved as each finding
is built, so those strings are still frozen into the `findings` row until reads cut over (see
[04-architecture.md](04-architecture.md)). Key size extraction (G-05) works for same-line
literals and named curves in source, and for dependency packages that pin exactly one curve;
B2 is now built as a collector (see below), B3–B10 remain unbuilt.

---

### A3. Data classification `built`* **P0**

`secrecyLifetimeYears` plus a classification label per asset/project. Sensible presets:

| Preset | X (years) | Examples |
|---|---|---|
| Public | 0 | Marketing sites, published docs |
| Internal | 3 | Internal tooling, non-sensitive ops |
| Confidential | 7 | Commercial contracts, financials |
| Regulated | 25 | Health records, insurance, government |
| Indefinite | 50 | State secrets, genomic data, identity roots |

**Acceptance:** every asset has an X value, defaulting to a project-level setting, overridable
per asset, with the default clearly marked as an assumption in reports. The first two clauses are
met by `resolveSecrecyLifetime()`, which always returns a number. The third is met **in the data
rather than in report copy**: the resolved record carries `source` (`asset` | `project` |
`default`) and `assumed`, so a report states the provenance instead of a caption asserting it.

\* **Built:** the classification vocabulary and its preset X values, the `data_classification` +
`secrecy_lifetime_years` pair on both `projects` (the default) and `assets` (the override) with
`CHECK` constraints, and the pure resolver — all in `lib/db/src/classification.ts`, exported as
`@workspace/db/classification` (a subpath with no drizzle/`pg`/`DATABASE_URL` dependency, so A4
can import the contract on its own). `SecrecyLifetime` is A4's `X` input.

All four columns are **nullable with no database default**, and that is what makes the third
acceptance clause satisfiable: `NOT NULL DEFAULT 3` would destroy the difference between "a human
chose Internal" and "nobody said anything" on the way into the database. Same reasoning as
`assets.key_size` (G-05). Provenance is therefore *derived* by the resolver rather than stored — a
persisted `classification_source` column would go stale the moment a project's default changed.

**Not built:** no write path. There is no API route or UI control for setting either level yet,
and `CreateProjectBody` is unchanged — A1's reads were never cut over to `assets`, so there is no
asset API surface to hang an override on (see the route manifest in `cross-tenant.test.ts`).
Nothing calls `resolveSecrecyLifetime()` in production code yet; A4 is its first consumer. Values
can only be set by direct SQL today.

---

### A4. Mosca risk engine `built`* **P0**

Split risk from detection. Input `(asset, X, Y, Z-scenario)` → verdict + score.

X comes from A3: `resolveSecrecyLifetime()` in `@workspace/db/classification` returns a
`SecrecyLifetime` — `{ years, source, assumed, classification, classificationSource, basis }`.
Take `years` as X and carry `assumed`/`basis` into the verdict, so "why" can distinguish a
customer-supplied lifetime from a defaulted one.

**Acceptance:** returns a verdict per Q-Day scenario, and the UI shows *why* — the three input
values, not just a number. **Engine half met, UI half not** — see the asterisk.

\* `@workspace/risk` (`lib/risk/`, new package): `assessMoscaRisk()` returns one `MoscaVerdict`
per Q-Day scenario (conservative 2030 / central 2035 / aggressive 2040, from
[01-strategy.md](01-strategy.md)), each carrying `x`, `y`, `z`, `breached`, `breachMarginYears`
and a narrative sentence naming all three inputs — the module exports no way to obtain a score
without them. `computeRiskProfile()` is the scan-level entry point: it returns a **post-quantum
exposure score** and a **separate classical-hygiene panel**, which is what closes
[G-10](09-open-gaps.md#g-10--hygiene-findings-inflate-the-pqc-risk-score). The track split is
derived from `algorithms.json`'s own `quantumVulnerable` flag and each entry's `reportingNote`,
never from a list of algorithm names in code. `computeScanResult()` now reports the PQC score as
`riskScore` and returns `pqc`/`hygiene`/`mosca` alongside it; the scan, multi-scan, demo and
GitHub routes pass those through. Nothing about A4 is persisted — the profile is recomputed at
read time, so a mappings or scenario change moves the verdict without a backfill.

**Not built, deliberately:**

- **The UI.** `pqc`, `hygiene` and `mosca` are the panel's data contract; no page renders them
  yet, and `lib/api-spec/openapi.yaml` and the generated Orval client are not updated, so the
  typed frontend client cannot see the new fields. That is D2 (Mosca exposure view) and the
  hygiene panel's presentation, not A4's engine.
- **X per asset.** A3 supplies it. Until then every verdict uses
  `DEFAULT_SECRECY_LIFETIME_YEARS` (3 — A3's "Internal" preset) and reports
  `mosca.secrecyLifetimeSource: "assumed-default"` so a report can mark it as an assumption.
- **Agility in Y.** Y is `effortHours ÷ agilityScore ÷ hours-per-calendar-year` with
  `agilityScore` fixed at 1 pending D5, and the hours-per-year constant is a stated guess with
  no source in these documents. It is the least defensible number in the engine.
- **Portfolio rollup and scenario management** — the Enterprise half per
  [10-editions.md](10-editions.md). Scenarios are a parameter everywhere, which is the hook.

**Know this before reading a score.** `riskScore` is `detection` (0-60) + `moscaBreach` (0-40).
At the assumed default X of 3 years the conservative scenario (2030) is still further away than
that, so nothing breaches and **the score cannot exceed 60 until A3 supplies a real secrecy
lifetime** — or until 2027, when the conservative Q-Day comes inside three years. That is
intended: the top 40% of the scale is reserved for an actual Mosca breach and must be earned,
not asserted by detection volume. It does mean the headline number's range is narrower than it
was before A4, which is the honest reading of a scan with no data classification behind it.

---

### A5. CBOM export (CycloneDX 1.7) `built` **P0**

Target **1.7** — released 2025-10-21, standardised as ECMA-424. `verified 2026-08-01`,
**re-verified 2026-08-13** against the specification repository's release list while vendoring the
schema. CBOM represents algorithms, keys and certificates and their relationships to software
components.

**Acceptance:** output validates against the official CycloneDX 1.7 JSON schema. ✅ — the schema is
vendored verbatim under `lib/cbom/schema/` (provenance in its README) and asserted with ajv in
`lib/cbom/src/build-cbom.test.ts`, including negative controls proving the validator rejects.

**Landed 2026-08-13:**

- `lib/cbom` — pure builder, no `@workspace/db` dependency, deterministic output (serial number
  and timestamp are injected, components sorted by `bom-ref`) so two exports of an unchanged
  inventory diff clean.
- `GET /api/inventory/cbom` — the M1 exit criterion. Authenticated and organisation-scoped via
  `withOrg`; deliberately **not** on the public allowlist, because a CBOM is a complete map of an
  organisation's cryptographic weaknesses.
- Surface → `cryptoProperties.assetType`: `source`/`dependency`/`binary`/`ot` → `algorithm`,
  `tls`/`config` → `protocol`, `certificate` → `certificate`, `kms` →
  `related-crypto-material`. Only `source` has a collector today; the rest are mapped now so the
  asset model is tested against the standard before five more collectors are written against it.
- Relationships: a project is exported as an `application` component, and `dependencies[].dependsOn`
  links it to the crypto found inside it. An asset whose container is not in the export gets no
  edge rather than a dangling `bom-ref` (JSON Schema cannot catch a dangling ref — a test does).

**`keySize: null` (G-05):** no numeric field is emitted — no `parameterSetIdentifier`, no
`relatedCryptoMaterialProperties.size` — and the component is named `RSA`, not `RSA-2048`.
The absence is *stated*, via a `quantaxscan:asset:keySize` property valued `undetermined`, so a
consumer can tell "we looked and do not know" from "this exporter never considered key size".
`classicalSecurityLevel`/`nistQuantumSecurityLevel` are never populated: deriving a security
strength is A4's job, and doing it here would be the forbidden default wearing a different name.

**Not done:** A6 import, and therefore the round-trip half of
[07-reports.md](07-reports.md)'s E3 acceptance. No `?surface=`/`?status=` filters — the export is
the whole current inventory, excluding `status = 'gone'` (crypto a later run confirmed had been
removed must not appear in a current-state inventory).

---

### A6. CBOM import `planned` **P2**

Ingest CBOMs/SBOMs the customer already has. Cheap coverage, and it makes us a hub rather than
another silo.

---

## B. Collectors (coverage track)

| # | Collector | Status | Pri | Notes |
|---|---|---|---|---|
| B1 | Source code (regex) | `built` | — | Now `SourceRegexCollector` behind A2 (`lib/collectors/`). **Key size (G-05): partially closed** — extracts a same-line literal modulus or named-curve size, undetermined (not defaulted) otherwise; no cross-line/AST resolution. **Confidence (G-11): closed** for this collector — `0.7`, persisted. **EdDSA (G-06): closed** — eighth pattern added, Ed25519/Ed448 resolve their curve bit sizes; one finding per line still means a line naming both `ssh-rsa` and `ssh-ed25519` reports only RSA |
| B2 | Dependency / SBOM | `built` | **P0** | Biggest coverage jump, and now wired end to end. `DependencyCollector` (`lib/collectors/src/dependency-collector.ts`) parses pnpm/npm/yarn lockfiles and `requirements.txt` → the cited package table in [`mappings/crypto-packages.json`](mappings/crypto-packages.json) → observations at `0.8` (single-purpose library) or `0.5` (general-purpose library) confidence, persisted as `surface: "dependency"` assets by `POST /api/projects/:id/dependencies`. **`dependency` is the second `live` surface**, so the D3 meter reads 2 of 10 for a project with a scanned lockfile |
| B3 | TLS / cipher suite prober | `built` | **P1** | Active handshake against hosts, recording the *negotiated* key exchange rather than the configured one — `tls-collector.ts` maps the handshake, `tls-probe.ts` opens the socket, and `tls-ssrf-guard.ts` resolves-then-pins so a caller-named host cannot be turned into an SSRF. `POST /projects/:id/tls`. Confidence 1.0, the only collector that earns it. TLS 1.3 records its key-exchange size as undetermined rather than guessing — Node reports no group there |
| B4 | Certificate / X.509 | `built` | **P1** | Key type, size, expiry, parsed with `node:crypto`'s `X509Certificate` — no third-party dependency, so `lib/collectors` stays shippable as a standalone agent. Every certificate in a submitted chain is read, not just the leaf. `POST` / `GET /projects/:id/certificates`, with the Q-Day verdict derived per scenario on read |
| B5 | KMS / secret stores | `built` | **P2** | Vault, AWS KMS, Azure Key Vault, GCP KMS — **submission-based, not credentialed**. `POST /api/projects/:id/kms` takes the key inventory your own `describe-key`/`keys list` produced; `GET` returns the persisted inventory with rotation posture. Spec → algorithm resolution is cited data in [`mappings/kms-key-specs.json`](mappings/kms-key-specs.json) (84 specs, four primary sources). **`kms` is the fifth `live` surface** |
| B6 | Protocol config | `built` | **P2** | `ProtocolConfigCollector` (`lib/collectors/src/protocol-config.ts` + `protocol-config-collector.ts`) parses `sshd_config`/`ssh_config`/`authorized_keys`, `ipsec.conf`/`swanctl.conf`, a JWKS, an OIDC discovery document and SAML metadata, and `POST /api/projects/:id/protocol-config` persists them as `surface: "config"` assets — **`config` is the sixth `live` surface**. Reads what a file *declares*, never what a peer negotiates (that is B3), at `configuration_information` modality and two confidence tiers: `0.6` for a permitted-algorithm list, `0.8` for a materialised key (an `authorized_keys` entry, a published JWK, the method a SAML document was signed with). Whole-token matching only, so hybrid PQC key exchange (`sntrup761x25519-sha512`) is silently absent rather than misreported as vulnerable `ECDH/DH`. `Include` is not followed and an absent directive is not read as the compiled-in default |
| B7 | Data-at-rest | `built` | **P2** | DB TDE, backup/archive encryption — the true HNDL targets. Submission-based (`POST/GET /api/projects/:id/data-at-rest`), no database credentials. **Two assets per store**: the bulk cipher and the key-wrapping algorithm, because only the second is what Shor breaks. **The only ingest that accepts a data classification**, so a Regulated archive reaches the risk engine with X = 25 rather than an assumed 3. A store reported as encrypted with no cipher named records nothing and is returned as a gap. **`data-at-rest` is the seventh `live` surface** |
| B8 | Manual OT/embedded register | `built` | **P1** | A *form*, not a scanner. Longest lead time, so it enters the plan first. Since 2026-08-14 it also **records cryptography on the `ot` surface**: an optional structured `cryptoAlgorithm`/`cryptoKeySize` becomes an asset at `manual_attestation` modality and confidence 0.3, while `cryptoInUse` stays free text and is never parsed. A fleet described only in prose produces no asset — the register is still the estate's enumeration, so clearing the claim or deleting the fleet retires the asset |
| B9 | Vendor / third-party | `built` | **P3** | A *form*, not a scanner — the only route to crypto the customer does not operate. Org-scoped `vendor_assessments` table, CRUD at `/api/vendor-assessments`, register page at `/vendor-register`. Every answer is stamped `manual_attestation` at confidence 0.3 (below every collector's) and `null` when the vendor has answered nothing. The `vendor` surface stays `planned`: nothing here was examined |
| B10 | Binaries / firmware | `deferred` | **P3** | Hard. Defer until coverage elsewhere is complete |
| B12 | Endpoint & host fleet | `built` | **P1** | The `endpoint` surface: machine certificate stores, host TLS policy and loaded providers for a Windows/Linux fleet, via `POST/GET /api/projects/:id/endpoint`. **No agent ships** — what exists is the report format an agent (or existing config-management tooling) reports against, and that is a decision: a binary running on a customer's domain controller is a packaging and security-review problem several times a collector's size, and it cannot authenticate until F4. `live` claims less here than elsewhere and the caveat says so on every response: **an enabled cipher suite is a permitted algorithm, not a negotiated one** — a suite list is an upper bound, and what was actually agreed is B3's surface. A suite the host's own policy disables produces nothing, and every suppression is returned so it can be audited; an unrecognised token (including every post-quantum suite) produces nothing rather than a guess. Identity is `machineId`, never `hostname` — hostnames get reused — and a placeholder or duplicated id is refused **by name** rather than merged. **`endpoint` is the tenth `live` surface** |
| B11 | Network conversations | `built` | **P1** | The `network-flow` surface: what talks to what, and the cryptography (if any) the customer's own records say protected it. **No packet capture and no tap** — real-time interception is an explicit twelve-month non-goal, so this ingests the flow and session records an estate already produces (VPC flow logs, load-balancer access logs, service-mesh telemetry, firewall session logs) via `POST/GET /api/projects/:id/network-flows`. A record naming no cipher is recorded with `cryptoState: undetermined` and produces **no asset** — never "unencrypted", which would be a finding nobody observed — and `flowsWithUndeterminedCryptography` counts those rows so the coverage meter cannot render the surface as examined-and-clean. The source's ephemeral port is accepted and discarded: keying a conversation on it would mint a row per TCP handshake. **`network-flow` is the ninth `live` surface** |

**B2, as shipped 2026-08-14.** Ecosystems covered: npm (pnpm-lock.yaml, package-lock.json,
yarn.lock — both yarn dialects) and PyPI (`requirements.txt` only; `poetry.lock`/`Pipfile.lock`
are not read). Submission is `POST /api/projects/:id/dependencies`, org-scoped like every other
persisting route; files are selected by basename, so a caller may submit a whole tree.
`POST /api/github/scan-files` was considered and rejected as the host: no lockfile reaches it
(`SCANNABLE_EXTENSIONS` lists source extensions only, so `/github/fetch` filters them out before
a client sees them) and it persists nothing at all — no project, no organisation scope, no row.

Three things it deliberately does **not** do:

- **No version-range reasoning.** The pinned version is recorded; "vulnerable before x.y.z" is
  advisory data with its own provenance requirements. A consequence surfaced by the audit below:
  a *capability* can also be version-dependent (paramiko removed `ssh-dss` in 4.0.0), which is
  tracked as G-21 rather than papered over.
- **No direct/transitive distinction.** A lockfile records the resolved graph, so a match may be
  a toolchain dependency rather than something the project's own code calls. Every response and
  every observation carries that caveat explicitly — G-20.
- **No collection run when nothing readable was submitted.** "We examined the dependencies and
  found nothing" and "you sent us nothing we can read" are different statements, and the meter
  must not collapse them.

**The package → algorithm table is now cited data**, at
[`mappings/crypto-packages.json`](mappings/crypto-packages.json) rather than in TypeScript: every
claim carries a `verified`/`needs-check` status and, when verified, a verbatim quote from the
package's own documentation with a retrieval date that `pnpm run check:standards` will age out
after 180 days. The audit that moved it corrected three customer-facing claims — see
[09-open-gaps.md](09-open-gaps.md) §"B2 provenance audit".

### On B2 — say this out loud

The current scanner cannot see crypto inside dependencies, and that is where most enterprise
crypto lives. B2 is not an incremental improvement; it is the difference between a demo and a
product. Prioritise accordingly.

**B5, as shipped 2026-08-14.** Four providers, 84 curated key specs, and one design decision
worth defending: **the first ingest path is submission-based rather than live-credentialed.** The
caller posts the key inventory their own `aws kms describe-key` / `az keyvault key show` /
`gcloud kms keys list` / `vault read transit/keys/<name>` already produced, exactly as B4 accepts
a submitted PEM. Live polling would have meant four cloud SDKs inside `lib/collectors` — which is
deliberately dependency-free so it can ship as a standalone on-prem agent — four auth flows, and
long-lived read-only credentials into a customer's key store held by a product whose
source-code/secret-handling controls (F4) are not built. None of that is needed to make the
surface real, and a credentialed poller is strictly additive: it produces the same
`KmsKeyDescription` values this collector already maps. What the submission model costs is stated
in every response: the export is taken at its word, so nothing proves it complete, current, or
from the key store named. That is why the observation confidence is 0.85 — above B2's 0.8
(a key store states what a key *is*, not what a library *could do*) and below B4's 0.9 (a parsed
certificate is the artifact itself; this is metadata about a key, relayed).

Three honesty properties it was built around, each with a test that fails if it regresses:

- **A key with no stated size records null.** An Azure Key Vault `JsonWebKey` has no `key_size`
  member at all — the RSA modulus length is only implicit in the base64url `n`, and the list
  operation returns no key type either. So "RSA, size unknown" is the *normal* Azure case, not a
  contrived one, and it survives the round trip to `assets.key_size` as NULL (G-05). Size
  precedence is documented-spec → named curve → caller-supplied → null; a caller cannot override
  a size AWS's own guide states.
- **An uncatalogued primitive gets no algorithm, not the nearest one.** HMAC, ChaCha20-Poly1305,
  SM2, every ML-KEM/ML-DSA/SLH-DSA parameter set and Azure's `kty: oct` resolve to
  `outcome: no-algorithm` with the curated table's own reason. Inferring AES from `kty: oct`
  because AES is the common case is the manufactured finding `crypto-packages.json` already
  refuses for JWT libraries. The three non-observed outcomes stay distinct
  (`no-algorithm` / `unrecognised-spec` / `no-spec`) because only the middle one is fixed by a
  data update.
- **A key store holding only symmetric keys was still examined.** This is the one place B5's run
  gate differs from B2/B3/B4's: those refuse a run when nothing *readable* was submitted, whereas
  here every key was read and classified and simply none of them is reportable. That is
  `examined-nothing-found`, and only an empty `keys` array records no run.

Two limits to know about. `assetsMarkedGone` is always 0: a submitted export is never assumed to
be a complete enumeration of a key store — one page of a paginated `list-keys`, one region, one
Vault mount is the normal case — so a key absent from a later submission is not inferred deleted.
And AWS's `SYMMETRIC_DEFAULT` is 128-bit SM4 rather than AES-256 in China Regions; the table
cannot tell them apart from a spec string, so the region is recorded on the observation.

**B8, as shipped 2026-08-14.** Org-scoped `ot_fleets` table, CRUD routes at `/api/ot-fleets`, and
a form + list page at `/ot-register`. **Deliberately not an `assets` row.** `assets` exists to
answer "what did a collector observe and does it still hold" — a stable `fingerprint` reconciled
against a `collection_runs` row on a `surface` a collector actually flipped to `live`. Nothing
here is ever collected; a human types it in and edits it by hand as facts change, which is the
opposite lifecycle. Routing a fleet through the asset/observation model would mean inventing an
`ot` surface that no collector ever populates — exactly the dishonesty the D3 coverage meter
exists to prevent — so B8 does not touch `assets`, `observations`, `collection_runs` or the D3
meter at all; it is orthogonal coverage, not a re-skin of the collector pipeline.

The payoff is `assessOtExposure()` (`artifacts/api-server/src/lib/ot-exposure.ts`): a fleet's
next procurement date is checked against every `DEFAULT_QDAY_SCENARIOS` year from
`@workspace/risk` (never hardcoded), and a fleet whose next procurement falls after a scenario's
Q-Day is `"exposed"` under that scenario by definition — no replacement is scheduled before the
deadline. A fleet with no recorded date reads `"unknown"` under every scenario, never `"clear"`;
collapsing the two would be the guessed-default failure CLAUDE.md's "null means not supplied"
rule exists to prevent, applied to a date instead of a key size.

**B9, as shipped 2026-08-14.** Org-scoped `vendor_assessments` table, CRUD routes at
`/api/vendor-assessments`, and a form + list page at `/vendor-register`. It exists because a
vendor's cryptography is invisible to every other collector in this product — B1 through B8 all
read something the customer owns — and the only instrument that reaches it is asking.

**A claim is not an observation, and this is the surface where that distinction is load-bearing.**
Everything in this register is a self-report by the party with the strongest incentive to
overstate. `assessVendorPosture()` (`artifacts/api-server/src/lib/vendor-posture.ts`) enforces
that on the way out: every response carries `attestation.discoveryModality:
"manual_attestation"` and a confidence of `0.3` — below the anchors documented on
`RawObservation.confidence` (regex 0.7, a completed TLS handshake 1.0) and below every live
collector — with the number stated as *chosen, not measured*. A vendor who has answered nothing
gets `confidence: null`, not a floor value: no claim exists, so there is nothing to be confident
about, and a low number would read as weak evidence where there is none. Every narrative is
written in the vendor's voice ("the vendor states"), never the product's, so a board deck built
from these sentences cannot launder a claim into a finding.

Q-Day readiness is checked against the date the vendor *claims*, using `DEFAULT_QDAY_SCENARIOS`
from `@workspace/risk` (never hardcoded), on B8's model: after a scenario's Q-Day is `exposed`,
before it is `clear` (rendered "Claimed in time"), and no date at all is `unknown` under every
scenario — never `clear`. A `pqcRoadmapStatus` of `none` does **not** synthesise a verdict: a
status is not a date, and inferring one would manufacture the vendor's commitment on their behalf.

**The second honesty rule, specific to this lane: `absent` and `null` on `contractPqcClause`
point in opposite directions and both are wrong to guess.** `absent` means somebody read the
contract and there is no PQC migration clause — a finding, and an actionable one. `null` means
nobody has read it. Rendering the second as the first invents an obligation the customer never
established; rendering the first as neutral hides one. So the stored column is deliberately
three-valued-plus-null, the derived `clause.state` promotes null to a fourth `unknown` value with
its own narrative and its own colour, and `noLeverScheduled` (no clause *and* no scheduled
renewal) is true only when the contract was actually read. `tests/e2e/12-vendor.spec.ts` asserts
both directions.

**Deliberately not an `assets` row on the `vendor` surface.** Same reasoning as B8's `ot_fleets`,
plus one specific to this lane: `assets` records what a collector observed, and a questionnaire
answer is not an observation of anything. Persisting it beside a TLS handshake — same table, same
lifecycle, same `confidence` column read by the same meters — would put an interested party's
assertion and a completed handshake on one footing. The consequence, stated rather than hidden:
`vendor` stays `planned` in `COLLECTOR_SURFACES`, so the D3 meter keeps reporting the vendor
surface as never examined even when this register is full. That is the honest reading — nothing
was examined; somebody was asked. It is the same unresolved inconsistency B8 left on `ot`, and
resolving it properly means teaching the coverage meter that "a manual register exists" is a
third state alongside `live` and `planned`, which is D3's work rather than a collector lane's.
**B7, as shipped 2026-08-14.** `POST /api/projects/:id/data-at-rest` takes a *description* of an
encrypted store — engine, store id, encryption state, cipher, key protection, key source — and
persists it as `data-at-rest` assets; `GET` returns the same stores with X resolved and Mosca
evaluated at read time. `DataAtRestCollector` is pure and does no I/O
(`lib/collectors/src/data-at-rest-collector.ts`), the same split B3 uses.

Four decisions worth stating:

- **Submission, not credentials.** Connecting to a live database needs somewhere to put a
  production credential, and F4 is unbuilt. Inventing a secret-handling design inside a collector
  lane is how a product ends up storing database passwords by accident — the same reasoning B5
  applies to KMS.
- **Two assets per store, not one.** The bulk cipher (usually AES, which NIST does not treat as
  quantum-vulnerable) and the algorithm wrapping the data key are separate facts, and only the
  second is a Shor target. A collector that recorded the cipher alone would report an AES-256
  store whose key is wrapped with RSA-2048 as carrying nothing quantum-vulnerable. The role is
  part of the fingerprint so an AES-wrapped-with-AES hierarchy cannot collapse into one asset.
- **The only ingest that accepts a data classification.** Data at rest is the case where the
  ciphertext really can be copied today and decrypted after Q-Day, so X is the whole question and
  the caller knows it at submission time. It is persisted on the asset, which is what makes
  `GET /api/inventory/assets` resolve X = 25 for a Regulated archive rather than the product's
  assumed 3. The upsert `COALESCE`s it: omitting it on a later submission leaves a human's earlier
  assertion in place rather than blanking it.
- **"Encrypted: yes, cipher unknown" records nothing.** It is returned as a `cipher-not-reported`
  gap and — the sharp edge — is excluded from the reobservation scope, so leaving the field blank
  on a resubmission cannot mark a previously recorded cipher `gone`. `not-encrypted` *is* in
  scope, because that is a positive statement of absence rather than a missing field.

---

## C. Compliance & mapping

| # | Feature | Status | Pri |
|---|---|---|---|
| C1 | Dynamic mapping engine (data-driven) | `built` | **P0** |
| C2 | Versioned `mappings/` data + provenance | `built`† | **P0** |
| C3 | NIST FIPS 203/204/205 algorithm mapping | `built`* | **P0** |
| C4 | NIST IR 8547 deprecation timeline mapping | `planned` | **P1** |
| C5 | CNSA 2.0 timeline mapping | `planned` | **P1** |
| C6 | CISA quantum-readiness roadmap alignment | `planned` | **P1** |
| C7 | NSM-10 / OMB M-23-02 inventory format | `planned` | **P2** |
| C8 | Waivers / exceptions register | `planned` | **P1** |
| C9 | Control framework crosswalk (ISO 27001, SOC 2, PCI DSS 4, DORA) | `planned` | **P3** |

\* C3 exists as a static by-name lookup over `mappings/algorithms.json`
(`lib/collectors/src/algorithm-mapping.ts`, added by A2 — it replaced the hardcoded copies in
`scanner.ts`'s pattern table). It still backs `severity`/`effortHours` on a `ScanFinding`; the
obligations, deadlines and citations come from C1.

**C1 is `@workspace/mappings` (`lib/mappings/`).** `resolve(input, { asOf, version, profile })` is
pure and returns obligations with framework, requirement, deadline, replacement, citation,
confidence and draft status, plus a report bucket and a use-condition table. Nothing in its
TypeScript names an algorithm, a date or a citation — even the deadline-type vocabulary is a data
block. Obligations resolve on every findings *read* (`api-server/src/lib/compliance.ts`), so a
mappings update reaches historical findings without a migration.

**Acceptance (M2 exit): met.** `lib/mappings/src/engine.test.ts` changes a date, adds an algorithm
and adds a deadline type in cloned data and asserts the output follows with no code change.
**Not closed by C1:** security-strength keying still returns both IR 8547 rows because key size is
usually undetermined (G-05), and `controls.json` crosswalks are untouched (C9/G-04).

† C2: the data files, provenance fields and boot-time schema validation are in place. The CI check
that blocks a `needs-check` entry from reaching a customer-facing template is **not built** — the
`confidence` field travels with each obligation so the renderer can label it, which is weaker.

Detail: [05-compliance-mapping.md](05-compliance-mapping.md)

---

## D. CISO surface

| # | Feature | Status | Pri |
|---|---|---|---|
| D1 | CISA quantum-readiness dashboard | `built` | **P1** |
| D2 | Mosca exposure view (per scenario) | `planned` | **P1** |
| D3 | Coverage/confidence meter — *what we haven't looked at* | `partial` | **P1** |
| D4 | Drift detection + alerting | `built`* | **P1** |
| D5 | Crypto-agility score | `planned` | **P1** |
| D6 | Migration wave planner | `planned` | **P2** |
| D7 | Trend/history view | `partial` | **P2** |
| D8 | Asset & host discovery (certificate transparency) | `built` | **P1** |

### D4 `built`* — drift that refuses to claim a remediation nobody performed

`GET /api/drift` returns what appeared, disappeared, reappeared and changed since a timestamp,
and `POST/GET/PATCH/DELETE /api/collection-schedules` (+ `run-due`) is the scheduled re-collection
that makes the window mean something. Together they are M3's "inventory of record rather than a
report generator".

**Nothing is persisted, deliberately.** A drift verdict written to a row is the exact C1 failure
this project exists to fix — an "urgent" recorded in 2026 still reads urgent in 2028, after the
deadline that made it urgent has passed. Every obligation on every entry is resolved through
`@workspace/mappings` on the way out, at one `asOf` for the whole response.

**The rule the module is built around: it must never report a remediation that did not happen.**
"This asset is gone" can mean the vulnerable line was deleted, or it can mean the collector never
ran, the credential expired, or the host was behind a firewall that day. B3 established that at
ingest level — an unreachable host is not marked `gone`, because a timeout is not evidence of
absence — and the feed preserves it on the way out: an asset that merely stopped being *looked at*
is not a disappearance, and the response carries a per-surface observability section so a reader
can tell "nothing changed" from "nothing was collected". A `since` in the future or one that does
not parse is a 400 rather than an empty feed, because an empty feed reads as a claim.

Scheduling refuses three things at the edge, each with a test: an interval below the floor (the
targets are the customer's own hosts and this server does the dialling, so a one-minute schedule
is a denial of service run on their behalf), a target list over the per-schedule cap (split it,
never truncate — a truncated list monitors a subset while reading as if it monitored all of them),
and a URL where a host was asked for.

\* **Not built: alerting.** The feed exists and nothing delivers it — no email, no webhook, no
digest. `run-due` also has no deployed trigger yet; something outside the process has to call it.

### D8 `built` — the first thing that names a host nobody told us about

Every collector in this repository is *handed* its targets: the customer names each host, uploads
each certificate, exports each key list. Nothing enumerated anything, which made total coverage
impossible by construction — you cannot inventory what nobody remembered to mention, and D3's
meter could not tell "we looked and found nothing" apart from "nobody told us this existed".
`POST /api/projects/:id/discovery` reads a domain's certificates out of Certificate Transparency
and produces names the customer never supplied.

**A discovered name is a lead, not an asset, and the whole design turns on that.** A CT entry
(RFC 6962) proves exactly one thing: at the logged timestamp, some CA issued a certificate
carrying this name. It does not prove a host ever existed there, that anything is there now, or
that the customer owns it. So discovery has **no `Surface` value, no fingerprint case, no
catalogue entry and no `collection_runs` row** — leads live on their own `discovered_targets`
table and nothing enters `assets` until a real collector examines the target. `POST
/projects/:id/discovered-targets/probe` is that hand-off, to B3.

Three refusals carry the feature:

- **Label-boundary matching, never substring.** `example.com.evil.test` and `notexample.com` are
  rejected `out-of-scope`, and every rejection is *reported with its reason* rather than dropped —
  a name we declined to act on is information, and a silent drop is indistinguishable from a
  parser that never saw it.
- **A wildcard is not a host.** `*.example.com` covers a set and is evidence for no member of it.
- **DNS is corroboration, not enumeration, and it is three-state.** NXDOMAIN is `not-resolved`,
  but a SERVFAIL, a timeout or an unreachable resolver is `undetermined` — never `not-resolved`.
  The distinction is the difference between "this host is gone" and "our resolver was down", and
  only the first is grounds for retiring a target. A name never looked up stays NULL: nobody
  looked is a third state again.

Egress is guarded like B3's prober: an allowlisted source host, a resolve-then-pin check that
refuses a private range unless an explicit escape hatch is set, a timeout and a response byte cap.
A truncated CT response fails to parse rather than half-loading, because half an estate that looks
whole is this feature's worst outcome.

**Naming note:** the lane wrote itself up as "D7" throughout its source, which is the trend view's
id. Renamed to D8 on merge — two features sharing an id is how a status table stops being
readable.

Detail: `tests/e2e/14-discovery.spec.ts`

### D1 `built` — and it read `planned` here for a day after it shipped

`GET /api/inventory/readiness` bundles the readiness sections with the estate-wide coverage meter
in one payload, `Readiness.tsx` renders it at `/readiness`, and
`tests/e2e/06-readiness.spec.ts` exercises it against a real stack. It shipped in the
2026-08-14 wave and this table still called it `planned` the next day — the third consecutive
wave in which a lane forgot rule 9 of its own brief. Check the route and the spec before
believing a row in this file.

Detail: [06-cisa-dashboard.md](06-cisa-dashboard.md)

### D7 `partial` — the timeline, and what it refuses to draw

`GET /api/inventory/timeline` and the dashboard's Timeline tab plot the estate's Mosca exposure
against time: one point per real collection instant, three lines (one per Q-Day scenario, never a
blend), and the IR 8547 / CNSA deadlines that apply to the algorithms actually in the inventory,
resolved through C1 rather than written down anywhere in TypeScript. It is the first estate-wide
view in the product — D3's meter is per project, and its own note said the roll-up needed an asset
model spanning projects; `assets` is that model, joined to projects by the `project:<id>:` location
prefix.

What it deliberately does **not** do is the point of the feature. It does not resample onto a
regular grid: an evenly-spaced series between the first scan and today produces a smooth rising
curve on an estate that never changed, because Z shrinks on its own, and that curve is a
fabrication that looks like data. With fewer than two collection instants it says so in a sentence
and draws no line at all, because a flat line through one measurement asserts a trend nobody
observed. And the projection lives in a separate branch of the payload, hatched and dashed on the
page, with its assumption restated on every projected frame.

Doc 06's time-pressure row asks for two figures this panel could not produce. **One of them now is
(G-22, closed 2026-08-15):** `certificateExpiry` counts the certificates the estate currently holds
against each Q-Day scenario — how many are still valid on that date, how many expire first, and how
many carry an expiry we could not read. That third bucket is the honest part: an unparseable
`notAfter` compared numerically lands in "expires before Q-Day", the reassuring answer, so it is
guarded and counted instead. Retired certificates are excluded.

That row had been labelled uncomputable on the grounds that no certificate collector had shipped —
correct when written, false a week later when B4 landed. **A refusal has to be re-checked when the
thing it was waiting for arrives**, or it becomes its own kind of false statement.

The second label stands: renewal cycles remaining before a deadline is still not computable,
because nothing records a refresh interval.

**D2 stays `planned`.** The scrub readout does render doc 06's three-column exposure panel — a
count and a share per scenario, with X's provenance beside it — but D2's actual requirement is
that "clicking a scenario re-scores the whole page", and no number anywhere is clickable yet.
Counting it as partially built would claim the interaction that makes it useful.

Detail: [06-cisa-dashboard.md](06-cisa-dashboard.md)

### D3 deserves special mention

Most security dashboards only show what they found, which silently implies complete coverage.
For an inventory product that is a *credibility-destroying* omission — a CISO who presents our
report to an auditor and gets asked "does this include your mainframe?" needs the answer to be
on the page.

Show unscanned surfaces as explicit gaps with an estimated blind-spot size. **The honest
version is the more sellable one**, because it converts the gap into next quarter's budget ask.

**D3 `partial` — built per project, on the dashboard.** `GET /api/projects/:id/coverage` and the
dashboard's coverage meter report which of the thirteen collector surfaces have been examined for a
project, which never have, and the confidence distribution of what was found (the first consumer
of `observations.confidence` — see [09-open-gaps.md](09-open-gaps.md) G-11). The ten surfaces come
from one catalogue, `@workspace/collectors/surface-catalogue`, which the public coverage page reads
too, so the two cannot disagree again.

Two things it deliberately does **not** do. There is **no estimated blind-spot size**: nothing we
hold supports a number for how much cryptography sits in the nine unexamined surfaces, so the meter
states that it is not estimable rather than printing a figure. And the meter is per project — the
estate-wide roll-up belongs with D1, which needs an asset model that spans projects.

Detail: [06-cisa-dashboard.md](06-cisa-dashboard.md)

---

## E. Reports

| # | Report | Status | Pri |
|---|---|---|---|
| E1 | Board / executive pack | `planned` | **P1** |
| E2 | Regulator / auditor inventory submission | `planned` | **P1** |
| E3 | CBOM (machine-readable) | `next` | **P0** |
| E4 | Technical remediation backlog | `planned` | **P2** |
| E5 | Vendor assessment pack | `planned` | **P3** |
| E6 | Scheduled report delivery | `planned` | **P2** |

Detail: [07-reports.md](07-reports.md)

---

## F. Platform & security

| # | Feature | Status | Pri |
|---|---|---|---|
| F1 | Authentication + RBAC | `built`† | **P0** |
| F2 | Multi-tenancy with hard isolation | `partial` | **P0**† |
| F3 | Audit logging | `planned` | **P1** |
| F4 | Source-code handling controls (ephemeral mode) + credential store | `built` | **P0**† |
| F5 | Self-hosted / on-prem deployment | `planned` | **P1**‡ |
| F6 | SSO / SAML | `planned` | **P2** |
| F7 | Secrets management (no `.env` in git) | `partial` | **P0** |
| F8 | Ticket sync (Jira / ServiceNow) | `deferred` | **P3** |

† **F1 `built` — a person can sign in, the role is enforced, and it can be administered.**
The row said `built` while this footnote still said `partial`, from the day RBAC's enforcement
landed and nobody reconciled the two halves; the enforcement is real (stage 3/5 of the RBAC
series), so the row was right and the footnote was stale.
Organisation-scoped authorisation is enforced in the database (see F2), and the shared API key
still protects `/api` exactly as before. What landed 2026-08-15 is the authentication half: an
identity-provider registry, sessions, and six `/auth/*` routes including organisation switching. A
session principal now exists *beside* the API-key principal rather than replacing it — every
existing deployment and every other spec depends on that, and `18-auth.spec.ts` asserts it.

**Only GitHub is implemented, and the reason is testability rather than scope.** `openid-client`
validates an `id_token`'s signature, `iss`, `aud` and `nonce`, so a flow test for Google needs a
stub that serves a JWKS and mints signed tokens; without one the Google path would ship with no
test that could fail — which, for the single code path that decides who a request is, is worse
than shipping it absent. GitHub is plain authorisation-code OAuth with no token signing, so its
stub is an `http` server and its test genuinely exercises `state`, PKCE, single-use and replay.
Microsoft is out of scope by [13-auth-and-tenancy.md](13-auth-and-tenancy.md) §10's own ordering.
The registry documents all three anyway, because the properties that differ (`oid` rather than
`sub`; Microsoft's `email_verified` always false) belong written down next to each other — and
`/auth/providers` returns only what is implemented, so the deferral cannot be mistaken for a
button a user could press.

**RBAC landed 2026-08-15** — `owner / admin / member / viewer`, plus **divisions**: a first-class
group owning projects, so a role can be granted over a team or business unit rather than the whole
tenant. Sub-organisation scoping is enforced **in the row-level-security policies**, not in route
code, because a filter in application code is one somebody can forget and the failure returns
another division's rows rather than an error.

Writes are gated by one middleware, and the default is the design: a read needs `viewer`, anything
else needs `member`, and a route nobody thought about is therefore closed to read-only accounts.
The shared API key gets an explicit role too — defaulting to `admin` so no existing deployment
breaks — because without it RBAC would be bypassable by the credential every deployment already
holds. Full design, including why `assets` needed a denormalised `division_id`:
[15-rbac-design.md](15-rbac-design.md).

**The management screen landed 2026-08-15** at `/access` (`pages/Access.tsx`), against the same
routes an operator would curl (`/api/divisions`, `/api/organization/members`). Two things on it are
wording decisions rather than layout ones, and both are asserted in `tests/ui/access-journey.spec.ts`
rather than left to a reviewer: **a role is rendered as the sentence describing what it may do**,
because "viewer" tells the person choosing it nothing; and **dissolving a division says that its
projects become organisation-wide**, because that is a widening of access disguised as a tidy-up and
"are you sure?" hides it. A role that cannot read the page sees the server's refusal, never an empty
table that reads as an organisation with no members.

**Not built:** member *invites* are gated but unimplemented — adding a person needs an email flow.

**A deployment with no `SESSION_SECRET` is unchanged**, byte for byte: no session middleware is
installed, no cookie is parsed, and every `/auth/*` route answers 501. Configuring a provider
*without* a secret is a startup error rather than a silent downgrade, because that combination is
a sign-in flow that completes and leaves the caller anonymous.

**F2 `partial` — the isolation is real, and a second tenant can now exist.** Every
organisation-scoped table carries `organization_id` under a PostgreSQL row-level-security policy,
the runtime connects as a role without `BYPASSRLS`, and every route goes through `withOrg`, so a
forgotten `where` clause returns zero rows rather than another tenant's data. An automated
cross-tenant suite proves it, with a negative control demonstrated able to fail. What used to be
missing — the ability to *create* a second tenant and bind more than one API key to it — is
closed: `pnpm --filter @workspace/db run create-organization` creates an organisation (and purges
the legacy NULL-org `activity` rows the design doc's §10 flags as a leak once a second tenant
exists), and `QUANTAXSCAN_API_KEY_ORG_IDS` binds N keys to N organisations positionally, replacing
the single `QUANTAXSCAN_API_KEY_ORG_ID`. Proven cross-tenant with two live keys, two organisations,
through the real stack (`cross-tenant.test.ts`, `tests/e2e/07-multi-org.spec.ts`). Still missing:
everything that needs a *person* rather than a machine key — self-serve organisation creation over
HTTP, and per-user membership — both of which need F1's sign-in first. Detail and deploy order:
[13-auth-and-tenancy.md](13-auth-and-tenancy.md) §5, §9, §10.

**F4 `built` — two controls that turned out to be one feature.** The catalogue listed F4 as
source-code handling; the lane that built it found the same rule underneath both halves, so they
shipped together.

*Ephemeral mode*: `POST /scans` takes a `retentionMode`, and `persistedSnippet()` is the single
choke point every finding row is written through, so a future third writer that forgets the mode
fails to typecheck rather than silently retaining code. Absent means `retained` — what every
existing submission already did — and the default is written at the route rather than left to the
column default, because the column default describes rows written before the feature existed and
that is a different statement. `findings.code_snippet` is `NOT NULL`, so an ephemeral finding
carries a self-describing marker instead of an empty string: "nothing was kept" and "we kept an
empty line" must not look alike.

*Credential store*: an org-scoped `credentials` table holding AES-256-GCM ciphertext under a key
from the environment, three routes (register, list, revoke) and **no read-back route** — the only
way a secret leaves is `redeemCredential()` inside the process, which hands a collector a
`SecretHandle` whose coercion hooks render `[redacted]` in any interpolation. Six of the eight live
surfaces are submission-based precisely because there was nowhere to hold a customer credential;
this is that place, and wave two's credentialed KMS polling and live database reads build on it.
Deliberately absent: no plaintext hash, length, prefix or last-four, because each is an oracle a
database dump can test guesses against and nothing needs one. Revocation nulls the material rather
than setting a flag, so the audit trail survives with nothing left to decrypt.

Both halves rest on the same rule — a secret must not be reachable from a place nobody thought to
look — which is why the route logs an error's *class* rather than the error object (a driver error
echoes the failing statement's bind parameters) and why the 400 branch does not return zod's
message (it serialises the input it rejected). `secret-redaction.test.ts` greps the real logger's
output; `tests/e2e/13-credentials.spec.ts` greps the raw HTTP response text rather than asserting
on named fields, because a leak arrives through the field nobody listed.

**F7 `partial`** — `.env` is out of git and gitignored (S5/G-13). Secret scanning in CI is not
done.

F1/F2/F4 are P0 the moment a second organisation's data enters the system. The mechanism for F2
now exists ahead of that moment, which is the intended order.

‡ Promote to **P0** if design partners refuse SaaS source-code ingestion.

Detail: [08-security.md](08-security.md), [13-auth-and-tenancy.md](13-auth-and-tenancy.md)

---

## Deliberate non-features `won't`

Automated remediation PRs · IDE plugins · our own PQC crypto library · quantum-safe VPN
products · blockchain/wallet tooling · real-time traffic interception.

Each has been considered and rejected for the first 12 months. Reopening one requires updating
[01-strategy.md](01-strategy.md), not just this list.
