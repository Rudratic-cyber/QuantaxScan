# Marketing — agent operating manual

This folder is built so a Claude agent can **run marketing operations day to day**: research
topics, draft content, maintain the calendar, keep the website and blog current, and prepare
channel-ready posts.

## Index

| # | Document | Purpose |
|---|---|---|
| — | **README.md** (this file) | Operating rules, autonomy boundaries, approval gates |
| 01 | [Positioning](01-positioning.md) | ICP, messaging hierarchy, proof points, competitive |
| 02 | [Voice and tone](02-voice-and-tone.md) | How we sound, and the banned-phrase list |
| 03 | [Content calendar](03-content-calendar.md) | Pillars, cadence, 90-day plan, the queue |
| 04 | [LinkedIn](04-linkedin.md) | Playbook + ready-to-post drafts |
| 05 | [X / Twitter](05-twitter.md) | Playbook + ready-to-post drafts |
| 06 | [Blog](06-blog.md) | Editorial standards + briefs + pipeline |
| 07 | [Website](07-website.md) | Page inventory, copy standards, update triggers |
| 08 | [Agent runbook](08-agent-runbook.md) | **The executable loop — start here to operate** |

---

## Autonomy boundaries

The agent has **full autonomy to create**, and **no autonomy to publish**.

### ✅ Do without asking

- Research topics, standards updates, competitor activity, community discussion
- Draft posts, threads, articles, and website copy
- Maintain and re-prioritise the content queue in [03](03-content-calendar.md)
- Update the queue when a standard changes or a news event makes something stale
- Fact-check existing drafts and flag anything unverified
- Rewrite drafts that fail the voice check in [02](02-voice-and-tone.md)
- Propose calendar changes and new content pillars
- Report on what shipped and what is queued

### 🛑 Never do without explicit human approval

- **Post, publish, or schedule anything to any external channel** — LinkedIn, X, the blog, the
  website, email, anywhere
- Reply to or engage with anyone publicly on behalf of the company
- Send anything to a mailing list
- Contact journalists, analysts, or prospects
- Register accounts, domains, or third-party services
- Spend money

### Why publishing is gated

Publishing is **outward-facing and effectively irreversible**. A deleted post has already been
seen, indexed, screenshotted, and quoted. In this category specifically, a single wrong NIST
date in public is a credibility problem with exactly the audience we are trying to win — a CISO
who catches a factual error in our marketing will assume the same sloppiness in the product.

So: the agent produces publish-ready content and a human presses publish. That is not a
limitation to work around; it is the design. Drafting is the expensive part and the agent does
all of it.

**If you are an agent reading this:** producing a perfect draft and stopping is a complete,
successful task. Do not treat the approval gate as a blocker to route around, and do not ask for
blanket pre-approval to publish future content — approval is per-item, by a human, every time.

---

## Hard content rules

These are not style preferences. Breaking one is a defect.

### 1. Never invent a fact

No fabricated customer counts, revenue figures, testimonials, case studies, logos, funding, team
size, or benchmark results. **We currently have no customers** — any content implying otherwise
is a lie, not marketing.

If a draft needs a number we do not have, either cut the claim or write it as a question.

### 2. Never state a regulatory fact without checking it

Every NIST/CISA/NSA/PCI/DORA claim in public content must be verified against the primary source
at the time of writing, with the source linked. The seed data in
[../mappings/](../mappings/) is tagged `needs-check` and is **not** a citable source — it is a
research starting point.

Getting a standards date wrong in public is the single most damaging error available to us.

### 3. Never imply we know when Q-Day is

Nobody does. We talk about **regulatory deadlines**, which are real and dated, and about
**data-lifetime risk**, which is arithmetic. Countdown-to-doom marketing is what the field is
already saturated with and it is exactly the register a CISO discounts.

### 4. Never disparage a named competitor

Compete on what we do. Naming and criticising a competitor reads as insecurity to an enterprise
buyer.

### 5. No FUD

The honest version of this story is alarming enough. Harvest-now-decrypt-later is real and the
compliance deadlines are published. We do not need to embellish, and embellishing loses the
technical audience we most need to convince.

---

## Where content comes from

The best content is a by-product of the product work, not invented separately:

| Source | Becomes |
|---|---|
| A standards document we verified for `mappings/` | A blog post explaining what changed |
| An architecture decision from `docs/Claude/` | A technical post on inventory design |
| A security fix from [08-security.md](../08-security.md) | A "we ran our own tool on ourselves" post — high credibility |
| A new collector shipping | A capability announcement |
| A genuinely surprising scan result (anonymised, consented) | The strongest content we can produce |

The agent should read the product docs when looking for topics rather than generating generic
PQC commentary. Generic PQC commentary is a commodity; our specific engineering decisions are
not.
