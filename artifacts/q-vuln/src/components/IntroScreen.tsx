/**
 * IntroScreen — brief, fully-skippable product boot.
 * A laptop lid swings open (3-D CSS rotateX) revealing the QuantaXscan
 * terminal.  The scanner types a command, flags vulnerable keys, maps each
 * one to a NIST PQC replacement, then fades to reveal the site.
 *
 * Skippable three ways: the always-visible Skip button, the Esc key, or a
 * click anywhere on the backdrop.  Plays once per visitor (persisted by the
 * caller via sessionStorage).
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

// ── Code lines shown inside the terminal ──────────────────────────────────────
const CODE = [
  { t: "# crypto_utils.py — internal auth service", vuln: false },
  { t: "from Crypto.PublicKey import RSA",           vuln: false },
  { t: "from Crypto.Cipher import DES",              vuln: false },
  { t: "",                                           vuln: false },
  { t: "key = RSA.generate(1024)",                   vuln: true  },
  { t: "pub = key.publickey().export_key()",         vuln: false },
  { t: "",                                           vuln: false },
  { t: "cipher = DES.new(k, DES.MODE_ECB)",          vuln: true  },
];

// ── Helper row for the finding card ──────────────────────────────────────────
function Row({ label, value, valueClass }: { label: string; value: string; valueClass: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-16 shrink-0 text-[#9aa3b2]">{label}</span>
      <span className={valueClass}>{value}</span>
    </div>
  );
}

// ── Terminal card (screen content) ───────────────────────────────────────────
function ScannerCard({ onDone, startDelay = 120 }: { onDone: () => void; startDelay?: number }) {
  const [cmdText, setCmdText]           = useState("");
  const [phase, setPhase]               = useState<"wait"|"cmd"|"code"|"scan"|"done">("wait");
  const [visibleLines, setVisibleLines] = useState(0);
  const [flagged, setFlagged]           = useState<Set<number>>(new Set());
  const [finding, setFinding]           = useState(false);
  const [scanDone, setScanDone]         = useState(false);
  const [cursor, setCursor]             = useState(true);
  const scrollRef                       = useRef<HTMLDivElement>(null);
  const CMD = "quantaxscan scan ./crypto_utils.py";

  // Blinking cursor
  useEffect(() => {
    const id = setInterval(() => setCursor(v => !v), 530);
    return () => clearInterval(id);
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [visibleLines, finding, scanDone]);

  // Typewriter command
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    t = setTimeout(() => {
      setPhase("cmd");
      let ci = 0;
      const typeChar = () => {
        setCmdText(CMD.slice(0, ci++));
        t = ci <= CMD.length
          ? setTimeout(typeChar, 26 + Math.random() * 12)
          : setTimeout(() => setPhase("code"), 180);
      };
      typeChar();
    }, startDelay);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDelay]);

  // Reveal code lines
  useEffect(() => {
    if (phase !== "code") return;
    let li = 0, t: ReturnType<typeof setTimeout>;
    const showNext = () => {
      setVisibleLines(li + 1);
      if (CODE[li].vuln) {
        t = setTimeout(() => {
          setFlagged(prev => new Set([...prev, li]));
          li++;
          t = li < CODE.length ? setTimeout(showNext, 34) : setTimeout(() => setPhase("scan"), 180);
        }, 120);
      } else {
        li++;
        t = li < CODE.length ? setTimeout(showNext, 30) : setTimeout(() => setPhase("scan"), 180);
      }
    };
    showNext();
    return () => clearTimeout(t);
  }, [phase]);

  // Finding + done
  useEffect(() => {
    if (phase !== "scan") return;
    const t1 = setTimeout(() => setFinding(true), 140);
    const t2 = setTimeout(() => { setScanDone(true); setPhase("done"); }, 950);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [phase]);

  useEffect(() => {
    if (phase !== "done") return;
    const t = setTimeout(onDone, 650);
    return () => clearTimeout(t);
  }, [phase, onDone]);

  const prompt = (
    <span className="select-none">
      <span className="font-semibold" style={{ color: "#4f46e5" }}>quantaxscan</span>
      <span style={{ color: "#9aa3b2" }}> ~ </span>
    </span>
  );

  return (
    /* No outer rounded/shadow — the laptop bezel provides that */
    <div className="bg-white">
      {/* macOS-style title bar */}
      <div className="flex items-center gap-1.5 border-b border-[#eceef2] bg-[#f7f8fa] px-4 py-3">
        <div className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <div className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <div className="h-3 w-3 rounded-full bg-[#28c840]" />
        <span className="flex-1 text-center text-[11px] font-medium tracking-wide text-[#6b7280]">
          QuantaXscan — cryptographic scanner
        </span>
      </div>

      <div ref={scrollRef} className="max-h-[320px] overflow-y-auto p-4 font-mono text-[12px] leading-relaxed">
        {phase !== "wait" && (
          <div className="mb-3">
            {prompt}
            <span className="text-[#0a0e1a]">{cmdText}</span>
            {phase === "cmd" && (
              <span className={cn("ml-0.5 inline-block h-[13px] w-[6px] bg-[#4f46e5] align-middle transition-opacity duration-100", !cursor && "opacity-0")} />
            )}
          </div>
        )}

        {visibleLines > 0 && (
          <div className="mb-3 rounded-lg border border-[#eceef2] bg-[#fafbfc] p-2.5">
            <div className="mb-1.5 text-[10px] tracking-wide text-[#9aa3b2]">crypto_utils.py</div>
            {CODE.slice(0, visibleLines).map((line, i) => {
              const isFlagged = flagged.has(i);
              return (
                <div key={i} className="flex leading-[1.7]">
                  <span className="mr-3 w-4 shrink-0 text-right text-[10px] text-[#c4cad4]">{i + 1}</span>
                  <div className={cn(
                    "flex flex-1 flex-wrap items-center gap-1.5 rounded px-1",
                    isFlagged && "bg-[#fef2f2] border-l-2 border-[#dc2626]"
                  )}>
                    <span className={isFlagged ? "text-[#b91c1c]" : "text-[#475569]"}>{line.t || " "}</span>
                    {isFlagged && (
                      <motion.span
                        initial={{ opacity: 0, x: -4 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="shrink-0 rounded bg-[#fee2e2] px-1.5 py-0.5 text-[9px] font-bold text-[#dc2626]"
                      >
                        CRITICAL
                      </motion.span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <AnimatePresence>
          {finding && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
              className="mb-1 rounded-lg border border-[#fca5a5] bg-[#fef2f2] p-3"
            >
              <div className="mb-1.5 flex items-center gap-2">
                <div className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#dc2626]" />
                <span className="text-[11px] font-bold text-[#b91c1c]">Quantum-vulnerable cryptography</span>
              </div>
              <div className="space-y-0.5 pl-3.5 text-[11px]">
                <Row label="algorithm" value="RSA-1024"                   valueClass="font-semibold text-[#b91c1c]" />
                <Row label="threat"    value="Broken by Shor's algorithm" valueClass="text-[#6b7280]" />
                <Row label="replace"   value="ML-KEM-768 · NIST FIPS 203" valueClass="font-semibold text-[#059669]" />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {scanDone && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              transition={{ delay: 0.06 }}
              className="mt-2"
            >
              <span className="font-semibold text-[#dc2626]">2 critical</span>
              <span className="text-[#6b7280]"> findings mapped to NIST replacements.</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ── Laptop keyboard key grid ──────────────────────────────────────────────────
function KeyGrid() {
  // Three rows of keys: 13 / 12 / 10 key blocks
  const rows = [13, 12, 10];
  return (
    <div className="space-y-[5px]">
      {rows.map((count, ri) => (
        <div key={ri} className="flex gap-[4px] justify-center">
          {Array.from({ length: count }, (_, i) => (
            <div
              key={i}
              className="rounded-[3px]"
              style={{
                height: 10,
                flex: ri === 0 ? (i === 0 || i === count - 1 ? "1.4 0 0" : "1 0 0") : "1 0 0",
                background: "linear-gradient(180deg, #d4d7dd 0%, #c8ccd3 100%)",
                boxShadow: "0 1px 0 rgba(0,0,0,0.15)",
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Laptop shell ──────────────────────────────────────────────────────────────
function LaptopShell({
  children,
  lidOpen,
  screenGlow,
}: {
  children: React.ReactNode;
  lidOpen: boolean;
  screenGlow: boolean;
}) {
  return (
    <div className="relative" style={{ perspective: "1400px" }}>
      {/* ── indigo screen glow (behind the lid, bleeds below) ── */}
      <motion.div
        animate={{ opacity: screenGlow ? 1 : 0 }}
        transition={{ duration: 1, ease: "easeOut" }}
        className="pointer-events-none absolute left-1/2 -translate-x-1/2"
        style={{
          top: "10%",
          width: "85%",
          height: "70%",
          background: "radial-gradient(ellipse 80% 60% at 50% 50%, rgba(79,70,229,0.22) 0%, rgba(79,70,229,0.08) 50%, transparent 80%)",
          filter: "blur(20px)",
          zIndex: 0,
        }}
      />

      {/* ── screen lid (rotates open from hinge at bottom edge) ── */}
      <motion.div
        initial={{ rotateX: -90 }}
        animate={{ rotateX: lidOpen ? -4 : -90 }}
        transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
        style={{ transformOrigin: "bottom center", position: "relative", zIndex: 1 }}
      >
        {/* Outer lid body (silver) */}
        <div
          className="relative rounded-t-2xl"
          style={{
            background: "linear-gradient(180deg, #e8eaed 0%, #dde0e5 100%)",
            padding: "3px 3px 0 3px",
            boxShadow: "0 -2px 8px rgba(0,0,0,0.06), 0 8px 32px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.6)",
          }}
        >
          {/* Bezel (dark thin border around screen) */}
          <div
            className="rounded-t-xl overflow-hidden"
            style={{
              background: "#1a1e2e",
              padding: "8px 8px 0 8px",
            }}
          >
            {/* Camera dot */}
            <div className="flex justify-center pb-2">
              <div className="h-[5px] w-[5px] rounded-full" style={{ background: "#2d3348" }} />
            </div>
            {/* Screen content */}
            <div className="overflow-hidden rounded-t-md">
              {children}
            </div>
          </div>

          {/* Logo mark on lid spine (visible when closed, subtle) */}
          <div
            className="absolute left-1/2 -translate-x-1/2"
            style={{ bottom: 6, opacity: 0.25 }}
          >
            <div
              style={{
                width: 16, height: 16,
                borderRadius: 4,
                background: "linear-gradient(135deg, #4f46e5, #06b6d4)",
              }}
            />
          </div>
        </div>
      </motion.div>

      {/* ── hinge strip ── */}
      <div
        className="relative z-[2]"
        style={{
          height: 8,
          background: "linear-gradient(180deg, #b0b4bc 0%, #c8ccd3 100%)",
          boxShadow: "inset 0 2px 3px rgba(0,0,0,0.18), inset 0 -1px 0 rgba(255,255,255,0.3)",
        }}
      />

      {/* ── keyboard base ── */}
      <div
        className="relative z-[2] rounded-b-2xl"
        style={{
          background: "linear-gradient(180deg, #dde0e5 0%, #d0d4da 100%)",
          padding: "14px 22px 18px 22px",
          boxShadow: "0 12px 40px rgba(15,23,42,0.16), inset 0 1px 0 rgba(255,255,255,0.55)",
        }}
      >
        <KeyGrid />

        {/* Space bar row */}
        <div className="mt-[5px] flex gap-[4px] justify-center">
          {[1.4, 1, 5, 1, 1.4].map((flex, i) => (
            <div
              key={i}
              className="rounded-[3px]"
              style={{
                height: 10, flex: `${flex} 0 0`,
                background: "linear-gradient(180deg, #d4d7dd 0%, #c8ccd3 100%)",
                boxShadow: "0 1px 0 rgba(0,0,0,0.15)",
              }}
            />
          ))}
        </div>

        {/* Touchpad */}
        <div
          className="mx-auto mt-3 rounded-lg"
          style={{
            width: 120,
            height: 34,
            background: "linear-gradient(180deg, #cdd0d6 0%, #c4c8ce 100%)",
            boxShadow: "inset 0 1px 2px rgba(0,0,0,0.12), 0 1px 0 rgba(255,255,255,0.4)",
          }}
        />
      </div>
    </div>
  );
}

// ── Main IntroScreen export ───────────────────────────────────────────────────
export function IntroScreen({ onDone }: { onDone: () => void }) {
  const [done, setDone]         = useState(false);
  const [lidOpen, setLidOpen]   = useState(false);
  const [screenGlow, setGlow]   = useState(false);

  // Sequence: slight pause → lid swings open → screen glows → terminal types
  useEffect(() => {
    const t1 = setTimeout(() => setLidOpen(true),  250);
    const t2 = setTimeout(() => setGlow(true),     650);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  const skip = useCallback(() => setDone(true), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") skip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [skip]);

  return (
    <AnimatePresence onExitComplete={onDone}>
      {!done && (
        <motion.div
          key="intro-overlay"
          exit={{ opacity: 0, scale: 1.02, filter: "blur(4px)" }}
          transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
          onClick={skip}
          className="fixed inset-0 z-[200] flex flex-col items-center justify-center overflow-hidden px-4"
          style={{
            background: "#f8faff",
            backgroundImage: [
              "radial-gradient(70% 55% at 50% -5%, rgba(79,70,229,0.10) 0%, transparent 70%)",
              "radial-gradient(50% 40% at 85% 95%, rgba(13,148,136,0.07) 0%, transparent 65%)",
              /* blueprint dot grid */
              "radial-gradient(circle, rgba(79,70,229,0.09) 1px, transparent 1px)",
            ].join(", "),
            backgroundSize: "auto, auto, 28px 28px",
          }}
        >
          {/* Skip button */}
          <button
            onClick={(e) => { e.stopPropagation(); skip(); }}
            className="fixed right-5 top-5 z-10 inline-flex items-center gap-2 rounded-lg border border-[#e5e7eb] bg-white px-4 py-2 text-sm font-semibold text-[#0a0e1a] shadow-sm transition-all hover:border-[#d8dce3] hover:bg-[#f7f8fa]"
          >
            Skip intro
            <kbd className="rounded border border-[#e5e7eb] bg-[#f1f3f7] px-1.5 py-0.5 text-[10px] font-medium text-[#6b7280]">Esc</kbd>
          </button>

          {/* Eyebrow label */}
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.45 }}
            className="mb-8 flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.24em] text-[#6b7280]"
          >
            <motion.span
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ duration: 1.2, repeat: Infinity }}
              className="h-2 w-2 rounded-full bg-[#4f46e5] inline-block"
            />
            Scanning for quantum-vulnerable cryptography
          </motion.div>

          {/* Laptop */}
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1], delay: 0.08 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[560px]"
          >
            <LaptopShell lidOpen={lidOpen} screenGlow={screenGlow}>
              {/* Start typing only once the lid is mostly open (~900 ms) */}
              <ScannerCard onDone={skip} startDelay={900} />
            </LaptopShell>
          </motion.div>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
            className="mt-8 text-[12px] text-[#9aa3b2]"
          >
            Click anywhere to continue
          </motion.p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
