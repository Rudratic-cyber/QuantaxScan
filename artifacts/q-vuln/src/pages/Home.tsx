import { useEffect, useState, useRef } from "react";
import { useGetGlobalStats, useListDemoRepos } from "@workspace/api-client-react";
import {
  Shield, ArrowRight, FileSearch, Scale, ClipboardCheck, Check, Clock,
  GitBranch, AlertTriangle, Zap, ChevronRight, Boxes, Lock, Network, KeyRound, Server, FileCode,
} from "lucide-react";
import { motion, useMotionValue, useSpring } from "framer-motion";
import { Link } from "wouter";
import { KonamiEgg } from "@/components/EasterEggs";

// ── Scroll-reveal wrapper ─────────────────────────────────────────────────────
function Reveal({
  children, className, delay = 0, y = 22,
}: {
  children: React.ReactNode; className?: string; delay?: number; y?: number;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1], delay }}
    >
      {children}
    </motion.div>
  );
}

// ── Animated counter ──────────────────────────────────────────────────────────
function AnimatedNumber({ value }: { value: number }) {
  const mv = useMotionValue(0);
  const spring = useSpring(mv, { stiffness: 60, damping: 18 });
  const [display, setDisplay] = useState(0);
  const hasAnimated = useRef(false);
  useEffect(() => spring.on("change", (v) => setDisplay(Math.round(v))), [spring]);
  return (
    <motion.span
      onViewportEnter={() => { if (!hasAnimated.current) { hasAnimated.current = true; mv.set(value); } }}
      viewport={{ once: true }}
    >
      {display.toLocaleString()}
    </motion.span>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-[#e5e7eb] bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-[#4f46e5]">
      {children}
    </span>
  );
}

// ── Live scanner preview ──────────────────────────────────────────────────────
function ScannerPreview() {
  const [lines, setLines] = useState<{ text: string; tone?: "cmd"|"muted"|"crit"|"safe"|"map" }[]>([]);
  const SEQUENCE: { text: string; tone?: "cmd"|"muted"|"crit"|"safe"|"map" }[] = [
    { text: "q-vuln scan ./service --recursive", tone: "cmd" },
    { text: "Building cryptographic inventory…", tone: "muted" },
    { text: "auth/tokens.py  RSA-2048            line 42", tone: "crit" },
    { text: "tls/handshake.go  ECDH-P256         line 91", tone: "crit" },
    { text: "store/aead.rs  AES-256-GCM          line 12", tone: "safe" },
    { text: "3 assets · 2 quantum-vulnerable", tone: "muted" },
    { text: "→ mapped to ML-KEM-768 · NIST FIPS 203", tone: "map" },
  ];
  useEffect(() => {
    let i = 0;
    const next = () => {
      if (i < SEQUENCE.length) {
        setLines(prev => [...prev, SEQUENCE[i++]]);
        setTimeout(next, 360 + Math.random() * 160);
      }
    };
    const t = setTimeout(next, 450);
    return () => clearTimeout(t);
  }, []);

  const toneClass: Record<string, string> = {
    cmd: "text-[#4f46e5] font-semibold",
    muted: "text-[#9aa3b2]",
    crit: "text-[#b91c1c]",
    safe: "text-[#059669]",
    map: "text-[#4338ca] font-medium",
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-[#e5e7eb] bg-white shadow-[0_20px_60px_rgba(15,23,42,0.10)]">
      <div className="flex items-center gap-1.5 border-b border-[#eceef2] bg-[#f7f8fa] px-4 py-3">
        <div className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <div className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <div className="h-3 w-3 rounded-full bg-[#28c840]" />
        <span className="flex-1 text-center text-[11px] font-medium text-[#6b7280]">cryptographic inventory</span>
      </div>
      <div className="min-h-[210px] space-y-1.5 p-5 font-mono text-[12.5px]">
        {lines.map((l, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.2 }}
            className={l.tone ? toneClass[l.tone] : "text-[#475569]"}
          >
            {l.tone === "cmd" && <span className="text-[#9aa3b2]">$ </span>}
            {l.text}
          </motion.div>
        ))}
        {lines.length < SEQUENCE.length && (
          <span className="inline-block h-3.5 w-[7px] cursor-blink bg-[#4f46e5] align-middle" />
        )}
      </div>
    </div>
  );
}

