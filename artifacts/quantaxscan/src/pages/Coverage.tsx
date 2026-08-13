import { Link } from "wouter";
import { Boxes, Check, Clock, ArrowRight, FileCode, Network, Lock, KeyRound, Server, Database, ShieldCheck, FileText, Building2, Binary } from "lucide-react";
import { Reveal, Eyebrow, PageHeader, StatusPill } from "@/components/marketing/primitives";

// ── Collector surfaces (from docs/Claude/03-features.md §B) ───────────────────
const COLLECTORS: {
  name: string; icon: React.ReactNode; status: "now" | "planned"; blurb: string;
}[] = [
  { name: "Source code", icon: <FileCode className="h-5 w-5" />, status: "now",
    // Only the four asymmetric algorithms have a PQC successor. MD5, SHA-1 and AES-ECB are
    // classical hygiene, not quantum exposure — claiming a "NIST PQC replacement" for them is
    // the same category error the register records as G-10 (and G-09 for the ECB citation).
    blurb: "Regex + pattern detection across many languages. RSA, ECDSA, ECDH/DH and DSA are quantum-vulnerable and map to a NIST PQC replacement; MD5, SHA-1 and AES-ECB are classical hygiene findings with no PQC successor." },
  { name: "Dependencies / SBOM", icon: <Boxes className="h-5 w-5" />, status: "planned",
    blurb: "Parse lockfiles and map to known crypto libraries and versions — the single biggest coverage jump, because most enterprise crypto lives here, not in first-party code." },
  { name: "TLS & cipher suites", icon: <Network className="h-5 w-5" />, status: "planned",
    blurb: "Active handshake against your hosts, recording the key exchange that is actually negotiated — not what a config file claims." },
  { name: "Certificates (X.509)", icon: <Lock className="h-5 w-5" />, status: "planned",
    blurb: "Key type, size and expiry across your PKI. Expiry-versus-Q-Day is the chart that makes the timeline concrete." },
  { name: "KMS & secret stores", icon: <KeyRound className="h-5 w-5" />, status: "planned",
    blurb: "Vault, AWS KMS, Azure Key Vault and GCP KMS, via read-only, narrowly-scoped credentials you issue." },
  { name: "Protocol config", icon: <Server className="h-5 w-5" />, status: "planned",
    blurb: "SSH, IPsec, JWT alg, and SAML/OIDC signing — the crypto choices buried in configuration." },
  { name: "Data-at-rest", icon: <Database className="h-5 w-5" />, status: "planned",
    blurb: "Database TDE and backup/archive encryption — the true harvest-now-decrypt-later targets." },
  { name: "Manual OT / embedded register", icon: <FileText className="h-5 w-5" />, status: "planned",
    blurb: "A structured form, not a scanner, for the estate no tool can reach automatically. It has the longest lead time, so it enters the plan first." },
  { name: "Vendor / third-party", icon: <Building2 className="h-5 w-5" />, status: "planned",
    blurb: "Questionnaire and contractual PQC clause tracking for the crypto you depend on but do not operate." },
  { name: "Binaries / firmware", icon: <Binary className="h-5 w-5" />, status: "planned",
    blurb: "Compiled artefacts with no source and no manifest. NIST SP 1800-38B places this inside core discovery; we have it deferred, and say so rather than omitting the surface." },
];

const STANDARDS: { label: string; detail: string; status: "now" | "planned" }[] = [
  { label: "NIST FIPS 203 / 204 / 205", detail: "ML-KEM, ML-DSA and SLH-DSA replacement mapping.", status: "now" },
  { label: "CycloneDX CBOM 1.7", detail: "Machine-readable cryptographic bill of materials export (ECMA-424).", status: "planned" },
  { label: "NIST IR 8547", detail: "Deprecation-timeline mapping for classical algorithms.", status: "planned" },
  { label: "CNSA 2.0", detail: "Commercial National Security Algorithm suite timeline.", status: "planned" },
  { label: "CISA quantum-readiness roadmap", detail: "Alignment with the published readiness stages.", status: "planned" },
];

