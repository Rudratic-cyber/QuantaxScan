# 04 — LinkedIn

**Primary channel.** The buyer is a CISO or security architect, and this is where they read.

## Playbook

| Element | Guidance |
|---|---|
| **Length** | 150–300 words. Long enough for substance, short enough to finish. |
| **Hook** | First line must work alone — it is all that shows before "see more". Never open with a greeting or a stat nobody asked for. |
| **Structure** | Hook → the problem, specifically → the mechanism → what we're doing → optional soft close |
| **Formatting** | Short paragraphs, one idea each. Line breaks are load-bearing on mobile. |
| **Links** | LinkedIn suppresses reach on posts with external links. Put the link in the first comment and say so. |
| **Hashtags** | 2–3 maximum, at the end. `#postquantum #cybersecurity` |
| **Emoji** | None. |
| **CTA** | Usually none. A question that a practitioner would actually answer beats "DM us". |
| **Cadence** | Tuesday and Thursday, business hours in the target timezone. |

### What performs here

Specific, structured, forwardable. The mental test: *would a security engineer send this to
their CISO with "worth a read"?* That is the whole distribution model early on — we do not have
an audience, so we need content that travels through other people's networks.

### What does not

Fear-led hooks, generic quantum commentary, anything that reads as an advert, engagement bait
("Agree? 👇"), and carousels of stock imagery.

---

## Ready drafts

Status `drafted` — awaiting human approval before posting. Do not publish autonomously.

---

<a id="draft-c002"></a>
### Draft C002 — Most PQC plans stall at step one `P1`

> Most post-quantum migration plans stall at step one, and it is not the cryptography.
>
> It is that nobody can produce a list of where the organisation's cryptography actually is.
>
> Every published readiness roadmap starts the same way: build a cryptographic inventory. It is
> the unglamorous prerequisite that gates budgeting, sequencing and vendor conversations. And
> for most enterprises it currently means a consultant, a spreadsheet, and a document that is
> out of date before it is delivered.
>
> The part that surprises people: source code is the surface everyone scans, and it is not where
> most of the crypto is. The majority sits in third-party dependencies, TLS termination,
> certificate stores and key management systems — none of which a code scanner sees.
>
> So teams run a SAST tool with a PQC rule pack, get a clean-ish report, and conclude they are
> in better shape than they are.
>
> We are building tooling to automate the inventory across those surfaces. Writing up the
> architecture decisions as we go.
>
> What is your organisation using as its cryptographic inventory today — if anything?
>
> #postquantum #cybersecurity

---

<a id="draft-c004"></a>
### Draft C004 — Severity without data lifetime `P4`

> An RSA key protecting your marketing site and an RSA key protecting 30-year patient records
> are not the same risk.
>
> Most tools score them identically.
>
> That is because severity is derived from the algorithm alone. But the actual question for
> post-quantum exposure is arithmetic, and it needs three inputs:
>
> • How long must this data stay secret?
> • How long will it take us to migrate this system?
> • How long until the algorithm is broken or disallowed?
>
> If the first two add up to more than the third, you are already late — regardless of what the
> severity badge says. This is Mosca's inequality, and it has been the right framing since well
> before the standards landed.
>
> The practical consequence: a low-severity finding on a system holding 25-year records can
> outrank a critical finding on something public. Any tool that cannot express that is giving
> you a number you cannot budget against.
>
> The input most organisations are missing is not the crypto detail. It is the data retention
> requirement — which usually lives with legal or compliance, not security.
>
> #postquantum #cybersecurity

---

<a id="draft-c006"></a>
### Draft C006 — Show what you haven't looked at `P1`

> A security dashboard that only shows what it found is quietly claiming complete coverage.
>
> For a vulnerability scanner that is a minor sin. For a cryptographic inventory it is
> disqualifying — because the entire artifact is a statement about completeness.
>
> The scenario that matters: a CISO presents the inventory to an auditor. The auditor asks
> "does this include the mainframe?" If the answer is not already visible on the page, the
> report has failed at the only moment it needed to work.
>
> So we are building the coverage meter to be as prominent as the findings. Surfaces we have not
> scanned show as explicit blind spots with an estimated completeness figure. Early on that
> dashboard is mostly grey.
>
> It looks worse. It is far more useful — and it turns out to be the more sellable version too,
> because every grey bar is a budget line the CISO can now justify in the language their auditor
> just used.
>
> Honest coverage reporting is not a concession. It is the product.
>
> #postquantum #cybersecurity

---

## Drafting checklist

Before moving anything to `awaiting-approval`:

- [ ] First line works standalone as a hook
- [ ] Under 300 words
- [ ] Every factual claim verified against a primary source
- [ ] No customer claims, no invented numbers
- [ ] No banned phrases ([02](02-voice-and-tone.md#banned-phrases))
- [ ] No unshipped features described as available ([../03-features.md](../03-features.md))
- [ ] Passes the credibility test: nothing a sceptical CISO could object to
- [ ] Passes the forwardability test: worth sending to a colleague
- [ ] 2–3 hashtags, no emoji
- [ ] Any link is in the first comment, not the body
