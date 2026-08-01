# 07 — Website

The current site is the React app in `artifacts/q-vuln/` — heavy on animation (galaxy canvas,
intro splash, typewriter, particles). That register works for a launch page and demos. It works
against us with an enterprise buyer who wants to know what the product does.

**Recommendation:** keep the visual identity, cut the time-to-substance. A CISO evaluating
vendors gives a homepage under 30 seconds, and an intro splash spends several of them.

---

## Page inventory

| Page | Status | Purpose |
|---|---|---|
| `/` Home | Exists | What it is, who it is for, one proof, one CTA |
| `/scan` Scanner | Exists | Live product — strongest asset we have |
| `/demo/:slug` Demos | Exists | Pre-loaded repos, zero-friction trial |
| `/dashboard` | Exists | Needs the calmer CISO register ([../06-cisa-dashboard.md](../06-cisa-dashboard.md)) |
| `/community` | Exists | Knowledge hub |
| **`/why-inventory`** | **Needed** | The core argument, standalone and linkable |
| **`/coverage`** | **Needed** | Which surfaces, what is built vs planned — honestly labelled |
| **`/standards`** | **Needed** | Our reading of NIST/CISA, with citations and verified dates |
| **`/security`** | **Needed** | Our own posture. Enterprise buyers look for this before they talk to you |
| **`/blog`** | **Needed** | Currently no home for long-form |
| **`/docs`** | **Needed** | How collectors work, what data leaves the network |

`/security` and `/coverage` are the two that most affect an enterprise buying decision and both
are missing. Prioritise them over homepage polish.

---

## Homepage copy

Draft — awaiting approval.

### Hero

> # Know where your cryptography is.
>
> Post-quantum migration starts with an inventory almost nobody has. Q-Vuln builds it
> automatically — across source code, dependencies, TLS, certificates and key stores — and
> shows you which assets will still be exposed when the deadlines land.
>
> `[ Scan a repository ]`  `[ How it works ]`

No countdown timer in the hero. Everyone has one and it reads as fear-marketing to the audience
we want.

### Section 2 — The problem

> **Every post-quantum roadmap starts the same way: build a cryptographic inventory.**
>
> It is the step that gates budgeting, sequencing and vendor conversations — and for most
> organisations it currently means a consultant, a spreadsheet, and a document that is stale
> before it is delivered.
>
> Source code is the surface most teams scan. It is not where most of the cryptography is.

### Section 3 — Coverage

Honest surface grid. Built surfaces marked clearly; planned surfaces marked **Planned**, not
implied. See the rule below.

### Section 4 — Risk arithmetic

> **Severity alone cannot tell you what to fix first.**
>
> An RSA key on a public site and one protecting 30-year records score identically in most
> tools. We compute exposure from how long your data must stay secret, how long migration will
> take, and published deprecation deadlines — so the ranking reflects your actual risk.

### Section 5 — Evidence

> **Built to survive an audit.**
>
> Every finding carries its collector, timestamp and confidence. Every compliance claim carries
> a citation and a retrieval date. Reports pin the standards version they were generated
> against, so a report from last quarter can be regenerated exactly.
>
> And we show you what we have *not* looked at.

### CTA

> `[ Scan a repository — no account needed ]`
>
> Or read [why inventory comes first](/why-inventory).

---

## Copy standards

- **Above the fold answers "what is this?"** — not "what is quantum computing?"
- **No countdown timers** in primary marketing surfaces
- **Every capability claim maps to a `built` feature** in [../03-features.md](../03-features.md)
- **Planned features labelled `Planned`** in the same visual weight as the label, never in
  smaller grey text underneath
- **Link primary sources** for every standards claim
- **No customer logos, counts or testimonials** — we have none

### The unbuilt-feature rule

The strongest temptation for a pre-launch site is to describe the product as it will be. Do not.
An enterprise buyer who books a demo expecting certificate discovery and finds it does not exist
is a lost deal *and* a credibility hit that follows us — this is a small market where people
talk.

Split every surface list into **Available now** and **On the roadmap**, visibly.

---

## Update triggers

The agent proposes website changes — always as drafts — when:

| Trigger | Update |
|---|---|
| A collector ships | Move the surface from Planned to Available; update `/coverage` |
| A standard changes | Update `/standards` and re-verify every date on the site |
| A blog post publishes | Add to `/blog`; update anything the post supersedes |
| A security fix lands | Update `/security` |
| A quarter ends | Re-verify every dated claim site-wide |
| A feature is descoped | **Remove it from the site immediately** — stale roadmap claims are worse than none |

That last row matters most and is the one usually forgotten.

---

## Quarterly audit

Once a quarter the agent produces a report — not a change — covering:

- Every factual claim on the site, with its verification status and date
- Every capability claim, checked against `built` status in the feature catalog
- Every standards reference, re-verified against the primary source
- Any copy that has drifted from [02-voice-and-tone.md](02-voice-and-tone.md)
- Dead links, stale dates, orphaned pages

A human reviews and approves the resulting changes.
