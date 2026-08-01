# 05 — X / Twitter

**Practitioner channel.** Security engineers, cryptographers, appsec people. Sharper and more
technical than LinkedIn. This audience will fact-check us publicly, which is a feature — it
keeps us honest and the corrections are visible.

## Playbook

| Element | Guidance |
|---|---|
| **Register** | More technical, more direct. Dry humour acceptable; jokes about breaches are not. |
| **Length** | Single posts short. Threads 5–9 posts — longer loses people. |
| **Hook** | Post 1 must stand alone and earn the tap. No "🧵👇" as the hook itself. |
| **Threads** | One idea per post. Number them (1/7) — this audience expects it. |
| **Links** | Last post of a thread, never the first. |
| **Hashtags** | 0–1. This platform does not reward them and stuffing reads as spam. |
| **Emoji** | Sparing. One occasionally. |
| **Images** | Screenshots of real output and diagrams perform well. Stock imagery does not. |
| **Cadence** | 3–4 singles/week + 1 thread. |

### Engagement rules

The agent **drafts** replies but **never posts** them. Public engagement on behalf of the company
is a human action — tone is unrecoverable if wrong, and this audience screenshots.

If someone corrects a factual claim of ours and they are right: acknowledge it plainly and fix
the source. That exchange is worth more than the original post.

---

## Ready drafts

Status `drafted` — awaiting human approval.

---

<a id="draft-c009"></a>
### Draft C009 — What the CISA factsheet actually says `P2` (thread)

**Rewritten 2026-08-01.** The previous version of this draft claimed the factsheet defines
"five stages" and enumerated them. It does not — it uses named sections. That claim was
invented and would have been caught by anyone who read the source. All quotes below are
verified against the joint factsheet dated *As of August 17, 2023*.

> **1/6**
> The CISA/NSA/NIST quantum-readiness factsheet is four pages long and most people citing it
> have not read it. Worth doing — it is more specific than the summaries suggest.

> **2/6**
> It asks for a cryptographic inventory, and it names exactly three places to look:
>
> • network protocols
> • assets on end user systems and servers, including applications and associated libraries
> • cryptographic code or dependencies in the CI/CD pipeline
>
> Note that two of the three are not your source code.

> **3/6**
> The line people skip, quoted directly:
>
> "Discovery tools may not be able to identify embedded cryptography used internally within
> products, hindering discoverability or documentation."
>
> The guidance itself tells you your tooling will have blind spots. Any vendor implying
> complete coverage is contradicting it.

> **4/6**
> It also asks for something most inventories omit:
>
> "include estimates on length of protection for these datasets"
>
> That is the data-retention input. Without it you can rank findings by severity but not by
> actual exposure — and that number usually lives with legal, not security.

> **5/6**
> And on what to do first:
>
> "Prioritization should be given to high impact systems, industrial control systems (ICSs),
> and systems with long-term confidentiality/secrecy needs."
>
> ICS is called out explicitly. Those have the longest replacement cycles and the least
> tolerance for change.

> **6/6**
> The uncomfortable conclusion: for most enterprises the post-quantum problem is not a
> cryptography problem yet. It is an asset management problem wearing a cryptography costume.
>
> Factsheet: https://www.cisa.gov/resources-tools/resources/quantum-readiness-migration-post-quantum-cryptography

---

<a id="draft-c011"></a>
### Draft C011 — Regex limitations `P3` (single)

> Our source scanner matches `\bDH\b` to find Diffie-Hellman.
>
> It also matches a variable named `dh`, the initials of a developer in a comment, and the word
> "DHCP" often enough to matter.
>
> This is why every observation carries a confidence score and why the inventory separates
> "detected" from "confirmed". A TLS handshake that actually negotiated ECDHE is evidence. A
> regex hit in a comment is a lead.
>
> Tools that report both as findings are inflating a number you are going to have to defend.

---

<a id="draft-c012"></a>
### Draft C012 — Symmetric crypto is fine `P2` (single)

> Recurring correction: quantum computers do not break AES.
>
> Grover's algorithm gives a quadratic speedup against symmetric keys — AES-128 drops to roughly
> 64-bit effective security, AES-256 stays comfortable. That is a parameter change, not a
> migration.
>
> The break is against public-key crypto: RSA, ECDSA, ECDH, DSA, via Shor.
>
> If a vendor's report has your AES-256 flagged as quantum-critical, ask them why.

---

<a id="draft-c013"></a>
### Draft C013 — HNDL is about retention `P4` (single)

> "Harvest now, decrypt later" gets discussed as a future threat. It is a present-tense
> decision problem.
>
> Traffic recorded today is decrypted whenever the key exchange breaks. So the question is not
> "when is Q-Day" — it is "how long does this data need to stay secret."
>
> If the answer is 20 years, the exposure started at the last deployment, not at Q-Day.

---

## Drafting checklist

- [ ] Post 1 stands alone and earns the tap
- [ ] Thread is 5–9 posts, numbered, one idea each
- [ ] Every technical claim survives a cryptographer reading it — this audience will check
- [ ] Link only in the final post
- [ ] 0–1 hashtags
- [ ] No customer claims, no invented numbers
- [ ] No unshipped features described as available
- [ ] Correction plan: if a claim is challenged, is the primary source to hand?