// ── Coverage surfaces (honestly labelled) ─────────────────────────────────────
const SURFACES: { name: string; icon: React.ReactNode; status: "now" | "planned"; note: string }[] = [
  { name: "Source code",        icon: <FileCode className="h-5 w-5" />,  status: "now",     note: "RSA, ECDSA, ECDH/DH, DSA, MD5, SHA-1, AES-ECB across many languages" },
  { name: "Dependencies",       icon: <Boxes className="h-5 w-5" />,     status: "planned", note: "Crypto pulled in transitively through your package graph" },
  { name: "TLS & endpoints",    icon: <Network className="h-5 w-5" />,   status: "planned", note: "What is actually negotiated at your termination points" },
  { name: "Certificates",       icon: <Lock className="h-5 w-5" />,      status: "planned", note: "Signature and key-exchange algorithms in your PKI" },
  { name: "Key stores / KMS",   icon: <KeyRound className="h-5 w-5" />,  status: "planned", note: "Keys held in vaults, HSMs and cloud KMS" },
  { name: "Runtime & services", icon: <Server className="h-5 w-5" />,    status: "planned", note: "Crypto in running infrastructure, not just committed code" },
];

// ── Mosca variables ───────────────────────────────────────────────────────────
const MOSCA = [
  { k: "X", label: "Secrecy lifetime", desc: "How long this data must stay confidential — from your own retention obligations." },
  { k: "Y", label: "Migration time",   desc: "How long it takes to move this asset off vulnerable crypto. We estimate it per finding." },
  { k: "Z", label: "Time to Q-Day",    desc: "Regulatory deadlines and quantum timelines — shown as scenarios, not a single date." },
];

