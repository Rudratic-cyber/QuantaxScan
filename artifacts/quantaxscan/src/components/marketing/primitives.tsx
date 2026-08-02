import { motion } from "framer-motion";

export function Reveal({
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

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-[#e5e7eb] bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-[#4f46e5]">
      {children}
    </span>
  );
}

export function PageHeader({
  eyebrow, title, lede,
}: {
  eyebrow: React.ReactNode; title: string; lede: string;
}) {
  return (
    <section className="relative overflow-hidden border-b border-[#eceef2]">
      <div className="absolute inset-0 blueprint-grid opacity-50" aria-hidden />
      <div className="absolute inset-0 pointer-events-none" aria-hidden
        style={{ background: "radial-gradient(55% 55% at 50% -10%, rgba(79,70,229,0.07) 0%, transparent 70%)" }} />
      <div className="container relative mx-auto max-w-3xl px-4 py-16 md:py-20">
        <Reveal><Eyebrow>{eyebrow}</Eyebrow></Reveal>
        <Reveal delay={0.06}>
          <h1 className="mt-5 text-4xl font-extrabold leading-tight tracking-tight text-[#0a0e1a] md:text-5xl">{title}</h1>
        </Reveal>
        <Reveal delay={0.12}>
          <p className="mt-5 text-lg leading-relaxed text-[#475569]">{lede}</p>
        </Reveal>
      </div>
    </section>
  );
}

export function StatusPill({ status }: { status: "now" | "planned" }) {
  return status === "now" ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#ecfdf5] px-2.5 py-1 text-[11px] font-semibold text-[#059669]">
      Available now
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#f1f3f7] px-2.5 py-1 text-[11px] font-semibold text-[#6b7280]">
      Planned
    </span>
  );
}
