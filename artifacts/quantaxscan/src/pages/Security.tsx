import { Link } from "wouter";
import { ShieldCheck, ServerCog, Cloud, Database, ArrowRight, Mail, FileLock2, EyeOff, KeySquare } from "lucide-react";
import { Reveal, Eyebrow, PageHeader } from "@/components/marketing/primitives";

// Source-code handling tiers (docs/Claude/08-security.md) — best to acceptable.
const TIERS: { tier: string; model: string; trust: string; icon: React.ReactNode; best?: boolean }[] = [
  { tier: "Self-hosted collectors", model: "Collectors run inside your network; only findings ever leave it.", trust: "Minimal trust required", icon: <ServerCog className="h-5 w-5" />, best: true },
  { tier: "Ephemeral analysis", model: "Source is analysed in memory and never persisted — we keep findings, not code.", trust: "Moderate trust", icon: <Cloud className="h-5 w-5" /> },
  { tier: "Short-retention analysis", model: "Encrypted, short-retention source with a documented, working deletion path.", trust: "Higher trust", icon: <Database className="h-5 w-5" /> },
];

// Principles we design to.
const PRINCIPLES: { title: string; desc: string; icon: React.ReactNode }[] = [
  { title: "Data minimisation", desc: "Collectors take only what the inventory needs. A TLS probe records the negotiated cipher suite — never response bodies. Every extra field is blast radius.", icon: <EyeOff className="h-5 w-5" /> },
  { title: "Least-privilege credentials", desc: "Collectors touching your infrastructure use read-only, narrowly-scoped credentials you issue, held in a secrets manager — never in the application database.", icon: <KeySquare className="h-5 w-5" /> },
  { title: "Tenant isolation at the query layer", desc: "Isolation is enforced in a single choke point every inventory query passes through, not by remembering a where clause — and tested with an automated cross-tenant suite.", icon: <FileLock2 className="h-5 w-5" /> },
  { title: "Guarded share links", desc: "Report links carry a sensitive map post-migration: authenticated by default, opt-in public sharing, mandatory expiry, revocable, access-logged, cryptographically-random IDs, never indexed.", icon: <ShieldCheck className="h-5 w-5" /> },
];

// Pre-pilot hardening commitments — framed as forward commitments, not a live vuln list.
const HARDENING: string[] = [
  "Authentication and organisation-scoped authorisation on every route",
  "Cryptographically-random, expiring, revocable share-report links",
  "Bounded evidence snippets — stop persisting full customer source",
  "Explicit CORS origin allowlist from configuration",
  "Secrets kept out of version control; secret scanning in CI",
  "Per-organisation rate limits and a scan job queue",
  "Strict SSRF controls on repository fetching",
  "Append-only audit logging of inventory and report access",
  "Encryption at rest for the inventory database",
  "Independent penetration test before the first pilot with real data",
];

