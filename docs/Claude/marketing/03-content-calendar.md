# 03 — Content calendar

## Content pillars

Every piece belongs to exactly one pillar. If it fits none, it is off-strategy — propose a new
pillar rather than stretching an existing one.

| # | Pillar | What it covers | Share |
|---|---|---|---|
| **P1** | **Inventory is step one** | Why discovery gates everything; coverage and blind spots | 30% |
| **P2** | **Standards, explained accurately** | What NIST/CISA/NSA guidance actually says, with citations | 25% |
| **P3** | **Building in public** | Our architecture and engineering decisions | 25% |
| **P4** | **Risk arithmetic** | Data lifetime, Mosca, why severity alone is useless | 15% |
| **P5** | **Company** | Milestones, hiring, releases | 5% |

**P3 is the most under-rated.** Technical readers trust engineering detail far more than product
claims, it is free to produce because the work is happening anyway, and nobody else in this
space is doing it. It is also how we recruit.

---

## Cadence

Sustainable beats ambitious. A missed schedule reads worse than a slower one.

| Channel | Frequency | Notes |
|---|---|---|
| LinkedIn | 2× / week — Tue, Thu | Primary channel: the buyer is there |
| X / Twitter | 3–4× / week + 1 thread | Practitioner audience, faster loop |
| Blog | 2× / month | Depth. Everything else can be derived from these |
| Website | As triggered | See [07](07-website.md) |
| Newsletter | Monthly | **Not before there is a list worth mailing** |

### The derivation rule

**Write the blog post first, then derive everything else from it.** One well-researched piece
becomes a LinkedIn post, an X thread, a website copy update, and a newsletter section. Writing
per-channel from scratch produces thin content and burns the agent's research time.

---

## 90-day plan

Assumes a start with no audience and no customers. Goal for the quarter is **credibility with a
technical audience**, not leads. Optimise for "a security engineer forwards this to their CISO."

### Month 1 — Establish competence

| Wk | Blog (P) | LinkedIn | X |
|---|---|---|---|
| 1 | **What a cryptographic inventory actually is** (P1) | Inventory-is-step-one post | Thread: what the CISA factsheet says |
| 2 | — | Why severity scores mislead (P4) | Dependencies vs source coverage |
| 3 | **Reading NIST's transition timeline** (P2) — verified dates only | Deadline explainer (P2) | Thread: what the dates mean |
| 4 | — | Building in public: asset model (P3) | Schema decision detail |

### Month 2 — Show the engineering

| Wk | Blog (P) | LinkedIn | X |
|---|---|---|---|
| 5 | **Why we made findings persistent assets** (P3) | Drift detection post | Thread: per-scan findings problem |
| 6 | — | Coverage meter / blind spots (P1) | Screenshot: what we haven't scanned |
| 7 | **Mosca's inequality, worked through** (P4) | X + Y > Z explainer | Data lifetime poll |
| 8 | — | Certificate expiry vs deadlines (P1) | Cert timeline chart |

### Month 3 — Open up

| Wk | Blog (P) | LinkedIn | X |
|---|---|---|---|
| 9 | **We ran our own standards on ourselves** (P3) | The security findings post | Thread: what we found in our own code |
| 10 | — | CBOM / interoperability (P3) | CycloneDX export demo |
| 11 | **Crypto-agility: the metric nobody measures** (P4) | Agility explainer | Thread: 200 call sites vs 20 |
| 12 | — | Quarter recap + what's next (P5) | Roadmap thread |

### On week 9

The "we ran our own tool on ourselves and published the findings" post is likely the single
highest-credibility piece available to us, because almost no vendor does it. It requires the
S1–S8 fixes in [../08-security.md](../08-security.md) to be genuinely done first — publishing it
with the issues still open would be worse than not publishing at all.

---

## The queue

Working state lives here. The agent maintains this table.

Status: `idea` → `researching` → `drafted` → `awaiting-approval` → `approved` → `published`

| ID | Pillar | Title | Channel | Status | Blocked by |
|---|---|---|---|---|---|
| C001 | P1 | What a cryptographic inventory actually is | Blog | `idea` | — |
| C002 | P1 | Most PQC plans stall at step one | LinkedIn | `drafted` | see [04](04-linkedin.md#draft-c002) |
| C003 | P2 | Reading NIST's transition timeline | Blog | `idea` | **Verify all dates against primary source** |
| C004 | P4 | Severity scores without data lifetime | LinkedIn | `drafted` | see [04](04-linkedin.md#draft-c004) |
| C005 | P3 | Why findings became persistent assets | Blog | `idea` | Ships after A1 |
| C006 | P1 | The coverage meter | LinkedIn | `drafted` | see [04](04-linkedin.md#draft-c006) |
| C007 | P3 | We ran our own standards on ourselves | Blog | `idea` | **S1–S8 must be fixed first** |
| C008 | P4 | Mosca's inequality, worked through | Blog | `idea` | — |
| C009 | P2 | What the CISA factsheet actually says | X thread | `drafted` | see [05](05-twitter.md#draft-c009) — rewritten 2026-08-01, old version had an invented claim |
| C010 | P3 | Crypto-agility: the metric nobody measures | Blog | `idea` | Ships after D5 |
| C011 | P3 | Regex limitations and confidence scoring | X | `drafted` | see [05](05-twitter.md#draft-c011) |
| C012 | P2 | Quantum computers do not break AES | X | `drafted` | see [05](05-twitter.md#draft-c012) |
| C013 | P4 | HNDL is a retention question, not a date | X | `drafted` | see [05](05-twitter.md#draft-c013) |

---

## Rules for the queue

1. **Nothing moves to `approved` without a human.** The agent may move items up to
   `awaiting-approval` and no further.
2. **`researching` means primary sources are being read**, not that a summary is being
   paraphrased. Standards content must cite the actual document.
3. **Blocked items stay blocked.** C007 shipping before the security fixes are real would be
   dishonest and would invite exactly the scrutiny we would fail.
4. **Do not announce unbuilt features.** Anything referencing a roadmap item must wait until it
   ships. Check status in [../03-features.md](../03-features.md) before drafting.
5. **Reprioritise on news.** A standards update or a relevant incident justifies reordering the
   queue — that is a good autonomous decision, and the agent should note why it reordered.

---

## Measurement

Early on, engagement volume is noise. Track instead:

| Signal | Why it matters |
|---|---|
| Comments from people with security titles | The right audience found us |
| Forwards/shares by practitioners | The forwardability test passed |
| Inbound "how does this handle X?" questions | Technical credibility landed |
| Time on page for blog posts | Depth is being read, not skimmed |
| Design-partner conversations started | The only metric that matters in quarter one |

Vanity metrics — impressions, follower count — are reported but not optimised for. In a market
this small, ten of the right readers beats ten thousand of the wrong ones.
