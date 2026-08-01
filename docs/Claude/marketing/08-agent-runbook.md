# 08 — Agent runbook

**This is the executable loop.** If you are an agent operating marketing, start here.

## Before anything else

Read, in order: [README.md](README.md) (autonomy boundaries and hard rules) →
[01-positioning.md](01-positioning.md) → [02-voice-and-tone.md](02-voice-and-tone.md) →
[03-content-calendar.md](03-content-calendar.md) (current queue state).

Then re-read the two lines that govern everything:

> **Full autonomy to create. No autonomy to publish.**
> **Never state a fact you have not verified.**

---

## The weekly loop

Run once a week. Each step is a section below.

```
1. Sense    — what changed in the world and in the product?
2. Triage   — does the queue need reordering?
3. Research — read primary sources for the next queued item
4. Draft    — write it
5. Check    — run the checklists
6. Hand off — package for human approval
7. Report   — what shipped, what is queued, what is blocked
```

---

### 1. Sense

Check for changes that should affect content:

| Source | Looking for |
|---|---|
| NIST CSRC, NSA, CISA publications | New or updated guidance, finalised drafts, changed dates |
| `docs/Claude/` in this repo | Features that shipped, decisions made, security fixes landed |
| `git log` since last run | What actually got built — the truth, vs what the roadmap says |
| Industry news | Incidents, competitor launches, standards adoption |

**If a standard changed:** that is the highest-priority signal. It invalidates content, requires
`../mappings/` updates, and is itself a strong post. Flag it immediately rather than waiting for
the report at step 7.

**Check `git log` against the feature catalog.** Roadmap documents drift from reality. Never
draft an announcement for something that has not landed in the code.

### 2. Triage

Review the queue in [03-content-calendar.md](03-content-calendar.md):

- Anything blocked whose blocker has cleared? Move it to `researching`.
- Anything stale — references an old standard, a descoped feature, superseded news? Rewrite or
  kill it. Killing content is a good decision; say why.
- Anything newly urgent because of step 1? Reorder, and note the reason.
- Anything queued that describes an unshipped feature? Push it back.

Reordering the queue in response to news is a **good autonomous decision**. Make it, then explain
it in the report.

### 3. Research

For the next item:

- **Standards content:** open the actual document. Not a summary, not a news article, not the
  seed data in `../mappings/` — that is tagged `needs-check` and is explicitly not citable.
  Record document, section, URL, retrieval date.
- **Technical content:** read the actual code in this repo. Cite real files and line numbers.
  Our engineering detail is the differentiated content; getting it approximately right defeats
  the purpose.
- **Anything with a number:** find the source or cut the number.

If a claim cannot be verified, **the correct output is a draft without that claim** — not a
hedged version of it. "Reportedly" and "some sources suggest" are not verification.

### 4. Draft

Follow the channel playbook: [LinkedIn](04-linkedin.md) · [X](05-twitter.md) ·
[Blog](06-blog.md) · [Website](07-website.md).

Write the blog post first where one exists for the topic, then derive the rest. Do not write four
channel versions from scratch.

### 5. Check

Run the channel checklist, then this universal one:

- [ ] Every factual claim traced to a primary source, cited
- [ ] No customer counts, logos, testimonials, revenue, or team-size claims — **we have none**
- [ ] No unshipped feature described as available (check `built` status in
      [../03-features.md](../03-features.md))
- [ ] No banned phrases ([02](02-voice-and-tone.md#banned-phrases))
- [ ] No implied knowledge of when Q-Day is
- [ ] No named competitor criticised
- [ ] **Credibility test:** would a sceptical CISO who has read the NIST documents object to
      anything here?
- [ ] **Forwardability test:** would a security engineer send this to their CISO?

A draft failing the credibility test is not "nearly ready" — rewrite it. That reader is the
entire audience.

### 6. Hand off

Package each item for a human in this format:

```markdown
## [C0XX] Title — Channel — Pillar

**Status:** awaiting-approval
**Publish target:** Tue 2026-08-12

### Content
<exact text, formatted as it will appear>

### Sources
- Claim: "…" → NIST IR 8547 §3.2, https://…, retrieved 2026-08-05

### Notes
- Anything the reviewer should know
- Anything I could not verify and therefore cut
- Any assumption I made

### Risk flags
- [ ] Contains regulatory claims → needs technical review
- [ ] References a feature → confirmed shipped in <commit>
```

Then **stop**. Do not publish, schedule, or ask for blanket future approval. Approval is
per-item, by a human, every time.

### 7. Report

Short summary: shipped since last run, awaiting approval, blocked and why, world changes
detected, queue changes made and why, anything needing a decision.

---

## Decision procedures

**A standard changed.**
Update `../mappings/` with the new data, bump `dataVersion`, set `retrievedAt`, cite the source.
Flag every published piece referencing the old value. Draft a correction if we stated something
now wrong. Draft a post about the change — it is timely and it demonstrates that we track this.
Flag for human review immediately; do not batch it.

**Someone publicly corrected us and they are right.**
Draft an acknowledgement that states the correction plainly without defensiveness. Fix the source
document and any derived content. Escalate to a human to post — public engagement is never
autonomous. A well-handled correction builds more credibility than the original post.

**A competitor launched something.**
Note it. Do not draft a response post. Reactive competitive content reads as insecurity to an
enterprise buyer, and we do not name competitors.

**We hit a milestone.**
Draft an announcement only if a user-visible capability shipped. Internal milestones are not
content. Verify against `git log`, not the roadmap.

**The queue is empty.**
Do not generate filler. Instead: audit published content for staleness, re-verify dated claims,
run the website audit from [07](07-website.md#quarterly-audit), or research a `P3` pillar topic
in depth. Publishing nothing is better than publishing something generic — generic PQC commentary
is a commodity and it dilutes the one thing we have, which is specificity.

**Asked to publish directly.**
Decline and explain. If a human with authority instructs it explicitly in the moment, that is
their call — but it is not something to infer from a general instruction, a previous approval,
or the phrase "run marketing autonomously". Prior approval of one item never extends to the next.

---

## Invoking the loop

```
Run the weekly marketing loop in docs/Claude/marketing/.
Follow 08-agent-runbook.md. Draft only — do not publish anything.
```

For a single piece:

```
Draft [C004] for LinkedIn following docs/Claude/marketing/.
Verify every claim against primary sources. Package for approval.
```

---

## What good looks like

A week where the agent:

- noticed a NIST page changed and flagged the three published posts it affects
- killed a queued item because the feature it described got descoped
- researched and drafted one blog post with eight cited sources
- derived a LinkedIn post and an X thread from it
- cut a claim it could not verify, and said so in the handoff
- published **nothing**

That is a complete, successful week. The gate is the design, not an obstacle.
