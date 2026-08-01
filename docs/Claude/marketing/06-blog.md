# 06 — Blog

**The source of everything else.** Write here first, derive social content from it. One
well-researched post becomes a LinkedIn post, an X thread, website copy, and a newsletter
section.

## Editorial standards

| Element | Standard |
|---|---|
| **Length** | 1,200–2,500 words. Shorter is a social post; longer needs splitting. |
| **Opening** | State the conclusion in the first paragraph. No throat-clearing, no scene-setting. |
| **Citations** | Every regulatory claim links to the primary document, not a summary of it. |
| **Diagrams** | Where they clarify. Never decorative. |
| **Code** | Real, runnable, from the actual codebase where possible. |
| **Limitations** | Every technical post states what the approach does not handle. |
| **Author** | Named human. Not "the team". |
| **Dates** | Visible publish date and a "last verified" date on any post containing standards claims. |

### The "last verified" date

Standards content decays. A post asserting a NIST deadline needs a visible verification date so
readers can judge staleness, and so we have a trigger to re-check. This is unusual and it signals
exactly the rigour we want associated with the brand.

Add to the content queue: **re-verify every standards post quarterly.**

---

## Post briefs

### B1 — What a cryptographic inventory actually is `P1` `C001`

**Thesis:** everyone agrees inventory is step one; almost nobody defines what a complete one
contains.

Outline: why roadmaps start here → the ten surfaces, with what lives on each → why source-code
scanning covers a minority → what a complete record needs (algorithm, location, provenance,
confidence, owner, data classification) → why it must be continuous → what makes it auditable.

**Angle:** definitional. Become the reference people link when they say "cryptographic
inventory."

---

### B2 — Reading NIST's transition timeline `P2` `C003`

**⚠️ Blocked on verification.** Every date must be confirmed against the primary document, with
draft-vs-final status stated explicitly. **The seed data in `../mappings/` is tagged
`needs-check` and is not a citable source.**

**Thesis:** the deadlines are more specific and closer than most teams assume, and they bind
before any quantum computer does.

Outline: what the guidance says → deprecated vs disallowed and why the distinction matters
operationally → mapping deadlines onto certificate renewal and hardware refresh cycles → the
assets with no remaining cycles.

**Angle:** the practical translation from published dates to procurement calendars.

---

### B3 — Why we made findings persistent assets `P3` `C005`

**Thesis:** a scan produces findings; an inventory needs assets — and the difference is a schema
decision most tools get wrong.

Outline: what per-scan findings cannot answer (has this been fixed? what changed? what is the
trend?) → the asset/observation split → fingerprinting that survives reformatting → why
denormalised standards data makes historical reports inconsistent → the migration we ran.

Real schema from `lib/db/src/schema/`. **Ships after A1.**

**Angle:** engineering credibility. This is the post that makes a technical reader trust us.

---

### B4 — Mosca's inequality, worked through `P4` `C008`

**Thesis:** exposure is arithmetic, and most orgs are missing the one input that is not a
security input.

Outline: X + Y + Z defined → a worked example with real numbers → why Y is not just effort hours
(agility multiplies it) → why we publish three Q-Day scenarios instead of asserting a date →
why X usually lives with legal, and how to go get it.

**Angle:** give the reader a calculation they can run themselves before buying anything. Useful
content earns more trust than gated content.

---

### B5 — We ran our own standards on ourselves `P3` `C007`

**⚠️ Blocked on the S1–S8 fixes in [../08-security.md](../08-security.md) being genuinely done.**

**Thesis:** we built a tool that tells organisations their crypto handling is inadequate, then
audited ourselves and found real issues. Here they are and here is what we fixed.

Outline: the premise → what we found (predictable share-link IDs from `Math.random()`, permissive
CORS, source code persisted unnecessarily, no auth) → why each mattered in our context → what we
changed → what is still open and when it closes.

**Angle:** the highest-credibility post available to us, precisely because almost no vendor does
it. Publishing it with issues still open would be worse than not publishing.

---

### B6 — Crypto-agility: the metric nobody measures `P4` `C010`

**Thesis:** counting vulnerabilities tells you how much crypto you have; agility tells you how
long it will take to change — and only the second one is plannable.

Outline: 200 call sites behind one interface vs 20 scattered → why vulnerability count inverts
the ranking → how we approximate agility without full AST analysis → how it feeds migration
estimates → the limits of the approximation.

**Ships after D5.**

---

## Pipeline

`brief` → `researching` → `drafting` → `technical review` → `awaiting-approval` → `published`

**Technical review is not optional** for any post containing cryptographic or regulatory claims.
A human with domain knowledge reads it before it reaches approval. The agent can draft and
self-check but cannot sign off on correctness in this domain.

## Derivation

After publishing, produce:

1. A LinkedIn post with the single strongest idea — not a summary ([04](04-linkedin.md))
2. An X thread with the technical detail ([05](05-twitter.md))
3. Any website copy the post supersedes ([07](07-website.md))
4. A newsletter entry, once a list exists

Queue these in [03-content-calendar.md](03-content-calendar.md) at publish time.
