# 02 — Roadmap

## Start here

If you read nothing else in this file:

> **Build the asset/observation schema migration first.**
> Not the flashiest work, but every other feature in this plan depends on it, and retrofitting
> it after you have customer data is dramatically more expensive than doing it now, while the
> only rows in the table are from a smoke test.

Then, in order: **CBOM export → Mosca risk → dependency collector → TLS/cert collector →
CISA dashboard.**

*Update 2026-08-13:* the dependency collector's *detection* half jumped the queue and landed
early (B2, `lib/collectors/src/dependency-collector.ts`) because it needed no schema or route
change. Its *ingestion* half — a `surface: "dependency"` fingerprint path and a route that
accepts lockfiles — has not, so the ordering above still holds for the work that remains.

The reason CBOM export comes second, before anything more exciting: it is cheap, it forces the
asset model into a shape that is externally validated rather than one we invented, and it is
the artifact auditors and other tools actually consume. Getting it right early prevents a
schema we have to break later.

---

## Two parallel tracks

Coverage and product are different kinds of work with different people and different risk
profiles. Running them as one sequential list stalls both.

```
         ┌─────────────────────────────────────────────────────────────┐
COVERAGE │ source ✅ → deps/SBOM → TLS+certs → KMS/config → binaries → OT │
 TRACK   └─────────────────────────────────────────────────────────────┘
         ┌─────────────────────────────────────────────────────────────┐
PRODUCT  │ asset model → CBOM → Mosca → mapping engine → dashboard →     │
 TRACK   │ reports → drift → RBAC/tenancy                               │
         └─────────────────────────────────────────────────────────────┘
              ▲              ▲                  ▲              ▲
             M1             M2                 M3             M4
```

Milestones are the sync points where both tracks must land together.

---

## Phases

### Phase 0 — What exists `built`

Regex scanner over source, 7 algorithm patterns, per-scan findings, project dashboard,
community hub, GitHub repo ingestion, AI chat. Roughly a working demo of one collector.

**Explicitly acknowledge:** this covers a small fraction of enterprise cryptographic exposure,
because most crypto lives in dependencies and TLS termination, not in application source.

---

### Phase 1 — Inventory foundation → **M1**

*Goal: an asset exists independently of the scan that found it, and can be exported.*

| Work | Track | Why now |
|---|---|---|
| Asset/observation schema migration | Product | Everything depends on it |
| Collector interface abstraction | Product | Otherwise every new surface forks `scanner.ts` |
| CycloneDX 1.7 CBOM export | Product | Cheap, validates the asset model externally |
| Dependency / SBOM collector | Coverage | Largest single coverage jump available — collector built, ingestion not |
| Data classification field (`X`) | Product | Unlocks Mosca |
| Mosca risk engine, split from detection | Product | The core differentiator |

The first two rows landed 2026-08-02 (A1/A2), minus the read cutover. The dependency collector
landed 2026-08-13 as a *collector only*: it produces observations from lockfiles, but nothing
submits a lockfile to it and no dependency asset is persisted, so the M1 exit criterion below
about third-party dependencies is **not** met by it. Per-feature status lives in
[03-features.md](03-features.md), not here.

**M1 exit criteria**
- A repo scan produces assets that survive a re-scan with stable IDs and `firstSeen`/`lastSeen`
- `GET /api/inventory/cbom` returns a CycloneDX 1.7 document that passes schema validation
- Crypto found inside a third-party dependency appears in the inventory
- Every asset returns a Mosca verdict against three Q-Day scenarios

---

### Phase 2 — Compliance & evidence → **M2**

*Goal: the inventory produces artifacts a regulator or auditor accepts.*

| Work | Track | Notes |
|---|---|---|
| Dynamic mapping engine | Product | Data-driven, not hardcoded — see [05](05-compliance-mapping.md) |
| `mappings/` data files versioned + provenance | Product | Standards move; the code must not |
| CISA quantum-readiness dashboard | Product | See [06](06-cisa-dashboard.md) |
| Report generation (4 report types) | Product | See [07](07-reports.md) |
| TLS / cipher-suite collector | Coverage | External surface, demos instantly |
| Certificate / X.509 collector | Coverage | Expiry-vs-Q-Day is a visceral chart |

**M2 exit criteria**
- A finding maps to its NIST/CNSA/CISA obligations **without a code change** when standards data updates
- Board pack PDF generates end-to-end from real inventory data
- Certificate inventory shows which certs outlive the conservative Q-Day scenario

---

### Phase 3 — Continuous & trustworthy → **M3**

*Goal: it is an inventory of record, not a report generator.*

| Work | Track |
|---|---|
| Drift detection + alerting on newly-introduced vulnerable crypto | Product |
| Crypto-agility scoring | Product |
| Waivers / exceptions register with expiry and sign-off | Product |
| Scheduled re-collection | Product |
| KMS / secret-store collectors (Vault, AWS KMS, Azure Key Vault) | Coverage |
| Protocol config collector (SSH, IPsec/VPN, JWT `alg`, SAML/OIDC) | Coverage |

---

### Phase 4 — Enterprise readiness → **M4**

*Goal: a regulated enterprise can actually deploy it.*

RBAC, SSO/SAML, multi-tenancy with hard isolation, audit logging, on-prem/self-hosted
deployment, data residency, ticket sync (Jira/ServiceNow), and the security hardening in
[08-security.md](08-security.md).

**Note:** if design partners refuse to send source code to SaaS — the likeliest failure mode in
[01-strategy.md](01-strategy.md#what-would-falsify-this-thesis) — self-hosted deployment jumps
from Phase 4 to Phase 1 and the whole roadmap reshuffles. Test this assumption in the first
three customer conversations, not later.

---

### Phase 5 — Long-lead surfaces

Binaries/firmware analysis, vendor/third-party assessment, OT/embedded/hardware.

**The counterintuitive bit:** OT and embedded deliver value last but must enter the *plan*
first. Their lead time is a hardware replacement cycle — 7 to 15 years. If the conservative
Q-Day scenario is 2030, decisions about a device fleet have to be made at the next procurement
cycle, not after the easy web-tier work is done. Naive prioritisation sorts by effort and puts
this last; that is exactly backwards.

Ship a **manual OT register** in Phase 2 — a simple form where the customer records device
fleets, crypto, and refresh dates — long before automated OT discovery is feasible. Low effort,
and it gets the longest-lead items onto the roadmap where they belong.

---

## Sequencing rationale

Why this order and not the obvious one:

| Tempting order | Why it's wrong |
|---|---|
| Add more languages to the regex scanner | Depth on a surface that is already the least of the exposure |
| Build the dashboard first — it demos well | It will be empty and its shape will be dictated by whatever data happens to exist |
| Do all collectors, then the product layer | Nothing is sellable until the product layer exists; collectors alone are a feature |
| Do the product layer, then collectors | The dashboard shows one surface and buyers see through it immediately |
| Skip CBOM, it's a checkbox | It is the schema contract. Inventing our own asset model and retrofitting CycloneDX later is a rewrite |

## Explicit non-goals for the first 12 months

`won't` — stated so they stop being re-litigated:

- Automated remediation / PR generation
- IDE plugins
- A PQC crypto library of our own
- Quantum-safe VPN / proxy products
- Blockchain or wallet-specific tooling
- Real-time network traffic interception (passive scanning only)
