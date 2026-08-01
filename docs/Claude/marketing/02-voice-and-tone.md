# 02 — Voice and tone

## The voice in one line

**A competent security engineer explaining something real to a peer — not a vendor selling
fear.**

Our audience is technical, sceptical, and saturated with quantum hype. The differentiated
position in this market is *calm*. Everyone else is shouting about Q-Day; the brand that sounds
like it has actually read the standards wins the room.

---

## Five principles

### 1. Specific beats dramatic

| ❌ | ✅ |
|---|---|
| "Q-Day is coming. Is your enterprise ready?" | "NIST's draft transition guidance disallows RSA-2048 after 2035. Your certificates renew every 13 months. That is nine renewals to get it right." |

Numbers, dates and mechanisms. Every time.

### 2. Show the working

We are asking people to trust our analysis. Explaining *how* we reached a conclusion is more
persuasive than asserting it, and it demonstrates competence in a way claims cannot.

### 3. Admit limitations

"Our regex scanner has false positives on `\bDH\b` in comments — here is how we handle
confidence scoring" builds more trust than silence. The audience already knows regex has false
positives; pretending otherwise costs credibility with exactly the people who evaluate us.

### 4. No fear, no hype

The honest story is alarming enough. Harvest-now-decrypt-later is real, the deadlines are
published. Embellishment loses the technical reader permanently.

Also banned: "revolutionary", "game-changing", "AI-powered" as a bare claim, "military-grade".

### 5. Respect the reader's time

Front-load the point. If someone reads only the first sentence, they should get the substance.
No throat-clearing, no "In today's rapidly evolving threat landscape."

---

## Register by channel

| Channel | Register |
|---|---|
| **LinkedIn** | Professional peer. Structured. A CISO forwards it to their team. |
| **X / Twitter** | Sharper, more technical, faster. Practitioner audience. Dry humour acceptable. |
| **Blog** | Longest and most technical. Show the working in full. Cite everything. |
| **Website** | Tightest. Every word earns its place. Clarity over personality. |
| **Docs** | Plain, precise, zero marketing language. |

---

## Banned phrases

Rewrite on sight:

- "In today's rapidly evolving threat landscape"
- "Are you ready for Q-Day?" — and any countdown-to-doom framing
- "Quantum apocalypse" / "cryptopocalypse" / "quantum threat looms"
- "Revolutionary" / "game-changing" / "paradigm shift" / "cutting-edge"
- "Military-grade encryption"
- "Bad actors" — say "attackers"
- "Simply" / "just" / "easy" when describing work that is not easy — a PQC migration is not easy
  and saying it is insults the person who has to do it
- "Leverage" as a verb
- "Unlock the power of…"
- "Seamless" / "effortless" / "turnkey"
- Any superlative about ourselves we cannot evidence

## Words we like

Inventory · coverage · evidence · provenance · citation · blind spot · deadline · exposure ·
retention · agility · verified · assumption · scope

Notice these are all **audit vocabulary**. That is deliberate — it is the register our buyer
already lives in.

---

## Formatting

- **Short paragraphs.** One idea each. Most reading is on a phone.
- **Bold sparingly** — one or two per post. Bolding everything bolds nothing.
- **No emoji** in LinkedIn or blog content. Occasional single emoji on X is acceptable.
- **No hashtag stuffing.** Two or three maximum, and only where the platform rewards them.
- **Link to primary sources**, never to a secondary summary of a standard.
- **Code blocks** for anything a reader might copy.

---

## The credibility test

Before anything is queued for approval, ask:

> **Would a sceptical CISO who has read the actual NIST documents find anything here to
> object to?**

If yes, fix it. That reader is the entire target audience, they are the one who forwards content
to their team, and they are unforgiving of vendors who get details wrong.

Second test:

> **Does this contain a single fact I have not personally verified against a primary source?**

If yes, verify it or cut it.

---

## Worked example

**Draft (bad):**

> 🚨 The quantum threat is REAL and it's coming FAST! Bad actors are already harvesting your
> encrypted data to decrypt later. Is your enterprise ready for Q-Day? Our revolutionary
> AI-powered platform makes quantum readiness simple. DM us to learn more! #quantum #security
> #AI #cybersecurity #innovation

Problems: fear-led, unverifiable claims, banned phrases, "simple" about hard work, hashtag
stuffing, no substance, nothing a professional would forward.

**Rewrite (good):**

> Most post-quantum migration plans stall at step one, and it is not the cryptography.
>
> It is that nobody can produce a list of where the organisation's cryptography actually is.
> Source code is the surface people scan, but the majority of enterprise crypto lives in
> dependencies, TLS termination and certificate stores — none of which a code scanner sees.
>
> Every published readiness roadmap starts with "build a cryptographic inventory." That step is
> unglamorous, largely manual today, and it gates everything after it.
>
> We are building the tooling to automate it. Notes on the architecture, including why we made
> findings persistent assets rather than per-scan results: [link]

Specific, useful standalone, no unverifiable claims, forwardable to a security team, and it
sells by demonstrating competence rather than asserting it.