export function Coverage() {
  const now = COLLECTORS.filter(c => c.status === "now").length;
  return (
    <div className="flex-1 w-full bg-white">
      <PageHeader
        eyebrow={<><Boxes className="h-3.5 w-3.5" /> Coverage</>}
        title="What we look at — and what we don't."
        lede="A cryptographic inventory is only as trustworthy as its blind spots. Here is every surface we collect from, labelled by whether it is live today or on the roadmap. We never imply a collector we have not shipped."
      />

      {/* honesty banner */}
      <section className="border-b border-[#eceef2] bg-[#f7f8fa]">
        <div className="container mx-auto flex flex-col items-start gap-3 px-4 py-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-[#475569]">
            <span className="font-semibold text-[#0a0e1a]">{now} of {COLLECTORS.length} surfaces available now.</span>{" "}
            The rest are planned and marked as such — coverage grows collector by collector.
          </p>
          <span className="inline-flex items-center gap-2 rounded-full border border-[#e5e7eb] bg-white px-3 py-1 text-[11px] font-medium text-[#6b7280]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#d97706]" /> Pre-launch — status verified 2026-08-01
          </span>
        </div>
      </section>

      {/* collectors grid */}
      <section className="container mx-auto px-4 py-16 md:py-20">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {COLLECTORS.map((c, i) => (
            <Reveal key={c.name} delay={(i % 2) * 0.06}>
              <div className="flex h-full gap-4 rounded-2xl border border-[#e5e7eb] bg-white p-6">
                <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${c.status === "now" ? "bg-[#eef0fe] text-[#4f46e5]" : "bg-[#f1f3f7] text-[#9aa3b2]"}`}>
                  {c.icon}
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold text-[#0a0e1a]">{c.name}</h3>
                    <StatusPill status={c.status} />
                  </div>
                  <p className="mt-1.5 text-sm leading-relaxed text-[#6b7280]">{c.blurb}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* standards */}
      <section className="border-y border-[#eceef2] bg-[#f7f8fa] py-16 md:py-20">
        <div className="container mx-auto max-w-3xl px-4">
          <Reveal><Eyebrow><ShieldCheck className="h-3.5 w-3.5" /> Standards</Eyebrow></Reveal>
          <Reveal delay={0.06}>
            <h2 className="mt-5 text-3xl font-bold tracking-tight text-[#0a0e1a]">Every claim, mapped to a source.</h2>
          </Reveal>
          <Reveal delay={0.12}>
            <p className="mt-4 text-[#6b7280]">
              Our standards data is versioned and citable rather than hardcoded, so a report pins the
              exact mapping version it was generated against.
            </p>
          </Reveal>

          <div className="mt-8 overflow-hidden rounded-2xl border border-[#e5e7eb] bg-white">
            {STANDARDS.map((s, i) => (
              <div key={s.label} className={`flex items-start justify-between gap-4 p-5 ${i > 0 ? "border-t border-[#eceef2]" : ""}`}>
                <div>
                  <div className="flex items-center gap-2">
                    {s.status === "now"
                      ? <Check className="h-4 w-4 text-[#059669]" />
                      : <Clock className="h-4 w-4 text-[#9aa3b2]" />}
                    <span className="font-semibold text-[#0a0e1a]">{s.label}</span>
                  </div>
                  <p className="mt-1 pl-6 text-sm text-[#6b7280]">{s.detail}</p>
                </div>
                <StatusPill status={s.status} />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="container mx-auto px-4 py-16 text-center md:py-20">
        <Reveal>
          <h2 className="text-2xl font-bold tracking-tight text-[#0a0e1a] md:text-3xl">
            Start with the surface that's live.
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-[#475569]">
            Run the source-code scanner today and see the inventory it produces. Coverage compounds
            from there.
          </p>
          <Link href="/scan">
            <span className="mt-7 inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-[#4f46e5] px-8 py-3.5 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-[#4338ca]">
              Scan a repository <ArrowRight className="h-4 w-4" />
            </span>
          </Link>
        </Reveal>
      </section>
    </div>
  );
}