export function Security() {
  return (
    <div className="flex-1 w-full bg-white">
      <PageHeader
        eyebrow={<><ShieldCheck className="h-3.5 w-3.5" /> Security & trust</>}
        title="We hold your crypto map. We hold ourselves to a higher bar."
        lede="A cryptographic inventory is, from an attacker's view, a prioritised target list. That raises our own security bar above a normal SaaS — so we run our product's own standards against ourselves, and we publish where we stand."
      />

      {/* honesty note */}
      <section className="border-b border-[#eceef2] bg-[#f7f8fa]">
        <div className="container mx-auto max-w-3xl px-4 py-6">
          <p className="text-sm leading-relaxed text-[#475569]">
            <span className="font-semibold text-[#0a0e1a]">Where we are today:</span> QuantaXscan is
            pre-launch. The controls below ship before we handle any customer's real data — not
            "before general availability," but before the second organisation's data exists in the
            system. We track that work openly rather than implying a maturity we haven't reached yet.
          </p>
        </div>
      </section>

      {/* Source handling tiers */}
      <section className="container mx-auto px-4 py-16 md:py-20">
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Reveal><Eyebrow><ServerCog className="h-3.5 w-3.5" /> How your source is handled</Eyebrow></Reveal>
          <Reveal delay={0.06}>
            <h2 className="mt-5 text-3xl font-bold tracking-tight text-[#0a0e1a]">Offer the highest tier you'll accept.</h2>
          </Reveal>
          <Reveal delay={0.12}>
            <p className="mt-4 text-[#6b7280]">
              We would rather see less of your code and earn more of your trust. These are the models
              we design toward, ranked by how little you have to hand over.
            </p>
          </Reveal>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {TIERS.map((t, i) => (
            <Reveal key={t.tier} delay={i * 0.07}>
              <div className={`relative h-full rounded-2xl border p-6 ${t.best ? "border-[#4f46e5] bg-[#f7f8ff] shadow-sm" : "border-[#e5e7eb] bg-white"}`}>
                {t.best && (
                  <span className="absolute right-4 top-4 rounded-full bg-[#4f46e5] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">Best</span>
                )}
                <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${t.best ? "bg-[#4f46e5] text-white" : "bg-[#eef0fe] text-[#4f46e5]"}`}>
                  {t.icon}
                </div>
                <h3 className="mt-4 text-base font-semibold text-[#0a0e1a]">{t.tier}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-[#6b7280]">{t.model}</p>
                <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-[#4f46e5]">{t.trust}</p>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal delay={0.1}>
          <p className="mx-auto mt-6 max-w-2xl text-center text-sm text-[#6b7280]">
            Self-hosted collectors are on the roadmap. If your security policy rules out SaaS source
            ingestion, tell us early — it changes what we build first.
          </p>
        </Reveal>
      </section>

      {/* Principles */}
      <section className="border-y border-[#eceef2] bg-[#f7f8fa] py-16 md:py-20">
        <div className="container mx-auto px-4">
          <div className="mx-auto mb-10 max-w-2xl text-center">
            <Reveal><Eyebrow><FileLock2 className="h-3.5 w-3.5" /> Principles</Eyebrow></Reveal>
            <Reveal delay={0.06}>
              <h2 className="mt-5 text-3xl font-bold tracking-tight text-[#0a0e1a]">How we design for it.</h2>
            </Reveal>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {PRINCIPLES.map((p, i) => (
              <Reveal key={p.title} delay={(i % 2) * 0.06}>
                <div className="flex h-full gap-4 rounded-2xl border border-[#e5e7eb] bg-white p-6">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#eef0fe] text-[#4f46e5]">
                    {p.icon}
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-[#0a0e1a]">{p.title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-[#6b7280]">{p.desc}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Hardening roadmap */}
      <section className="container mx-auto max-w-3xl px-4 py-16 md:py-20">
        <Reveal><Eyebrow><ShieldCheck className="h-3.5 w-3.5" /> Pre-pilot hardening</Eyebrow></Reveal>
        <Reveal delay={0.06}>
          <h2 className="mt-5 text-3xl font-bold tracking-tight text-[#0a0e1a]">Our commitments before your data arrives.</h2>
        </Reveal>
        <Reveal delay={0.12}>
          <p className="mt-4 text-[#6b7280]">
            Running our own category's standards against ourselves is the point. This is the list we
            hold ourselves to before the first pilot — and we would rather show it than hide it.
          </p>
        </Reveal>
        <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {HARDENING.map((h) => (
            <Reveal key={h}>
              <div className="flex items-start gap-3 rounded-xl border border-[#e5e7eb] bg-white p-4">
                {/* A list marker, not a checkbox: these are commitments, not completed work.
                    An unchecked box read as an unfinished to-do list; a tick would claim they
                    are already done. Same 20px footprint, so the grid does not reflow. */}
                <span aria-hidden="true" className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[#eef0fe]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#4f46e5]" />
                </span>
                <span className="text-sm leading-relaxed text-[#3f4656]">{h}</span>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal delay={0.1}>
          <p className="mt-6 text-sm text-[#6b7280]">
            Before general availability: SOC 2 Type II or ISO 27001, a public trust page, a
            vulnerability disclosure policy, and a signed DPA template.
          </p>
        </Reveal>
      </section>

      {/* Disclosure */}
      <section className="border-t border-[#eceef2] bg-[#0a0e1a] py-16 text-white md:py-20">
        <div className="container mx-auto max-w-3xl px-4 text-center">
          <Mail className="mx-auto h-8 w-8 text-[#a5b4fc]" />
          <h2 className="mt-4 text-2xl font-bold tracking-tight md:text-3xl">Found something? Tell us.</h2>
          <p className="mx-auto mt-3 max-w-lg text-[#cbd5e1]">
            We welcome responsible disclosure. Report a suspected vulnerability privately and we will
            acknowledge it, keep you updated, and credit you if you'd like.
          </p>
          <a
            href="mailto:security@quantaxscan.com"
            className="mt-7 inline-flex items-center justify-center gap-2 rounded-xl bg-white px-8 py-3.5 text-sm font-semibold text-[#0a0e1a] transition-all hover:-translate-y-0.5"
          >
            security@quantaxscan.com <ArrowRight className="h-4 w-4" />
          </a>
          <div className="mt-8">
            <Link href="/coverage">
              <span className="cursor-pointer text-sm font-semibold text-[#a5b4fc] hover:text-white">
                See what we cover →
              </span>
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
