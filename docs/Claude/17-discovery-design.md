# 17 — Discovery and credentialed collection

**Design, not built.** Written 2026-08-16, as wave-4 lane E, against `main` at `7ca1ada`. Nothing
in this file has been implemented. It exists so that the lane which does implement it starts from a
design rather than a blank page — and specifically so that the three or four people who will each
have to edit `artifacts/api-server/src/lib/asset-ingest.ts` do it in an order somebody thought
about first.

The sibling documents this one leans on hardest are
[04-architecture.md](04-architecture.md) (the asset/observation model and the collector contract),
[13-auth-and-tenancy.md](13-auth-and-tenancy.md) (why a route never imports `db`, and why scopes do
not nest), and [16-wave-4-lanes.md](16-wave-4-lanes.md) (the file-disjointness selection rule this
document's §6 applies). The one piece of shipped code it generalises from is **D8**, discovery from
certificate transparency: `lib/collectors/src/discovery.ts`,
`lib/db/src/schema/discovered_targets.ts`, `artifacts/api-server/src/routes/discovery.ts` and
`tests/e2e/14-discovery.spec.ts`.

---

## 0. Why this document exists

A gap analysis of the product against its stated goal — *see the cryptography behind every website,
certificate, network conversation, database, storage bucket, cloud vault, server, Windows endpoint,
IAM and authentication system a client operates* — found that coverage has three axes and the
product reports one of them.

| Axis | Question | Where we are | Where it is reported |
|---|---|---|---|
| **What** | which surfaces exist | 10 of 13 catalogued as `live` | `COLLECTOR_SURFACES`, the D3 meter, the marketing coverage page |
| **How** | how each is collected | one observes, the rest receive. **0 credentialed, 0 agent** | nowhere |
| **When** | how often | one-shot everywhere except `tls` (M3 schedules) | `collection_schedule_runs`, and only for `tls` |

The middle row is not an estimate. `collection_schedules.ts` states it directly, as the reason its
target vocabulary has exactly one value: *"`tls` is the one surface whose collector reaches out and
observes the world on its own — it opens a socket to a host the customer named and records what that
host negotiates today."* Everything else is fed by an upload or a form.

The verdict was: **nothing in the product discovers a host, a database or a key it was not handed.**
Nine of the ten live surfaces wait for a customer to hand them something. The critical path named was
(1) secret handling — closed, F4 shipped; (2) **discovery**; (3) **credentialed collection**;
(4) the three thin surfaces; (5) continuity; (6) enterprise deployment. Steps 2 and 3 are this
document's subject.

Neither was given to a wave-4 build lane, and the reason is worth stating because it is also the
reason this file is long: **every credentialed variant touches `asset-ingest.ts`**, which
[CLAUDE.md](../../CLAUDE.md) names as the single worst conflict magnet in the repository, and
`routes/projects.ts` (2,201 lines, one block per collector) is the second. Four lanes each adding a
block to both is the wave-3 merge, repeated. §6 exists to make that not happen.

Two facts about the surrounding documents matter before reading further, because both make the gap
look smaller on paper than it is.

**Neither discovery nor credentialed collection appears in any roadmap phase.**
[02-roadmap.md](02-roadmap.md)'s five phases plus M1–M4 contain no row for either. D8 shipped
without one. The only forward-looking statements live outside the roadmap — doc 16's
*"Credentialed collector variants — unblocked by F4 now"* under **Deliberately held back**, and
03-features' *"wave two's credentialed KMS polling and live database reads build on it."* A
capability with no phase has no owner and no sequencing, which is a large part of why it has not
happened.

**Three feature rows still name F4 as the blocker, and F4 shipped.** B5: *"a product whose
source-code/secret-handling controls (F4) are not built."* B7: *"Connecting to a live database needs
somewhere to put a production credential, and F4 is unbuilt."* B12: *"it cannot authenticate until
F4."* All three are stale. This is precisely the failure G-22 was opened and closed for — *"a
refusal has to be re-checked when the thing it was waiting for arrives, or it silently becomes its
own kind of false statement"* — and the register's own cross-reference asks for exactly that sweep:
*"the same stale-refusal check should be run over every 'not available' string in the product."*
It was not run over these three. The blocker is gone; only the sentences remain.

---

## 1. What discovery is, and what it is not

### 1.1 The rule, stated generally

> **Discovery produces leads. Collection produces evidence. A lead is never counted as evidence,
> and discovery must never be able to move a surface off `never-examined`.**

D8 states this for one source. The general form has to hold for all of them, because the moment a
discovered target can be counted as examined, the coverage meter — the product's entire credibility
claim — starts inflating itself from a source that examined nothing.

`discovered_targets.ts` already says why, in the specific case:

> *Writing it into `assets` would put a name somebody's CA once logged into the same table as a
> completed TLS handshake, and every meter that counts assets would silently inflate.*

The general reason is the same and slightly stronger: a lead is a statement about **where to look**,
and an asset is a statement about **what is there**. `assets.algorithm` is `NOT NULL`. There is no
honest value to put in it for a host nobody has connected to, an RDS instance nobody has read the
parameter group of, or an IAM role nobody has fetched the signing key for — and the only way to
write such a row is to invent one. B11 hit exactly this and refused it: a network conversation whose
cipher nothing named is a `network_flows` row with `cryptoState: "undetermined"`, **not** an asset,
because *"a sentinel algorithm would be a fabricated value"*.

### 1.2 The five invariants D8 established, which every source inherits

These are not stylistic. Each names a failure that produces a *silently wrong report* rather than an
error, which is the class this codebase treats as worse than a missing feature.

1. **A discovery source writes no `assets`, no `observations` and no `collection_runs` row, and
   introduces no `Surface` value, no fingerprint case and no `location_detail` kind.** The e2e
   assertion that guards it — *"a discovered name is not an asset — discovery examines nothing"* —
   walks every surface in the coverage payload and requires all of them to still read
   `never-examined` after a discovery run. Every new source must extend that test, not add its own.

2. **The evidence a target carries is exactly what the source asserted, and the claim it supports
   travels in the payload.** `DISCOVERY_EVIDENCE_CAVEAT` is a string in the response body, not a
   line in the documentation, for the same reason B3's `evidenceCaveat` is: a caveat a client has to
   remember to add is a caveat that will be missing from the one report that matters. **This must
   become per-method** — see §1.3.

3. **Every rejection is counted and returned with a reason; every truncation is reported.**
   `MAX_DISCOVERED_HOSTNAMES_PER_RUN = 500` exists with `truncated` beside it because *"silently
   trimming 4,000 names to 500 would make 'we know of N endpoints' a lie, and a lie in the one
   number this feature was built to make honest."* Every paginated cloud API has the same ceiling
   and needs the same flag.

4. **A corroboration that could not be performed is `undetermined`, never a negative.**
   `DNS_RESOLUTION_VALUES` is three values plus NULL — and NULL, "nobody looked", is a fourth state
   distinct from all three. The e2e spec points DNS at a dead port specifically to prove that an
   unreachable resolver produces `undetermined` and not `not-resolved`, because *"acting on it
   retires a live target."* Every credentialed enumeration has the same shape: an `AccessDenied` on
   one region is not evidence that the region is empty.

5. **Discovery finding a target is not consent to connect to it.** The handoff from D8 to B3 is a
   separate route that requires the caller to name target ids, has no "probe everything" shortcut
   and no default port. *"Every one of those is friction on purpose."* Credentialed enumeration
   weakens the ownership argument (the customer gave us the key to the account, so the resources in
   it are theirs) but it does **not** weaken the consent argument: enumerating an EC2 fleet is a
   control-plane read, and connecting to one of those instances is a packet arriving at a machine.
   Keep the two acts on separate routes.

### 1.3 What does **not** generalise from D8, and must be modelled rather than assumed

D8's caveat is a module-level constant because there is exactly one method. With several sources the
strength of the ownership claim varies enormously, and flattening that into one sentence would be
dishonest in both directions:

| Source | What a target proves about ownership | What it proves about completeness |
|---|---|---|
| Certificate transparency | **Nothing.** A SAN list routinely names a supplier, a CDN, a former subsidiary | Nothing. CT only ever sees names given a publicly logged certificate |
| Cloud account enumeration under the customer's own read-only key | **The account is theirs** — they issued the credential | Complete *for that account, that service, that region, that page, at that instant* — and for nothing else |
| An MDM/EDR fleet export | The machines are enrolled, which is stronger than "theirs" and weaker than "all of theirs" | Complete for what is enrolled. Unenrolled machines are invisible **and uncounted** |
| An OIDC discovery document at a URL the customer named | Nothing beyond the customer naming it | Complete for that issuer's advertised configuration |

So the caveat is **resolved on read from the target's `discovery_method`, never stored** — the same
discipline `resolveSecrecyLifetime()`, `assessOtExposure()`, `certificateExpired()` and the C1
mapping engine all follow, and for the identical reason: a claim written into a row is a claim that
cannot be corrected. A per-method caveat table belongs beside `DISCOVERY_METHOD_VALUES` in
`lib/collectors/src/enums.ts`, not in a column.

---

## 2. The target model

### 2.1 The choice: extend `discovered_targets`, do not add a second table

A lead is one concept. The argument D8 gives for keeping a lead out of `assets` — *there is no
cryptography here at all* — applies identically and without modification to a discovered RDS
instance, a discovered Key Vault, a discovered domain controller and a discovered SAML connector.
Two tables of leads would mean two sets of policies and grants, two `ORG_SCOPED_TABLES` entries, two
denominators for the D3 meter, and a `summariseDiscoveryCoverage()` that has to union them — with
the standing risk that the second table forgets an invariant the first one holds.

The rejected alternative worth naming is **one table per source kind** (`discovered_hosts`,
`discovered_cloud_resources`, `discovered_machines`). It is superficially tidier — each gets a tight
schema instead of a wide nullable one — and it is wrong for the reason the surface catalogue is a
single list: the meter's denominator is an honesty claim, and *"a second hardcoded copy of this list
is not a tidiness problem, it is a correctness one."*

### 2.2 The schema change

Three edits, one migration.

**(a) `hostname` becomes `identity`; `hostname` returns as a nullable, narrower column.**

`discovered_targets.hostname` is `NOT NULL` and is half the unique index. An IAM role, a KMS key, an
S3 bucket and a Windows machine have no hostname, and forcing one means minting a fake name — the
exact thing `normaliseHostname()` refuses to do (*"this function never fixes a name into something
plausible, because a repaired name is a name nobody has evidence for"*).

```
identity      text NOT NULL   -- the source's own canonical id: a hostname, an ARN, a resource
                              -- name, an Azure `kid`, a machine SID. Never constructed by us.
target_kind   text NOT NULL   -- hostname | cloud_resource | data_store | key | machine | principal
hostname      text NULL       -- present iff this target genuinely has a DNS name. NULL means
                              -- "this kind of thing does not have one", which is why the three
                              -- DNS corroboration columns are meaningful exactly where it is set.
```

The unique index becomes `(organization_id, project_id, identity, discovery_method)`. `target_kind`
is a const tuple in `@workspace/collectors` next to `DISCOVERY_METHOD_VALUES`, with `text` + a
`CHECK` built by `oneOf()` — never a Postgres `ENUM`, per CLAUDE.md.

**(b) `evidence` becomes a discriminated union, discriminated by `discovery_method`.**

It is typed `CtCertificateEvidence` today. It is `jsonb`, so a new variant needs **no migration** —
the same property `location_detail` relies on (*"adding a kind therefore needs no migration"*).
Validate at the application boundary with a zod schema shaped like `LocationDetailSchema`. Keep the
absent-not-invented rule inside every variant: a cloud API that returns no creation date yields
`null`, never a placeholder.

**(c) `source_domain` becomes `source_scope`, and a target points at the run that found it.**

```
source_scope            jsonb  NOT NULL  -- what was searched: {kind:"domain", domain:"x.test"}
                                         -- or {kind:"cloud_account", provider:"aws",
                                         --     account:"1234", region:"eu-west-1"}
last_discovered_run_id  integer NULL     -- not an FK; see below
```

`source_domain` exists so *"a name's scope claim can be re-checked against the question that
produced it."* That reason is unchanged and now needs a shape that can hold an account and a region.

### 2.3 `discovery_runs` — the row that has to exist before any of this is honest

**This is the single most important addition in this document.** Today a discovery run leaves no
record at all: `POST /projects/:id/discovery` returns `entriesRead`, `namesRead`, `rejected` and
`truncated` in the response body, and the moment that response is closed nobody can ever recover
what the run covered. For CT that is survivable, because a CT query is total or it fails. For a
credentialed cloud enumeration it is not, because **partial success is the normal case**: three
regions enumerated, one throttled, one `AccessDenied`, one service unsupported.

The codebase has already learned this lesson one level down. `collection_schedule_runs` exists
because *"a week of unreachable hosts is indistinguishable from a quiet week"* — an absence with no
successful collection behind it means nothing at all. Discovery has exactly the same hole, at the
level of the estate rather than the asset, and today it is wide open.

```
discovery_runs
  id, organization_id, division_id, project_id
  discovery_method     text NOT NULL
  credential_id        integer NULL      -- which credential, for the credentialed methods.
                                         -- Not an FK: referential integrity is checked with RLS
                                         -- bypassed, the same reason assets.status_changed_by_run_id
                                         -- is not one.
  status               text NOT NULL     -- succeeded | partial | no_evidence | failed
  enumerated           jsonb NOT NULL    -- [{scope, complete:true}]  — what we can speak for
  refused              jsonb NOT NULL    -- [{scope, reason}]         — what we cannot
  truncated            boolean NOT NULL  -- a pagination ceiling was hit
  targets_created, targets_updated, targets_rejected  integer NOT NULL DEFAULT 0
  started_at, finished_at
  error                text NULL
```

`status = "partial"` is the value that does not exist anywhere in the product today and has to. A
run that enumerated four of five regions is not `succeeded` (it did not do what it was asked) and it
is not `failed` (it produced real leads), and collapsing it into either one destroys the only fact a
report needs: **the boundary of what we can speak for.**

`refused[].reason` comes from a closed vocabulary — `access-denied`, `throttled`, `unauthenticated`,
`unsupported`, `unreachable`, `timeout` — and **never from a vendor SDK's error object**. See §4.6.

### 2.4 What it costs

Stated plainly, because each of these is a real bill somebody pays:

- **One migration**, touching a live table with an e2e suite over it. `hostname` → `identity` is a
  rename plus a unique-index rebuild plus a nullable re-add; `tests/e2e/14-discovery.spec.ts`,
  `discovery-coverage.ts`, `routes/discovery.ts`'s `targetPayload()` and the `openapi.yaml` schema
  all name `hostname` and all change in the same commit. Per doc 16's rule, **only one lane may
  carry a migration**, so this lands in stage 0 (§6.1) and nobody else generates one.
- **Two new org-scoped tables' worth of ceremony for one** (`discovery_runs`): an entry in
  `ORG_SCOPED_TABLES` (`lib/db/src/tenant-isolation.ts`), a policy and a grant in
  `lib/db/sql/tenant-isolation.sql` — *never* via `drizzle-kit push`, which writes a NULL `USING`
  clause and installs no isolation at all — a `division_id` column denormalised at write, and a row
  in `cross-tenant.test.ts`'s manifest for every route that reads it. A table with no grant is
  unreachable by the runtime, which is the fail-closed default and is what you will hit first if you
  forget.
- **`assets` carries a denormalised `division_id`** resolved once per ingest by
  `divisionForTarget()`, because parsing `project:<id>:` out of `location` inside an RLS policy runs
  on every row of every query. Both new/changed tables must do the same, from the same helper.
  `discovered_targets` already has the column.
- **A wide nullable table.** `hostname`, `resolved_addresses`, `dns_resolution` and `dns_checked_at`
  are meaningless for five of the six `target_kind` values. That is the price of one table, and it
  is cheaper than the alternative in §2.1.

### 2.5 The question that has no repository answer: is a lead project-scoped?

`discovered_targets.project_id` is `NOT NULL`. A credentialed cloud enumeration is naturally scoped
to a *credential and an account*, not to a project — and `credentials` is organisation-scoped with no
project column.

**Recommendation: keep `project_id NOT NULL`, and require the caller to name a project.** Two
reasons. First, division-based RBAC reads through the project (`divisionForTarget()` returns `null`
for a run that targets no project, and `null` means organisation-wide, i.e. *every division sees
it*) — so an org-wide lead table is a silent widening of who can see which cloud accounts a company
runs, and that should be a deliberate decision rather than a side effect of enumeration. Second, the
fingerprint has already taken this exact trade four separate times: `repo` was added to the
`dependency`, `tls`, `certificate` and `kms` variants because *"`assets.location` is a single
`notNull` column and cannot name two projects"*, accepting duplicate rows across projects in
exchange, because *"a query can aggregate rows, but no query can split one row back into the two
projects it stood for."*

The cost, named: two projects enumerating the same AWS account produce two sets of leads and the
"how many things do we know about" number double-counts. Mitigate by deduplicating on
`(identity, discovery_method)` in the *coverage* arithmetic, not in the table.

---

## 3. The discovery sources, in priority order

### 3.1 The ordering rule

Priority is **not** "how much of the estate does it reveal". It is:

> How much estate does this reveal per unit of customer effort, **given that the surface it feeds
> already has a collector that can examine what it finds?**

A lead nobody can act on is a to-do list, not coverage. It moves `unexaminedTargets` up and
`examinedTargets` not at all, which makes the honest reading *worse* with no compensating
capability. So a source that feeds a `live` surface beats a source that feeds a `planned` one, even
when the second reveals more.

The secondary criterion is **which F4 credential kind it needs**, because
`CREDENTIAL_KIND_VALUES` is deliberately closed — *"Adding a value means adding a consumer; there is
no `generic` member on purpose, because a generic bucket is how every credential ends up in it."* A
source that reuses an existing kind is strictly cheaper than one that widens the tuple.

Both criteria point the same way as [01-strategy.md](01-strategy.md) already does, which is worth
quoting because it is the only place in the docs that ranks this work at all:

> *"Plug in and see your gaps" is a credential-first promise, not a code-first one, and B5 (KMS)
> plus a PKI/identity integration are worth more to a first conversation than more source-language
> coverage.*

That sentence names S1's first item and §3.6's cheapest item, in that order. This section agrees
with it.

### 3.2 S1 — Cloud-account resource enumeration `first`

**Why first, ahead of DNS.** It is the only source that does both halves of this document's job at
once. One read-only key both enumerates the estate *and* returns, in the same API responses, exactly
the payloads six existing collectors already accept. `KmsKeyDescription` is a transcription of what
`aws kms describe-key` / `az keyvault key show` / `gcloud kms keys list` / `vault read
transit/keys/<name>` return — B5's collector header says so in as many words, and adds that a
credentialed poller *"is a strictly additive follow-up that produces the same `KmsKeyDescription`
values this file already maps."* So step 2 and step 3 of the critical path are the same lane for
this source, which is not true of any other.

Sub-ordering within it, by the rule in §3.1:

| Order | What is enumerated | Feeds | Credential kind |
|---|---|---|---|
| 1 | KMS keys, Key Vault keys, Vault transit keys | B5 `kms` — **live**, collector takes the shape unchanged | **`cloud_kms_readonly`, already exists** |
| 2 | Load balancers, listeners, certificate manager entries | B3 `tls` + B4 `certificate` — both live | `cloud_readonly_inventory` (new) |
| 3 | RDS/CloudSQL instances, S3/GCS/Blob buckets, backup vaults | B7 `data-at-rest` — live, and the true HNDL surface | `cloud_readonly_inventory` (new) |
| 4 | Compute instances, managed Kubernetes nodes | B12 `endpoint` — live but agent-less; a lead list is the fleet denominator | `cloud_readonly_inventory` (new) |
| 5 | Flow-log destinations, mesh telemetry sinks | B11 `network-flow` — live, submission-fed | `cloud_readonly_inventory` (new) |

Item 1 needs **zero new credential kinds and zero new collector code**. It is the cheapest
demonstration in the entire plan that the model works, and it should be the first thing built.

### 3.3 S2 — DNS and domain `second`

Read `DISCOVERY_METHOD_VALUES`' comment before designing anything here, because it forecloses the
obvious answer:

> *DNS is deliberately not a value here. Without a wordlist (guessing) or a zone transfer (a
> credential, and refused by every competently run nameserver), DNS cannot enumerate names — it can
> only answer questions about names you already have. Adding a `dns_enumeration` value here would be
> claiming a capability that does not exist.*

That is correct and this design does not overturn it. What is actually available, in order:

- **More certificate-transparency sources.** Censys, Google's CT API, or a second crt.sh mirror.
  Same method family, same evidence shape, more names, no credential. Cheap; also the only way to
  find out whether crt.sh's 500-name ceiling is currently hiding a large fraction of a real estate.
- **Authoritative zone data, credentialed.** Route 53 `ListResourceRecordSets`, Cloudflare's zone
  API, Azure DNS. This *is* enumeration, it is complete for the zones the credential can read, and
  it belongs under S1's umbrella rather than being called "DNS discovery" — the honest label is
  `dns_zone_export`, a credentialed method with a stated scope, not a DNS capability.
- **Wordlist brute-force. Recommended: refuse.** It generates traffic to a customer's nameservers,
  it produces names by guessing rather than by evidence, and every hit would enter the same table as
  a CT record while supporting a categorically weaker claim. If it ever ships it must be a distinct
  `discovery_method` with its own caveat and its own confidence, never merged into the others. This
  is a genuinely contestable call — see §7.

### 3.4 S3 — The estate already sitting in our own database `third, and nearly free`

Nothing enumerates, but three tables already hold endpoints nobody has examined:

- **`network_flows` where `crypto_state = 'undetermined'`.** B11 already counts these
  (`flowsWithUndeterminedCryptography`) precisely so the meter *"cannot render the surface as
  examined-and-clean"*. Every one of those rows names a destination host and port. They are leads,
  they were paid for, and today they are not treated as leads at all.
- **`observations.evidence` from B6's protocol-config collector** — connection strings, `Host`
  blocks, IdP issuer URLs in a submitted SAML metadata document.
- **`discovered_targets` whose `hostname` resolves but which no collector has probed** — already
  counted as `unexaminedTargets`, already surfaced, and today with no route that acts on the list
  other than one target id at a time.

The work is a derivation, not an integration: a `discovery_method` of `derived_from_evidence`, a
`discovery_runs` row recording which tables were read at which instant, and no egress at all. The
honesty rule that makes it safe is the one that governs the whole feature — a derived lead is still
a lead, and it may not touch `assets`.

### 3.5 S4 — Databases and key stores `fourth`

Mostly falls out of S1 (a database instance is a cloud resource). What does not is the **on-prem**
case: a Postgres or SQL Server nobody's cloud API knows about. The credential kind
`database_readonly` already exists in F4 for exactly this, and the reading is a small set of
catalogue queries (`SHOW ssl_ciphers`, `pg_stat_ssl`, TDE state, `sys.dm_database_encryption_keys`).
Note that this is **collection**, not discovery — a customer still had to tell us the host — and it
therefore does not close the enumeration gap for on-prem estates. Nothing in this plan does. Say so
rather than implying otherwise.

### 3.6 The three surfaces the catalogue added on 2026-08-15

- **`network-flow` — live, submission-fed.** Discovery for it means enumerating the *sources* of
  flow records (S1 item 5), not the conversations. The conversations are already the leads (§3.4).
- **`endpoint` — live, agent-less.** B12 shipped the report format an agent would report against
  and deliberately no agent: *"a binary running on a customer's domain controller is a packaging and
  security-review problem several times a collector's size, and it cannot authenticate until F4."*
  F4 has now shipped, so that blocker is gone — but note the **direction inversion**: an agent's
  enrolment credential is one *we* issue to a machine, not one a customer entrusts to us, and it
  therefore does **not** belong in the `credentials` table. Putting it there would put an
  outbound-trust secret and an inbound-trust secret in one bucket with one kind vocabulary.
  Discovery for this surface is fleet enumeration from Intune / Jamf / SCCM / Active Directory —
  a new credential kind, a real integration, and the fleet list is the denominator that makes
  "we examined 40 machines" mean something.
- **`identity` — `planned`, no collector at all, and the cheapest of the three.** An OIDC issuer's
  `/.well-known/openid-configuration` and its JWKS are **public**, need no credential, and state
  signing algorithms directly — and B6's `ProtocolConfigCollector` *already parses a JWKS, an OIDC
  discovery document and SAML metadata*. The collector exists; what does not exist is a fetcher and
  a route. This is the shortest path from `planned` to `live` anywhere in the catalogue, and it is
  worth doing early for a reason that has nothing to do with discovery: it moves the honest surface
  count from 10 of 13 to 11 of 13. The credentialed half — enumerating an IdP's registered
  applications and their per-app signing certificates — uses `idp_client_secret`, which F4 already
  defines.

### 3.7 What is deliberately not a discovery source

- **Port scanning.** Enumerating open ports on a customer's ranges is an active scan of machines
  whose ownership we have not verified, from our IP, on their behalf. D8's consent argument (§1.2.5)
  refuses it and the SSRF guard's whole existence assumes we do not do this.
- **Passive packet capture / a network tap.** B11's row calls real-time interception *"an explicit
  twelve-month non-goal"*. Unchanged.
- **Reading a customer's source control to find infrastructure-as-code.** Tempting (a Terraform
  state file is a near-perfect estate enumeration) and out of scope here: it is a source-code
  ingestion path with F4 retention consequences, and it belongs in a design about repository
  access, not this one.

---

## 4. The credentialed-collection refactor

### 4.1 Start from what does *not* change, because it is most of it

The pure collectors in `lib/collectors/` **already take the shape a credentialed pull produces**.
`KmsKeyDescription[]`, `DataAtRestStoreInput[]`, `EndpointHostReport[]`, `NetworkFlowRecordInput[]`
and `CtDiscoveryResult` are all provider-shaped structures, not upload-shaped ones. That is not an
accident — B5's header states the credentialed poller as the intended follow-up.

Therefore:

- **`lib/collectors/` gains no dependency and no I/O.** It stays the dependency-free package that
  can ship as a standalone on-prem agent. A cloud SDK inside it would end that, permanently.
- **`ingestObservations()` — the shared function — changes in exactly one place.** See §4.4.
- **No new `ingest*Observations` function is added per credentialed variant.**
  `ingestKmsObservations` is called with the same `KmsKeyDescription[]` whether they arrived by
  upload or by poll.

What is genuinely missing is a layer that does not exist yet: the thing that turns a credential into
a collector's input.

### 4.2 Do not extend `Collector`. Add a peer.

The brief for this document asked for "the collector interface that lets a collector *pull* rather
than *receive*". The honest answer is that **the `Collector` interface is not where that belongs**,
and the codebase has already voted on it twice.

`04-architecture.md` presents `Collector.collect(target, ctx)` as the seam. What it does not show —
and what decides this — are the two types either side of it:

```ts
/** What a collector is asked to scan. One variant exists today: `source`. */
export type CollectionTarget = { kind: "source"; repo: string;
                                 files: Array<{ path: string; content: string; language: string }> };
export interface CollectorContext { organizationId: number; }
```

A single-variant union of *submitted file bytes*, and an organisation id. **There is no host, no
endpoint, no credential and no connection affordance anywhere in the contract.** `collect()` is a
pure function of bytes somebody uploaded.

The consequence is already visible: **only the file-shaped collectors implement `Collector` at
all.** B1, B2, B4 and B6 do. B3, B5, B7, B8, B11 and B12 do not, and `endpoint-collector.ts` writes
down the reason:

> *There is no `Collector` class here, which follows B5, B7 and B8 rather than B1/B2/B4/B6: the
> `Collector` interface is built around `CollectionTarget`, the source/file shape, and a host report
> is not a set of files. **A class whose `collect()` yielded nothing would satisfy the interface and
> mislead every reader of it.***

So six of the ten live surfaces already sit outside the interface the architecture document presents
as the seam. Two options:

- **(a) Widen `CollectionTarget` into a real discriminated union** with a credentialed variant. This
  puts a `SecretHandle` — or worse, a provider client — inside `@workspace/collectors`, which is the
  package that *"deliberately has no dependency on `@workspace/db`… so they can also run as a
  standalone on-prem agent."* It also re-admits the six collectors that opted out, by making the
  interface mean something different for each of them.
- **(b) Leave `Collector` alone and add `Acquisition` as a peer interface, server-side.**
  Acquisition produces the input; the pure mapper consumes it. That is B3's existing three-file
  split (`tls-collector.ts` maps, `tls-probe.ts` connects, `tls-ssrf-guard.ts` guards) generalised,
  and B7 already states it copied that split deliberately.

**Recommend (b).** The cost is that `04-architecture.md`'s claim that `Collector` is *the* seam
becomes formally false rather than merely drifting, and it should be amended to say there are two
seams: a pure mapper contract in `@workspace/collectors`, and an acquisition contract in the API
server that may hold a credential and an SDK. Pretending there is one seam is what produced six
collectors quietly declining to implement it.

**One thing acquisition cannot express, and must not try to.** `DISCOVERY_MODALITY_VALUES` is a
*permanent* six-value enum by captain decision (2026-08-02, G-15). A submitted KMS export and a
credentialed KMS poll are both `configuration_information`, and there is no seventh value coming. So
the poll-versus-submission distinction lives in three other places and nowhere else: the run's
`collector`/`collectorVersion` (`"kms-inventory"` vs `"kms-poll-aws"`), the observation's
`confidence`, and the new `collection_runs.enumeration` record. Do not reach for the modality enum.

Confidence is the interesting one. `KMS_KEY_CONFIDENCE = 0.85` sits below B4's 0.9 for a reason that
is *stated as two doubts*: *"the export could be stale, and it could be partial."* A credentialed
poll removes both. So `classifyKmsKeys()` gains an options argument carrying the provenance and
raises confidence accordingly — a change inside `lib/collectors` that adds no dependency, which is
the shape every collector-side change in this plan should have.

### 4.3 The acquisition layer

Lives in `artifacts/api-server/src/lib/acquisition/`, one file per provider. Not in
`lib/collectors/` (SDKs, and it needs a `SecretHandle`), not in a route file (four routes would each
grow a provider client).

```ts
/** What one credentialed read of one provider produced, and the boundary of what it can speak for. */
export interface AcquisitionResult<TInput> {
  /** Exactly the shape the existing pure collector already takes. Nothing new. */
  input: TInput;
  /** Scopes fully enumerated: pagination exhausted, no error. The only thing that earns a prefix scope. */
  enumerated: EnumeratedScope[];
  /** Scopes attempted and not completed, with a reason from the closed vocabulary. */
  refused: RefusedScope[];
  /** A ceiling was hit. Reported, never silent — MAX_DISCOVERED_HOSTNAMES_PER_RUN's rule. */
  truncated: boolean;
}

export interface Acquisition<TInput> {
  readonly name: string;              // "kms-poll-aws" — becomes collection_runs.collector
  readonly version: string;
  readonly surface: Surface;
  readonly credentialKind: CredentialKind;   // asserted at redemption; a mismatch is refused
  acquire(secret: SecretHandle, scope: AcquisitionScope): Promise<AcquisitionResult<TInput>>;
}
```

`acquire` runs **outside any database transaction** — see §4.6.

### 4.4 The change to `asset-ingest.ts`, exactly

Three fields on `IngestSpec`, and one hardcoded literal that becomes a parameter. Nothing else.

**(a) `status: "completed"` on the `collection_runs` insert must become `spec.runStatus`.**

`ingestObservations()` hardcodes `status: "completed"` today. `coverage.ts` reads
`run.status === "failed"` and deliberately keeps such a run out of `completedRuns` — *"an attempt
that produced nothing is not coverage"* — but nothing in the product can currently write a `failed`
run, because the only function that writes `collection_runs` cannot express one.

This is the same defect, in the same file, as the one B2 hit:

> *the fingerprint call read `surface: "source"` as a literal, which is the single reason a fully
> built and tested `DependencyCollector` had nowhere to write for a whole release.*

A credentialed acquisition that enumerated two regions and was refused a third produces a run that
is neither `completed` nor absent. **This one-line change is the thing every credentialed lane
needs, and it is why it must land once, before them, rather than four times inside them.**

**(b) `enumeration?: EnumerationRecord` on `IngestSpec`, persisted to a new
`collection_runs.enumeration` `jsonb` column.**

Carries `enumerated`, `refused`, `truncated` and `credentialId` from the `AcquisitionResult`. This is
what lets a report say which regions a `kms` number covers. Nullable with no default: absent means a
submission, which genuinely made no enumeration claim — *not* an empty enumeration, which would read
as "we enumerated nothing successfully".

**(c) `reobserved` is unchanged in type, and its rules change. This is the dangerous part.**

### 4.5 The prefix-scope rule, which is the highest-consequence decision here

`ReobservationScope` is documented as *"the highest-consequence input to the whole module"*, and
`ingestKmsObservations` refuses a prefix scope with the reason:

> *A prefix scope would only be correct if this route knew the submission was a complete enumeration
> of that provider's keys. It cannot know that, and every realistic export is partial: one page of a
> paginated `list-keys`, one region, one Vault mount, one subscription. Marking every other key in
> the provider `gone` because it was absent from one page is the silent mass false remediation
> `ReobservationScope` at the top of this file exists to prevent. […] a caller that can **declare**
> its export complete for a provider could earn a prefix scope. Nothing declares that today.*

An `AcquisitionResult` is precisely that declaration. So:

> **A credentialed run earns a prefix reobservation scope for scope `S` if and only if `S` appears
> in `enumerated`, `truncated` is `false`, and no entry in `refused` overlaps `S`. Under any other
> condition it falls back to a `locations` scope over exactly what it read.**

The failure this prevents is the worst one available in this codebase: a throttled second page of
`list-keys`, silently treated as a complete enumeration, retires every key it did not see, and the
drift feed reports a mass remediation nobody performed. `assets` rows are updated in place and never
deleted, so it is recoverable — but the report generated the next morning is not.

Two corollaries the build lane must not get wrong:

- **Provider soft-deletion is not absence.** Azure Key Vault soft-delete and AWS
  `PendingDeletion`/`Disabled` keys are still returned by a complete enumeration, with a `keyState`
  the collector already models as optional. A key that vanishes from a complete enumeration is
  `gone`; a key returned as `PendingDeletion` is present and disabled, and conflating them puts a
  live key's retirement date a month early.
- **`enumerated` must be recorded at the granularity the prefix is taken at.** "Enumerated the AWS
  account" does not license retiring keys in `ap-south-1` if `ap-south-1` was never called.

### 4.6 How a customer credential travels, end to end

The rules are F4's, already written in `lib/db/src/credentials.ts` §1–§2. What follows is the
sequence for a credentialed collection specifically, plus the **one place the existing contract does
not fit and has to be extended**.

1. The client sends `{ credentialId, scope }`. It never sends a secret to a collector route.
2. Inside `withOrg`: `resolveCredentialRef(tx, body.credentialId, acquisition.credentialKind)`.
   Never construct a `CredentialRef` literal from a request body — *"a foreign key is not subject to
   RLS, and neither is an integer in a request body."* `null` → 404, which does not confirm the row
   exists, because *"which cloud accounts a company has connected is itself commercially
   sensitive."*
3. **Redeem, then do the outbound work outside the transaction.** This is the extension.
   `redeemCredential(tx, ref, use)` runs `use` *inside* the caller's `ScopedTx`, which is correct for
   a short call and wrong for an enumeration that takes minutes: `withOrg` holds a real database
   transaction for its whole callback, and both `routes/discovery.ts` and `schedule-runner.ts`
   already split their egress out of the scope for exactly this reason (*"probing is outbound
   `node:tls` to hosts this server does not control… doing it inside would pin a pooled connection
   idle for the duration"*). `executeSchedule` takes an `OrgScope` rather than a `ScopedTx`
   specifically so it can open its scope *after* the probe.

   Add a second entry point beside `redeemCredential`, with the same discipline:

   ```ts
   // lib/db/src/credentials.ts
   export async function withRedeemedCredential<T>(
     scope: Pick<OrgScope, "withOrg">,
     ctx: OrgContext,
     ref: CredentialRef,
     use: (secret: SecretHandle) => Promise<T>,
   ): Promise<T>;
   ```

   It opens a scope, performs every check `redeemCredential` performs, decrypts, records
   `last_redeemed_at`/`redemption_count`, **commits**, and only then runs `use`, disposing the handle
   in a `finally`. The caller must not already hold a scope — scopes do not nest, and a nested one
   *"silently re-scopes its parent once its savepoint is released"*, the single failure in the
   tenancy mechanism that returns another tenant's rows rather than none.

   Cost, stated: the redemption is recorded before the use, so a crash mid-acquisition leaves a
   recorded redemption and no collection. That is the right direction and it is already F4's stated
   behaviour — *"records the redemption on the row before running the callback, so a use that
   crashes still leaves a trace."*

4. Inside `use`: `secret.reveal()` is called **once**, as late as possible, and handed straight to
   the SDK client constructor. The client object is created inside `use` and never returned from it.
   Nothing else in the codebase ever holds a plaintext.
5. **What comes back out of `use` is `AcquisitionResult<TInput>` and it must contain nothing derived
   from the secret.** Account ids, ARNs, regions, key specs and rotation state are fine. A session
   token, a presigned URL, an `Authorization` header echo and — the sharp one — **an SDK error
   object** are not. Cloud SDK errors routinely embed the request that failed, headers included, and
   this codebase has already been bitten twice by an error message carrying its own input:
   `routes/credentials.ts` refuses to return `zod`'s `error.message` because *"zod serialises the
   rejected input into it, and the rejected input is a customer's secret"*, and `decryptSecret`
   refuses to chain the underlying crypto error because *"its message is the only place a crypto
   library might echo input back."* So: an acquisition may propagate `err.name` and a reason from the
   closed vocabulary in §2.3, and **never** the SDK error, into `refused[].reason`, into a log line,
   or into a response.
6. Nothing derived from the secret enters `observations.evidence` (an unconstrained `jsonb` blob
   several routes return verbatim), an asset `location`, or a `discovery_runs` row.
7. **The boundary test is extended, not trusted.** `secret-redaction.test.ts` already captures the
   real pino stream and sweeps every text-ish column of every table for the plaintext. Extend it to
   run a credentialed acquisition against a stub provider that *fails* — because *"error paths are
   where secrets leak; the happy path proves little"* — and to grep the response bodies as well as
   the log and the database.

### 4.7 Submission stays, and it is not a legacy path

Every credentialed capability is **additive**. `POST /projects/:id/kms` keeps accepting
`{ keys: [...] }` forever, because:

- an air-gapped or on-prem estate has no other path, and F5 (self-hosted) is a `planned` P1;
- a customer who will not issue us a credential at all is a normal customer, not an edge case, and
  §3 of the F4 contract is candid that our encryption *"does not protect against application
  compromise"* — some security teams will read that and decline, correctly;
- the submission collectors are the tested ones, and a credentialed path that regresses has a
  working fallback the same day.

**Use a separate route, not a union body.** `POST /projects/:id/kms/poll` beside
`POST /projects/:id/kms`, rather than one route with `{keys} | {credentialId}`. Three reasons, all
mechanical: the zod schema stays one-shaped; `cross-tenant.test.ts`'s manifest and
`openapi-drift.test.ts` each get a distinct entry to reason about rather than a route whose
behaviour depends on its body; and `ROUTE_ROLE_OVERRIDES` matches on method and path, so a
credentialed route cannot be given a different role floor than a submission route if they share one.

### 4.8 The RBAC question nobody has answered

`ROUTE_ROLE_OVERRIDES` gates `GET /credentials`, `POST /credentials` and the revoke route at
`admin`, because *"a member who submits scans has no reason to hold one"* and because which cloud
accounts a company has connected is sensitive on its own. But `resolveCredentialRef()` checks the
**organisation**, not the role. So a `member` who cannot list credentials can still *use* one by
guessing a small integer in a poll route's body.

**Recommendation: gate every `*/poll` route at `admin` in `ROUTE_ROLE_OVERRIDES` from the first
commit.** It is coarse and it is fail-closed, which is what that file's default is built for — *"a
new route that nobody thinks about is closed to viewers"*, and this makes the credentialed ones
closed to members too. The right long-term answer is a credential↔division grant so a division lead
can run their own account's enumeration, and that is RBAC work, not this design's.

### 4.9 There is no system principal, and that bounds every "continuous" idea here

Worth stating before anybody designs a discovery daemon, because the constraint is deliberate and
enforced rather than incidental.

Every organisation-scoped read requires an `OrgContext`, and there is no ambient way to get one.
`withoutOrgScope` is not the escape: its `UNSCOPED_BY_DESIGN` list is three entries long (public
community content, the session store, sign-in identity resolution), anything undeclared is logged at
`warn` with a stack, and *"adding to this list is a deliberate act: it downgrades an audit warning to
routine."* `withUserScope(...).enterOrganization()` is not the escape either — its own comment names
exactly two legitimate callers, the second being *"nothing else."*

The schedule runner already hit this and declined to route around it:

> *Not a cross-organisation daemon. Finding due work across every tenant means reading
> `collection_schedules` — an organisation-scoped table — outside any organisation scope, which
> `org-scope.ts` calls out as never legitimate for exactly this class of table. So the entry point is
> `POST /api/collection-schedules/run-due`, org-scoped, executing the caller's own due schedules; an
> external scheduler calls it per organisation with that organisation's credential.*

So: **any scheduled discovery, any agent check-in, and any "continuous" enumeration is a
per-organisation invocation carrying that organisation's credential, or it does not exist.** Design
for that shape from the start. A build lane that discovers this halfway through will be tempted to
add a fourth `UNSCOPED_BY_DESIGN` entry, and that entry is how tenant isolation stops being real.

Note also that `run-due` *"has no deployed trigger yet; something outside the process has to call
it."* Continuity is step 5 of the critical path and is not solved by this document; it is worth
knowing that its existing half is also not running anywhere.

---

## 5. Honesty under discovery

The gap analysis' closing warning is the part of this document most likely to be skipped and most
expensive to skip:

> As discovery arrives, the honest reading gets **harder** to produce, not easier. *"We scanned your
> estate"* invites a completeness claim no scanner can support.

### 5.1 The coverage number will get worse, and that is the feature working

Discovery raises the numerator a little and the denominator a lot. A project that today reads
"12 assets on the `tls` surface" will, after an S1 enumeration, read "12 of 400 discovered endpoints
examined". **The second number is not a regression and must not be fixed.**

There is a precedent to point at when somebody files it as one. On 2026-08-15 the surface catalogue
went from ten entries to thirteen, and `SURFACE_VALUES` records why in the same breath:

> *A denominator that omits a surface is worse than one that reports it never-examined, because the
> first silently shrinks the estate and the second states a gap. Adding them moves the honest reading
> from "8 of 10" to "8 of 13", which is a less flattering number and a truer one.*

Discovery does that again, one level down, and much more violently.

### 5.2 What the coverage meter must gain

`SurfaceCoverage` today reports `state`, `completedRuns`, `failedRuns`, `lastExaminedAt`, `assets`,
`activeAssets`. It has no idea how much it did not look at. Add, per surface:

```ts
/**
 * The discovered denominator for THIS surface, or null when discovery has never produced one.
 * Null, never 0 — 0 asserts "we enumerated and there is nothing", which is a measurement.
 */
knownTargets: number | null;
examinedTargets: number | null;
/**
 * The boundary of the most recent enumeration for this surface. Null when nothing enumerated.
 * `complete: false` with a populated `refused` list is the normal state of a real cloud account.
 */
enumeration: { complete: boolean; enumerated: EnumeratedScope[]; refused: RefusedScope[];
               truncated: boolean; at: string } | null;
```

Two design calls inside that:

- **`null`, not `0`.** This is `readiness.ts`'s rule, already load-bearing: a section with no data
  source renders `percentComplete: null` and `state: "not-tracked"` — *"never 0, which would assert
  a measurement nobody took."* It is also `dnsResolution`'s four-state rule and
  `assets.key_size`'s "not supplied" rule. Three precedents; do not invent a fourth convention.
- **Keep `SurfaceCoverageState` at three values and put partiality in its own block, rather than
  adding a fourth state.** A fourth state is what a UI collapses into a colour, and the colour loses
  the reason. `enumeration` carries the reason. The counter-argument — that a UI which has to read a
  nested object will not — is real, and §7 records it as unresolved.
- **`examinedSurfaces / totalSurfaces` still must not become a percentage.** That is already in
  `coverage.ts`'s header (*"How much crypto is hiding in the nine surfaces nobody has looked at is
  unknowable from our data"*). Discovery does not change it; it makes the temptation worse, because
  now there *is* a denominator and it is tempting to divide by it.

`DiscoveryCoverage.basis` is already exactly the right pattern and should be copied rather than
replaced — *"the honest reading is 'of the names we know of, this many have been examined', never
'this fraction of the estate'."*

### 5.3 What a partially-enumerated cloud account must say

Generated from the `discovery_runs` row, never authored, and travelling in the payload the way
`DISCOVERY_EVIDENCE_CAVEAT` and `READINESS_FACTSHEET_FRAMING` already do:

> On 2026-09-02 we enumerated key management in 3 of the 5 regions this credential can name:
> `eu-west-1`, `eu-west-2`, `us-east-1` — complete, pagination exhausted. `ap-south-1` refused the
> call (access denied) and `sa-east-1` was throttled. **Nothing below describes those two regions,
> and we cannot say how many keys are in them.** Regions outside this credential's account are
> outside this reading entirely.

Not: "97% of your key estate is covered." There is no denominator for that sentence, because the
size of what we were refused is exactly the thing we do not know.

The same paragraph, in its degenerate case, is what a report must say when discovery has never run:
*"nothing has enumerated this surface, so the count below is of what was submitted to us and we
cannot say what fraction of the estate that is."* That sentence is true of eight surfaces **today**
and is currently written down nowhere.

### 5.4 The vocabulary rule

No customer-facing string — report, meter caption, marketing page, API `basis` field — may use
**"complete"**, **"full"**, **"all"**, **"comprehensive"**, or **"your estate"** unless an
enumeration boundary appears immediately adjacent to it. And the word **"scan"** should not be used
for an enumeration at all: we read a control plane, and the word invites the reader to picture
something exhaustive.

Two existing statements to reconcile while doing this:

- `07-reports.md`'s board pack and the E1/E2 lanes now in flight generate prose about coverage. Any
  such generator must take the enumeration record as an input, not a total.
- The public marketing coverage page (`lib/collector-surfaces.tsx`) already had to be corrected once
  when it listed eight surfaces against the roadmap's ten (3ee0581). It will need correcting again;
  the fix is to join it to `COLLECTOR_SURFACES` rather than to re-enter the number.

---

## 6. Sequencing

Doc 16's rule, applied: **file-disjointness first, priority second.**

### 6.1 Stage 0 — the preparatory commit nobody owns `serialised, must land alone`

This is the whole reason this document exists. Every item below is a change to a file that three or
four later lanes would otherwise each edit. CLAUDE.md already prescribes this shape for migrations —
*"land the schema change ahead of the lanes, in one migration nobody owns"* — and the same argument
applies verbatim to `asset-ingest.ts`, which is a sequence of same-shaped blocks that git presents
as alternatives and that **must never be resolved by concatenating both sides**.

1. **The migration** (one index, and the snapshot's `prevId` relinked to the previous snapshot's
   `id` — wave 3 forked the chain five ways by skipping that): `discovery_runs`;
   `discovered_targets` gaining `identity`/`target_kind`/`source_scope`/`last_discovered_run_id` and
   `hostname` becoming nullable; `collection_runs.enumeration`.
2. **`ORG_SCOPED_TABLES` + policy + grant** for `discovery_runs`, in `tenant-isolation.sql`, applied
   by `apply-rls` — **not** by `drizzle-kit push`, which writes a NULL `USING` clause and installs
   no isolation while `pg_policies` reports the policy as present.
3. **`asset-ingest.ts`**: `runStatus` and `enumeration` on `IngestSpec`; the hardcoded
   `status: "completed"` becomes `spec.runStatus ?? "completed"`. **No lane touches
   `ingestObservations()` after this.**
4. **`lib/db/src/credentials.ts`**: `withRedeemedCredential`, and two new `CREDENTIAL_KIND_VALUES`
   entries (`cloud_readonly_inventory`, and the fleet-directory kind if the endpoint lane is in
   scope). Widening that tuple is deliberate by design; doing it once is the point.
5. **`lib/collectors/src/enums.ts`**: `DISCOVERY_TARGET_KIND_VALUES`, the widened
   `DISCOVERY_METHOD_VALUES`, and the per-method caveat table (§1.3).
6. **`ROUTE_ROLE_OVERRIDES`**: the `*/poll` admin gate, added before any poll route exists — the
   same reasoning that put RBAC's own management routes in that list before they shipped, *"so the
   routes cannot ship ungated later — a gate added after the route is a window that was open in
   between."*
7. **The acquisition interface** (`acquisition/types.ts`) with no provider implementation.

Stage 0 ships with unit tests and no user-visible feature. That is fine and it is cheaper than the
merge it prevents.

### 6.2 What can run in parallel after stage 0

| Lane | Work | Touches `asset-ingest.ts`? | Touches `routes/projects.ts`? | Migration |
|---|---|---|---|---|
| **P1** | AWS/Azure/GCP/Vault KMS acquisition + `POST /projects/:id/kms/poll` | **no** — calls existing `ingestKmsObservations` with new params | **no** — new file `routes/collectors/kms-poll.ts` | none |
| **P2** | Cloud resource enumeration → `discovery_runs` + leads; `POST /projects/:id/discovery/cloud` | **no** — discovery writes no assets, by construction | no — extends `routes/discovery.ts` | none |
| **P3** | `identity` surface: JWKS/OIDC/SAML fetcher + ingest; catalogue flips to `live` | **yes** — adds one new `ingest*` block at the end | no — new route file | none |
| **P4** | Honesty: `coverage.ts`, `discovery-coverage.ts`, `CoverageMeter.tsx`, report prose | no | no | none |

P1 and P2 are genuinely file-disjoint and can run at the same time. P3 is the only lane that appends
to `asset-ingest.ts`, so it may run concurrently with all three provided **no second lane also
appends** — two lanes each adding a block there is the recorded wave-3 failure, where keeping both
halves *"eats whatever line the two sides share at the boundary"*.

P4 collides with P2 on `discovery-coverage.ts` and must follow it, not run beside it.

### 6.3 The conflict map, for whoever merges this

- **`asset-ingest.ts`** — stage 0 owns `ingestObservations()`. P3 appends one block. Nobody else.
  Resolve any conflict here by taking one side whole and splicing the other's block in as a unit,
  never by keeping both halves of a hunk.
- **`routes/projects.ts`** — **no lane may touch it.** Every new route goes in its own file under
  `routes/`, registered in `routes/index.ts` (a short, genuinely mergeable file). This single
  decision removes the second-worst conflict magnet from the plan, and it costs nothing: the file is
  already 2,201 lines and nineteen handlers, which is past the point where adding a twentieth is
  the tidy option.
- **`openapi.yaml`** — merged **by key, never by hunk**. Each lane slices out its whole path and
  schema keys and appends them; then re-run `pnpm --filter @workspace/api-spec run codegen`. The
  generated clients under `lib/api-client-react` and `lib/api-zod` are never hand-merged. Remember
  that new **fields** on an existing response count: `openapi-drift.test.ts` catches the path half
  of that drift and cannot catch the field half.
- **`surface-catalogue.ts`** — only P3 changes a status. If a second lane ever flips one in the same
  wave, both are `live` and the live-collector count test is what catches a miscount; taking either
  side whole silently demotes the other lane's surface while its own test stays green.
- **`cross-tenant.test.ts`** — a sequence of same-shaped route entries, same hazard as
  `asset-ingest.ts`. One line per new route, spliced, not concatenated.
- **`drizzle/meta/_journal.json` and `NNNN_snapshot.json`** — one migration, in stage 0, and relink
  the snapshot's `prevId`. Reserving an index is necessary and not sufficient.

### 6.4 Where this lands in the feature table

Doc 16's rule 3 — *"Add or correct your row in [03-features.md](03-features.md). Three consecutive
waves missed this, which is why that table could not be trusted as a status source"* — applies to
every lane above, and needs an id decision made once rather than four times.

The letter runs have no gaps, so the next free ids are **A7 / B13 / C10 / D9 / E7 / F9**. Precedent
in the table itself:

- **Discovery did not get a new letter.** D8 landed in §D, the CISO surface, not §B. A second
  discovery source is therefore **D9**, not a B-number — leads are not a collector.
- **Credentialed collection has no id at all**, anywhere. B5 and B7 describe it as *"strictly
  additive"* to their own rows, which argues for amending B5/B7/B12 in place rather than minting
  ids. That is the cheaper answer and it is also the one that forces those three stale
  *"F4 is unbuilt"* sentences (§0) to be rewritten by whoever touches the row.

**And rename `EP` to `B12` while doing it.** The endpoint lane wrote itself up as `EP` throughout its
source — `surface-catalogue.ts` still says *"live since **EP**'s ingest path landed"* — while
03-features calls the same work **B12**. D8 hit this exact defect and the fix was recorded as a
rule: *"the lane wrote itself up as 'D7' throughout its source, which is the trend view's id.
Renamed to D8 on merge — two features sharing an id is how a status table stops being readable."*
The rule was made and then not applied to the next lane.

---

## 7. Open questions

Each of these could not be resolved from the repository. What would settle it is named, because a
question with no test is a question that gets answered by whoever writes the code first.

1. **Is `withRedeemedCredential` (running the vendor call outside the transaction) a legitimate
   second variant of F4's contract, or a hole in it?** The contract says a collector must "never
   open a scope" and must take the caller's `ScopedTx`; it does not contemplate a use that outlives
   a transaction. *Settled by:* how long a real AWS/Azure enumeration takes against the deployed
   `pg` pool size, and whether any deployment sits behind a transaction-mode connection pooler
   (nothing in `Dockerfile.api` or `docker-compose.yml` says). If enumerations are seconds rather
   than minutes, `redeemCredential` as written may be sufficient and this whole extension is
   unnecessary.

2. **Should a lead be project-scoped or organisation-scoped?** §2.5 recommends project-scoped on an
   RBAC argument. *Settled by:* whether a real customer maps one cloud account to more than one
   project. `projects` is a thin concept in this codebase (`name`, `language`, `code`) and there is
   no customer data to look at — this needs a design partner, not a query.

3. **Wordlist subdomain enumeration: refuse permanently, or ship as an explicitly-labelled
   method?** §3.3 recommends refusing. *Settled by:* whether NIST SP 1800-38B's eight-use-case
   functional test plan includes active name enumeration. That document is a preliminary draft and
   is not in this repository; `docs/Claude/mappings/README.md` records what has been read of it.

4. **Should a re-run enumeration retire leads that have disappeared?** D8 says no, firmly: *"CT is
   append-only: a name disappearing from a query result says something about the query, not about
   the estate."* For an **authoritative** enumeration the opposite is arguably true — an S3 bucket
   absent from a complete `ListBuckets` really is gone. But `discovered_targets` has no lifecycle at
   all (no `status`, no `gone`), so implementing it means importing the `assets` lifecycle into a
   table that deliberately does not have one. *Settled by:* deciding whether a stale lead does any
   harm. It inflates `unexaminedTargets`, which is a number the product is otherwise trying to make
   honest — so probably yes, and probably by ageing `lastDiscoveredAt` rather than by adding a
   status.

5. **Should discovery and credentialed acquisition be schedulable, and does that widen
   `SCHEDULE_TARGET_KIND_VALUES`?** That tuple is `["tls"]` and its comment explains that submission
   surfaces are unschedulable because *"re-running one of those against the stored submission would
   re-derive the identical result and report it as a fresh observation… make a stale estate read as
   continuously verified."* A credentialed acquisition is genuinely re-executable without new input,
   so it is exactly the second entry that vocabulary anticipates — and the comment says widening it
   "is a deliberate act". *Settled by:* whether question 1's answer permits a scheduled run to hold
   a credential at all, and by whether `POST /collection-schedules/run-due` (org-scoped, called by
   an external scheduler per organisation) is an acceptable trigger for something that costs money
   in provider API calls.

6. **Does a credentialed enumeration need a spend/rate budget, and where does it live?**
   `MAX_DISCOVERED_HOSTNAMES_PER_RUN` and `MAX_SCHEDULES_PER_RUN` are the existing precedents, but
   both bound *our* work; a cloud enumeration bounds *the customer's bill* and their API rate limits.
   *Settled by:* a real account. Until then, err toward a low ceiling with `truncated: true`, which
   is at least honest.

7. **Where does an endpoint agent's enrolment credential live?** §3.6 argues it is not the same kind
   of thing as a customer's cloud key and does not belong in `credentials`. Nothing in the repository
   addresses inbound machine identity. *Settled by:* the agent design, which does not exist.

8. **Does the coverage meter need a fourth `SurfaceCoverageState`?** §5.2 argues no. The
   counter-argument is that a UI which must read a nested `enumeration` object to know that a
   surface is partially enumerated is a UI that will render it as "examined". *Settled by:* building
   the panel and looking at it.

---

## 8. Noticed while writing this, not fixed

Lane E was scoped to one document and modified nothing else. Recorded here rather than left to be
rediscovered. Ordered by how badly each would mislead somebody starting this work.

### The ones that would mislead a build lane

- **Three feature rows still name F4 as the blocker for credentialed collection, and F4 shipped.**
  B5, B7 and B12 — quoted in §0. Somebody reading 03-features to decide what is buildable will
  conclude that none of this is. This is G-22's failure mode, on the exact sentences this design
  depends on.

- **G-15's remaining half cites two collectors that have shipped.**
  `09-open-gaps.md` says no collector populates the `network` `locationDetail` profile because
  *"B3 (TLS prober) and B4 (certificate) are the collectors that would put real CPE/hostname/port
  data into it, and neither is built. This gap stays open until one of them lands."* Both landed
  2026-08-14. `04-architecture.md` carries the same stale pair. Either the half is closable or the
  reason it is not has changed and is unrecorded.

- **G-12's body predates F1 and F4** and still reads *"the shared API key remains the only
  credential"* with S1 (per-user identity) open. Sessions, `/auth/*`, GitHub OIDC and RBAC with
  divisions shipped 2026-08-15; the credential store shipped before that. The header still says
  "MITIGATED IN CODE, PENDING DEPLOY". Its stated consequence — *"blocks the first pilot with real
  customer data"* — may or may not still hold, and nobody can tell from the register.

- **`13-auth-and-tenancy.md` §5.2's `GRANT` list is nine tables short of reality.** It names
  fourteen tables; `ORG_SCOPED_TABLES` now has nineteen, and `ot_fleets`, `vendor_assessments`,
  `credentials`, `discovered_targets`, `network_flows`, `collection_schedules`,
  `collection_schedule_runs`, `divisions` and `division_grants` are all absent from it. Following
  §5.2 verbatim while adding `discovery_runs` ships an ungranted table — fail-closed, so nothing
  leaks, but silent until a route 500s. The authoritative list is
  `lib/db/sql/tenant-isolation.sql`; §5.2 should say so rather than carrying a copy.

### The counting ones

- **`03-features.md` §D3's own honesty paragraph is internally inconsistent three ways**, in three
  consecutive sentences: *"which of the **thirteen** collector surfaces"*, then *"The **ten**
  surfaces come from one catalogue"*, then *"the **nine** unexamined surfaces"*. The truth is 13
  catalogued, 10 live, 3 unexamined. The paragraph explaining why the denominator matters is the one
  that gets it wrong.

- **`03-features.md:700` says "six of the eight live surfaces are submission-based."** Ten are live.
  This document's §0 table restates the axis honestly; the source sentence should be corrected too,
  because it is the single best statement of *why* F4 mattered and it now understates the count.

- **`coverage.ts` and `CoverageMeter.tsx` both still say "nine".**
  `artifacts/api-server/src/lib/coverage.ts` (module header, rule 4) reads *"How much crypto is
  hiding in the nine surfaces nobody has looked at"*, and
  `artifacts/quantaxscan/src/components/CoverageMeter.tsx` (module header) reads *"the nine
  unexamined surfaces"* and gives `1 / 10` as its worked example. The catalogue has been thirteen
  entries with ten live since 2026-08-15; the arithmetic in both files is derived from
  `COLLECTOR_SURFACES` and is correct, but the prose that explains it is stale in exactly the
  direction that understates the estate.

- **`03-features.md`'s B2 row says the D3 meter "reads 2 of 10"**, and B5's says `kms` is the fifth
  live surface, B7's the seventh, B11's the ninth, B12's the tenth. The denominator moved to
  thirteen on 2026-08-15 and the B2 row was not revisited. The ordinals are still right; the
  denominator in that one sentence is not.

- **`01-strategy.md` still calls source-code scanning *"our only live collector"*** (copied verbatim
  into `09-open-gaps.md`'s G-17 body), and its twelve-month target is *"the inventory covers ≥5
  surfaces"* — already exceeded twofold. `02-roadmap.md` says the catalogue goes *"from two live
  surfaces to eight."*

### The small ones

- **`EP` and `B12` are the same feature under two ids** — see §6.4. D8's merge note already
  established the rule that this violates.

- **`03-features.md`'s declared status vocabulary omits `partial`**, which four rows (D3, D7, F2,
  F7) use. The header lists `built · next · planned · deferred · won't`.

- **`04-architecture.md`'s as-built fingerprint list is behind**: it names seven surfaces and says
  *"`ot` has no fingerprint rule yet, and does not need one — B8's register is a form whose rows are
  fleets, not fingerprinted assets."* `fingerprint.ts` now implements `ot` (plus `data-at-rest`,
  `network-flow` and `endpoint`), and `ingestOtObservations` does mint `ot` assets. The stated reason
  it never would is now false. The same document's API table lists routes as unbuilt that exist, and
  omits seven route files entirely.

- **`require-role.ts:135` is a no-op ternary.**
  `const held = principal.kind === "apiKey" ? principal.role : principal.role;` — both branches are
  identical. Harmless today (the union's two members both carry `role`) and it reads as if a
  distinction were intended that is not implemented.

- **`docs/Claude/README.md`'s index omits 08 and 16.** `08-security.md` and `16-wave-4-lanes.md`
  both exist and neither appears in the index tables. This file has been added to the index; the
  other two were left alone as out of scope.

### The substantive one

- **`discovery_runs` is missing.** A discovery run leaves no persistent record of any kind. That is
  survivable for CT and is the thing §2.3 exists to fix before any credentialed source lands,
  because with a credentialed source the run's boundary *is* the report's honesty.

None of the above has a gap-register entry. The next free number is **G-24**, and the sweep G-22
asked for — *"run the same stale-refusal check over every 'not available' string in the product"* —
would be a reasonable thing to register as one entry rather than eight.
