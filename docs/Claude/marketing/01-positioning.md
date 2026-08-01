# 01 — Positioning

## One-liner

> **Q-Vuln is the cryptographic inventory of record for post-quantum readiness.**

## Elevator version

> Regulators have set dates for retiring RSA and elliptic-curve cryptography. Most enterprises
> cannot answer the first question those deadlines raise: *where is all our crypto?* Q-Vuln
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

**The incumbent is a spreadsheet.** Position and price against that, not against tools.

| They might use | Their limitation | Our line |
|---|---|---|
| Consultancy audit | Point-in-time, six figures, stale on delivery | "An inventory is a living thing. A PDF from March is already wrong." |
| SAST + PQC rules | Source code only | "Most of your crypto is in dependencies and TLS. Source is one surface of ten." |
| Certificate manager | Certificates only, no data-lifetime context | "Certificates matter — they are one input. Exposure needs the whole picture." |
| Spreadsheet | Manual, stale, unauditable | "How old is it, and who signed off on it?" |
| Nothing yet | — | "The first question you will be asked is what you have. Start there." |

Never name a competitor in public content.

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