export function Home() {
  const { data: globalStats } = useGetGlobalStats();
  const { data: demoRepos }   = useListDemoRepos();

  return (
    <div className="flex-1 w-full bg-white text-[#0a0e1a]">
      <KonamiEgg />

      {/* ── HERO ─────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b border-[#eceef2]">
        <div className="absolute inset-0 blueprint-grid opacity-60" aria-hidden />
        <div className="absolute inset-0 pointer-events-none" aria-hidden
          style={{ background: "radial-gradient(60% 55% at 50% -10%, rgba(79,70,229,0.08) 0%, transparent 70%)" }} />

        <div className="container relative mx-auto grid grid-cols-1 items-center gap-12 px-4 pb-20 pt-16 lg:grid-cols-2 lg:pt-24">
          <div>
            <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
              <Eyebrow><Shield className="h-3.5 w-3.5" /> Post-quantum readiness</Eyebrow>
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.06, ease: [0.22, 1, 0.36, 1] }}
              className="mt-6 text-4xl font-extrabold leading-[1.08] tracking-tight text-[#0a0e1a] md:text-5xl lg:text-6xl"
            >
              Know where your<br className="hidden sm:block" /> cryptography is.
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.14 }}
              className="mt-6 max-w-xl text-lg leading-relaxed text-[#475569]"
            >
              Post-quantum migration starts with an inventory almost nobody has. Q-Vuln builds it
              automatically — starting with your source code — and shows you which assets will still
              be exposed when the deadlines land.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.22 }}
              className="mt-8 flex flex-col items-start gap-3 sm:flex-row sm:items-center"
            >
              <Link href="/scan">
                <span className="inline-flex h-12 cursor-pointer items-center justify-center gap-2 rounded-xl bg-[#4f46e5] px-7 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-[#4338ca]">
                  Scan a repository
                  <ArrowRight className="h-4 w-4" />
                </span>
              </Link>
              <Link href="/coverage">
                <span className="inline-flex h-12 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-[#e5e7eb] bg-white px-7 text-sm font-semibold text-[#0a0e1a] transition-all hover:border-[#d8dce3] hover:bg-[#f7f8fa]">
                  See what we cover
                </span>
              </Link>
            </motion.div>

            <motion.p
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }}
              className="mt-4 text-sm text-[#9aa3b2]"
            >
              No account needed. Paste code or point us at a public repo.
            </motion.p>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.7, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <ScannerPreview />
          </motion.div>
        </div>
      </section>

      {/* ── Stats bar ─────────────────────────────────────────────────────── */}
      {globalStats && (
        <section className="border-b border-[#eceef2] bg-[#f7f8fa]">
          <div className="container mx-auto grid grid-cols-1 gap-px overflow-hidden px-4 py-10 sm:grid-cols-3">
            {[
              { value: globalStats.totalReposScanned, label: "Repositories scanned" },
              { value: globalStats.totalVulnerabilitiesFound, label: "Vulnerable assets found" },
              { value: globalStats.totalLinesScanned, label: "Lines analysed" },
            ].map((stat, i) => (
              <Reveal key={stat.label} delay={i * 0.08}>
                <div className="text-center">
                  <div className="text-4xl font-extrabold tracking-tight text-[#0a0e1a]">
                    <AnimatedNumber value={stat.value} />
                  </div>
                  <div className="mt-1.5 text-sm text-[#6b7280]">{stat.label}</div>
                </div>
              </Reveal>
            ))}
          </div>
        </section>
      )}

      {/* ── The problem ───────────────────────────────────────────────────── */}
      <section className="container mx-auto px-4 py-20 md:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <Reveal><Eyebrow><FileSearch className="h-3.5 w-3.5" /> The problem</Eyebrow></Reveal>
          <Reveal delay={0.06}>
            <h2 className="mt-5 text-3xl font-bold tracking-tight text-[#0a0e1a] md:text-4xl">
              Every post-quantum roadmap starts the same way: build a cryptographic inventory.
            </h2>
          </Reveal>
          <Reveal delay={0.12}>
            <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-[#475569]">
              It is the step that gates budgeting, sequencing and vendor conversations — and for most
              organisations it currently means a consultant, a spreadsheet, and a document that is
              stale before it is delivered.
            </p>
          </Reveal>
          <Reveal delay={0.18}>
            <p className="mx-auto mt-4 max-w-2xl text-base text-[#6b7280]">
              Source code is the surface most teams scan. It is not where most of the cryptography is —
              so we tell you what we <span className="font-semibold text-[#0a0e1a]">have not</span> looked at, too.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── Coverage ──────────────────────────────────────────────────────── */}
      <section className="border-y border-[#eceef2] bg-[#f7f8fa] py-20 md:py-24">
        <div className="container mx-auto px-4">
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <Reveal><Eyebrow><Boxes className="h-3.5 w-3.5" /> Coverage</Eyebrow></Reveal>
            <Reveal delay={0.06}>
              <h2 className="mt-5 text-3xl font-bold tracking-tight text-[#0a0e1a] md:text-4xl">
                Source is one surface. We show you the rest.
              </h2>
            </Reveal>
            <Reveal delay={0.12}>
              <p className="mt-4 text-[#6b7280]">
                Available surfaces are live today. Planned surfaces are labelled honestly — we never
                imply a collector we have not shipped.
              </p>
            </Reveal>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {SURFACES.map((s, i) => (
              <Reveal key={s.name} delay={i * 0.05}>
                <div className="card-lift h-full rounded-2xl border border-[#e5e7eb] bg-white p-6">
                  <div className="flex items-center justify-between">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#eef0fe] text-[#4f46e5]">
                      {s.icon}
                    </div>
                    {s.status === "now" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[#ecfdf5] px-2.5 py-1 text-[11px] font-semibold text-[#059669]">
                        <Check className="h-3 w-3" /> Available
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[#f1f3f7] px-2.5 py-1 text-[11px] font-semibold text-[#6b7280]">
                        <Clock className="h-3 w-3" /> Planned
                      </span>
                    )}
                  </div>
                  <h3 className="mt-4 text-base font-semibold text-[#0a0e1a]">{s.name}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-[#6b7280]">{s.note}</p>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal delay={0.1}>
            <div className="mt-8 text-center">
              <Link href="/coverage">
                <span className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-semibold text-[#4f46e5] hover:text-[#4338ca]">
                  Full coverage & standards <ChevronRight className="h-4 w-4" />
                </span>
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Risk arithmetic (Mosca) ───────────────────────────────────────── */}
      <section className="container mx-auto px-4 py-20 md:py-24">
        <div className="grid grid-cols-1 items-start gap-12 lg:grid-cols-2">
          <div>
            <Reveal><Eyebrow><Scale className="h-3.5 w-3.5" /> Risk arithmetic</Eyebrow></Reveal>
            <Reveal delay={0.06}>
              <h2 className="mt-5 text-3xl font-bold tracking-tight text-[#0a0e1a] md:text-4xl">
                Severity alone can't tell you what to fix first.
              </h2>
            </Reveal>
            <Reveal delay={0.12}>
              <p className="mt-5 text-lg leading-relaxed text-[#475569]">
                An RSA key on a public site and one protecting 30-year records score identically in
                most tools. We compute exposure from how long your data must stay secret, how long
                migration will take, and published deprecation deadlines — so the ranking reflects
                your actual risk.
              </p>
            </Reveal>
            <Reveal delay={0.18}>
              <div className="mt-6 rounded-xl border border-[#e5e7eb] bg-[#f7f8fa] p-5 font-mono text-sm text-[#475569]">
                <span className="font-semibold text-[#0a0e1a]">X + Y &gt; Z</span>
                <span className="text-[#9aa3b2]">  →  you are already too late</span>
              </div>
            </Reveal>
          </div>

          <div className="space-y-4">
            {MOSCA.map((m, i) => (
              <Reveal key={m.k} delay={i * 0.08}>
                <div className="flex gap-4 rounded-2xl border border-[#e5e7eb] bg-white p-5">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#0a0e1a] font-mono text-lg font-bold text-white">
                    {m.k}
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-[#0a0e1a]">{m.label}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-[#6b7280]">{m.desc}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Evidence ──────────────────────────────────────────────────────── */}
      <section className="border-y border-[#eceef2] bg-[#0a0e1a] py-20 text-white md:py-24">
        <div className="container mx-auto px-4">
          <div className="mx-auto max-w-2xl text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-[#a5b4fc]">
              <ClipboardCheck className="h-3.5 w-3.5" /> Evidence
            </span>
            <h2 className="mt-5 text-3xl font-bold tracking-tight md:text-4xl">Built to survive an audit.</h2>
            <p className="mt-4 text-lg leading-relaxed text-[#cbd5e1]">
              Every finding carries its collector, timestamp and confidence. Every compliance claim
              carries a citation and a retrieval date. Reports pin the standards version they were
              generated against — so a report from last quarter can be regenerated exactly.
            </p>
          </div>
          <div className="mx-auto mt-12 grid max-w-4xl grid-cols-1 gap-4 sm:grid-cols-3">
            {[
              { title: "Provenance on every record", desc: "Collector, timestamp and confidence attached to each finding." },
              { title: "Citations with dates", desc: "NIST and CISA claims linked to primary sources, verified on a date." },
              { title: "Reproducible reports", desc: "Pinned mapping versions mean the same inputs regenerate the same report." },
            ].map((c, i) => (
              <Reveal key={c.title} delay={i * 0.08}>
                <div className="h-full rounded-2xl border border-white/10 bg-white/[0.04] p-6">
                  <h3 className="text-base font-semibold text-white">{c.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-[#94a3b8]">{c.desc}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Demo repos ────────────────────────────────────────────────────── */}
      {demoRepos && demoRepos.length > 0 && (
        <section className="container mx-auto px-4 py-20 md:py-24">
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <Reveal><Eyebrow><GitBranch className="h-3.5 w-3.5" /> See it work</Eyebrow></Reveal>
            <Reveal delay={0.06}>
              <h2 className="mt-5 text-3xl font-bold tracking-tight text-[#0a0e1a] md:text-4xl">
                Real repositories, scanned.
              </h2>
            </Reveal>
            <Reveal delay={0.12}>
              <p className="mt-4 text-[#6b7280]">Open a pre-loaded project and see the inventory it produces — no setup.</p>
            </Reveal>
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
            {demoRepos.map((repo, i) => (
              <Reveal key={repo.slug} delay={i * 0.07}>
                <Link href={`/demo/${repo.slug}`}>
                  <div className="card-lift group flex h-full cursor-pointer flex-col rounded-2xl border border-[#e5e7eb] bg-white p-6">
                    <div className="mb-4 flex items-center justify-between">
                      <h3 className="text-base font-bold text-[#0a0e1a]">{repo.name}</h3>
                      <span className="inline-flex items-center gap-1.5 rounded-lg bg-[#f1f3f7] px-2 py-1 text-[11px] font-medium text-[#475569]">
                        <span className="h-1.5 w-1.5 rounded-full bg-[#4f46e5]" />
                        {repo.language}
                      </span>
                    </div>
                    <p className="mb-5 flex-1 text-sm leading-relaxed text-[#6b7280]">{repo.description}</p>
                    <div className="flex items-center justify-between border-t border-[#eceef2] pt-4">
                      <div className="flex items-center gap-4 text-xs font-semibold">
                        <span className="flex items-center gap-1.5 text-[#dc2626]">
                          <AlertTriangle className="h-3.5 w-3.5" /> {repo.criticalCount}
                        </span>
                        <span className="flex items-center gap-1.5 text-[#d97706]">
                          <Zap className="h-3.5 w-3.5" /> {repo.alertCount}
                        </span>
                      </div>
                      <span className="flex items-center gap-0.5 text-[11px] font-semibold text-[#9aa3b2] transition-colors group-hover:text-[#4f46e5]">
                        View scan <ChevronRight className="h-3 w-3" />
                      </span>
                    </div>
                  </div>
                </Link>
              </Reveal>
            ))}
          </div>
        </section>
      )}

      {/* ── CTA ───────────────────────────────────────────────────────────── */}
      <section className="border-t border-[#eceef2] bg-[#f7f8fa]">
        <div className="container mx-auto px-4 py-20 text-center md:py-24">
          <Reveal>
            <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl border border-[#e5e7eb] bg-white">
              <Lock className="h-7 w-7 text-[#4f46e5]" />
            </div>
            <h2 className="text-3xl font-bold tracking-tight text-[#0a0e1a] md:text-4xl">
              The first question you'll be asked is what you have.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-lg text-[#475569]">
              Start there. Build your cryptographic inventory in the next five minutes.
            </p>
            <Link href="/scan">
              <span className="mt-8 inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-[#4f46e5] px-9 py-3.5 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-[#4338ca]">
                Scan a repository — no account needed
                <ArrowRight className="h-4 w-4" />
              </span>
            </Link>
          </Reveal>
        </div>
      </section>
    </div>
  );
}
