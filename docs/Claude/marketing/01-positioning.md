# 01 — Positioning

## One-liner

> **QuantaXscan is the cryptographic inventory of record for post-quantum readiness.**

## Elevator version

> Regulators have set dates for retiring RSA and elliptic-curve cryptography. Most enterprises
> cannot answer the first question those deadlines raise: *where is all our crypto?* QuantaXscan
> builds that inventory automatically across source code, dependencies, TLS, certificates and
> key stores — then tells you which assets will still be exposed when the deadlines land.

## The 30-second version for a CISO

> You are going to be asked for your post-quantum migration plan — by a regulator, an auditor,
> or your board. Step one of every published roadmap is the same: build a cryptographic
> inventory. Almost nobody has one, because it currently means a consultant and a spreadsheet
> that is stale before it is delivered.
>
> We automate the inventory, keep it current, and score each asset on whether it will still be
> exposed when the deadlines hit — using your data's own retention requirements, not a generic
> severity rating. You get an artifact you can hand to an auditor with citations on every claim.

---

## Ideal customer profile

| Attribute | Fit |
|---|---|
| **Sector** | Financial services, healthcare, insurance, government/defence, critical infrastructure, telecoms |
| **Driver** | Long data-retention obligations — the harvest-now-decrypt-later exposure is real for them |
| **Size** | Large enough to have a CISO and an unknown estate; small enough that a Big 4 engagement is painful |
| **Trigger** | A regulator, board, auditor, parent company or major customer has asked the question |
| **Buyer** | CISO, or the security architect who briefs them |
| **Champion** | Whoever has been handed "figure out our quantum plan" as a side project |

### Anti-ICP — do not chase

Startups, companies with no regulatory pressure, anyone whose data has a short secrecy lifetime,
and organisations wanting a one-off audit report rather than an ongoing inventory. The product
is worth little to them and they will churn.

---

## Message hierarchy

Lead with **1**. Reach for the others when the conversation earns them.

### 1. You cannot plan a migration you cannot see

The primary message. Every published PQC roadmap begins with inventory. Inventory is the
unglamorous, unsolved, prerequisite step. We do that step.

*Why it works:* it is obviously true, it is what the guidance actually says, and it reframes
"quantum" from a distant physics story into a present-day asset-management problem the buyer
already knows how to think about.

### 2. Severity without data lifetime is meaningless

An RSA key on a marketing site and one protecting 30-year medical records are not the same risk,
and every tool that scores them identically is giving you a number you cannot act on. We compute
exposure from *your* retention requirements against *published* deadlines.

*Why it works:* it is a specific, technical, defensible critique that a sophisticated buyer will
recognise as correct — and it introduces Mosca without jargon.

### 3. Your scanner cannot see most of your crypto

Source-code scanning misses dependencies, TLS termination, certificates and key stores — which is
where the majority of enterprise cryptography actually lives.

*Why it works:* it pre-empts "we already have a SAST tool with a PQC rule pack." Use it when
that objection is coming.

### 4. The deadlines are already dated

This is a compliance programme with published dates, not a speculative risk. **Only ever state
specific dates that have been verified against the primary source at time of writing.**

### 5. We show you what we haven't looked at

Our coverage meter reports blind spots as prominently as findings. Nobody else does this,
because it looks bad — but it is what makes the report survive an audit.

*Why it works:* it is a genuinely unusual claim, it signals confidence, and it is the thing an
auditor-facing buyer values most.

---

## Proof points

**Available now** — real, usable today:

- Working scanner detecting 7 quantum-vulnerable and classically-weak algorithm families
- Maps findings to NIST PQC replacements with named parameter sets
- CycloneDX CBOM export *(once E3 ships — do not claim before then)*
- Open architecture: versioned, citable standards data rather than hardcoded rules
- **We publish our own security findings** — see [../08-security.md](../08-security.md)

**Do not claim yet** — none of these are true today:

- ❌ Any customer count, logo, testimonial, or case study
- ❌ Coverage of surfaces where the collector is not built
- ❌ Compliance certifications we do not hold
- ❌ Accuracy or benchmark numbers we have not measured

---

## Competitive framing

> ⚠️ **Corrected 2026-08-01.** An earlier version of this document said *"the incumbent is a
> spreadsheet"* and listed only consultancies, SAST vendors and certificate managers. That
> understated the field badly.

**There is a NIST-convened consortium of vendors building cryptographic discovery tools.**
NIST SP 1800-38B §5.1 names the technology collaborators who contributed discovery tools to the
NCCoE lab:

> Cisco · IBM · Infosec Global · ISARA · Keyfactor · Microsoft · SafeLogic · Samsung SDS ·
> SandboxAQ · wolfSSL

Several are large, several are PQC-native, and all of them have NIST-convened credibility we do
not have. Any buyer who has read SP 1800-38 knows this list. Claiming the category is empty
would destroy credibility in the first meeting.

**What is still true:** for the *median* enterprise, the current state of practice really is a
spreadsheet or nothing. The market is early and largely unserved. But "we are the only ones
doing this" is false, and we should never say it.

| They might use | Their limitation | Our line |
|---|---|---|
| A discovery tool from the NCCoE consortium | Mature discovery; generally weaker on risk arithmetic and evidence-grade reporting | "Discovery is necessary and not sufficient. What ranks the results against *your* data retention?" |
| An agentless CPM platform (Fortanix, SafeLogic, Keyfactor, consultancy tooling) | Broad credential-based reach; a crypto inventory rather than a *deadline* posture | "You can see the keys. Which of them outlive your data's secrecy lifetime, and against whose published date?" |
| PQCA CBOMkit (open source) | Free and CBOM-native; no risk arithmetic, no compliance mapping, no hosted product | "We emit the same CycloneDX 1.7 they do — deliberately. The question is what you do with it afterwards." |
| Consultancy audit | Point-in-time, six figures, stale on delivery | "An inventory is a living thing. A PDF from March is already wrong." |
| SAST + PQC rules | Source code only | "Most of your crypto is in dependencies and TLS. Source is one surface of ten." |
| Certificate manager | Certificates only, no data-lifetime context | "Certificates matter — they are one input. Exposure needs the whole picture." |
| Spreadsheet | Manual, stale, unauditable | "How old is it, and who signed off on it?" |
| Nothing yet | — | "The first question you will be asked is what you have. Start there." |

### The market is agentless-first, and that is a finding about us

> **Added 2026-08-14** from independent competitive research.

The vendors above reach cryptography predominantly through **read-only credentials** — cloud
KMS, HSMs over PKCS#11, key managers over KMIP, the CA database, Active Directory, database TDE
metadata. Almost none lead with source code.

That ordering has a consequence we should say out loud internally: **source-code scanning is the
slowest surface to onboard and among the narrowest in coverage.** It requires repository access,
which triggers the deepest security review of any integration — the one gate a pre-pilot product
cannot clear quickly. Our single live collector is therefore also our hardest sell.

Nothing in the marketing copy needs to change because of this; the /coverage page already says
1 of 10 honestly. What changes is which collector we build next if the goal is "plug in and
report their gaps in a week."

### The differentiators that survive this list

Coverage breadth alone will not distinguish us — several of those vendors have more of it today.
What holds up:

1. **Mosca risk arithmetic tied to data retention** — most discovery tools inventory; fewer
   rank by the customer's own secrecy lifetime against published deadlines
2. **Crypto-agility scoring** — how hard is this to change, not just how much of it is there
3. **Honest coverage reporting** — blind spots shown as prominently as findings
4. **Evidence-grade provenance** — citations, retrieval dates, pinned mapping versions,
   reproducible reports

All four are about *what happens after discovery*. That is the defensible position.

### Treat Appendix C as our test suite

SP 1800-38B Appendix C defines an eight-use-case functional demonstration plan for discovery
platforms. A technical buyer may evaluate us against it. Build to it deliberately.

Never name a competitor in public content — including anyone on the list above.

---

## Objection handling

| Objection | Response |
|---|---|
| *"Quantum is 15 years away."* | Possibly. The compliance deadlines are not, and neither is harvest-now-decrypt-later. If your data must stay secret for 20 years, the maths already fails. |
| *"We already scan our code."* | Good — that is one surface. What is terminating your TLS, and what is inside your dependencies? |
| *"We can't send you our source code."* | Reasonable. Collectors are designed to run inside your network and send findings only. *(Honest caveat: self-hosted is Phase 4 today — do not promise a delivery date.)* |
| *"We'll wait for our vendors to handle it."* | Several will not, and you will need to know which. That is CISA roadmap stage 4 and it needs an inventory first. |
| *"How is this different from a SAST tool?"* | They tell a developer to fix a line. We tell a CISO what to put in front of a regulator. |
| *"Isn't this just a compliance checkbox?"* | The inventory is a compliance artifact. The reason to want it is that you cannot budget or sequence a multi-year migration blind. |
