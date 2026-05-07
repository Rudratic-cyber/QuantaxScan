/**
 * IntroScreen — full-viewport intro overlay.
 * Laptop slides in → lid opens → terminal types → lid closes → fades out.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence, useMotionValue, animate } from "framer-motion";
import { cn } from "@/lib/utils";

const CODE = [
  { t: "# crypto_utils.py — internal auth service", vuln: false },
  { t: "import hashlib",                             vuln: false },
  { t: "from Crypto.PublicKey import RSA",           vuln: false },
  { t: "from Crypto.Cipher import DES",              vuln: false },
  { t: "",                                           vuln: false },
  { t: "# Generate RSA key pair",                   vuln: false },
  { t: "key = RSA.generate(1024)   # line 7",       vuln: true  },
  { t: "pub = key.publickey().export_key()",         vuln: false },
  { t: "",                                           vuln: false },
  { t: "# DES encryption",                          vuln: false },
  { t: "cipher = DES.new(b'8bytekey', DES.MODE_ECB)", vuln: true },
  { t: "ct = cipher.encrypt(b'session_token!')",    vuln: false },
];

function IntroTerminal({ onDone }: { onDone: () => void }) {
  const [cmdText, setCmdText]           = useState("");
  const [phase, setPhase]               = useState<"wait"|"cmd"|"code"|"scan"|"done">("wait");
  const [visibleLines, setVisibleLines] = useState(0);
  const [flagged, setFlagged]           = useState<Set<number>>(new Set());
  const [finding, setFinding]           = useState(false);
  const [scanDone, setScanDone]         = useState(false);
  const [cursor, setCursor]             = useState(true);
  const scrollRef                       = useRef<HTMLDivElement>(null);
  const CMD = "q-bitron scan ./crypto_utils.py";

  useEffect(() => {
    const id = setInterval(() => setCursor(v => !v), 530);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [visibleLines, finding, scanDone]);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    t = setTimeout(() => {
      setPhase("cmd");
      let ci = 0;
      const typeChar = () => {
        setCmdText(CMD.slice(0, ci++));
        t = ci <= CMD.length
          ? setTimeout(typeChar, 30 + Math.random() * 14)
          : setTimeout(() => setPhase("code"), 200);
      };
      typeChar();
    }, 160);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (phase !== "code") return;
    let li = 0, t: ReturnType<typeof setTimeout>;
    const showNext = () => {
      setVisibleLines(li + 1);
      if (CODE[li].vuln) {
        t = setTimeout(() => {
          setFlagged(prev => new Set([...prev, li]));
          li++;
          t = li < CODE.length ? setTimeout(showNext, 42) : setTimeout(() => setPhase("scan"), 220);
        }, 140);
      } else {
        li++;
        t = li < CODE.length ? setTimeout(showNext, 38) : setTimeout(() => setPhase("scan"), 220);
      }
    };
    showNext();
    return () => clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    if (phase !== "scan") return;
    const t1 = setTimeout(() => setFinding(true), 160);
    const t2 = setTimeout(() => { setScanDone(true); setPhase("done"); }, 1100);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [phase]);

  useEffect(() => {
    if (phase !== "done") return;
    const t = setTimeout(onDone, 750);
    return () => clearTimeout(t);
  }, [phase, onDone]);

  const prompt = (
    <span className="select-none">
      <span className="font-bold" style={{ color: "#4f8ef7" }}>q-bitron</span>
      <span style={{ color: "#2d3f5c" }}>:~$ </span>
    </span>
  );

  return (
    <div className="w-full h-full bg-[#050810] font-mono text-[11px] flex flex-col select-none">
      <div className="flex items-center gap-1.5 bg-[#0d1224] px-3 py-2 border-b border-white/6 shrink-0">
        <div className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <div className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <div className="h-3 w-3 rounded-full bg-[#28c840]" />
        <span className="flex-1 text-center text-[10px] text-[#475569] tracking-wider">
          q-bitron — quantum vulnerability scanner
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 text-[10.5px] leading-relaxed">
        {phase !== "wait" && (
          <div className="mb-2">
            {prompt}
            <span className="text-[#f1f5f9]">{cmdText}</span>
            {phase === "cmd" && (
              <span className={cn("inline-block h-[12px] w-[6px] bg-[#4f8ef7] align-middle ml-0.5 transition-opacity duration-100", !cursor && "opacity-0")} />
            )}
          </div>
        )}

        {visibleLines > 0 && (
          <div className="mb-2">
            <div className="text-[9px] text-[#2d3f5c] mb-1 tracking-widest">── crypto_utils.py ──────────────────</div>
            {CODE.slice(0, visibleLines).map((line, i) => {
              const isFlagged = flagged.has(i);
              return (
                <div key={i} className="flex leading-[1.7]">
                  <span className="w-5 shrink-0 text-right text-[#2d3f5c] mr-2.5 text-[9px]">{i + 1}</span>
                  <div className={cn(
                    "flex-1 px-1 rounded flex items-center gap-1 flex-wrap",
                    isFlagged && "bg-red-500/10 border-l-2 border-red-500"
                  )}>
                    <PythonTokens text={line.t} />
                    {isFlagged && (
                      <motion.span
                        initial={{ opacity: 0, x: -4 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="text-[8.5px] font-bold px-1 py-0.5 rounded bg-red-500/20 border border-red-500/40 text-red-400 shrink-0"
                      >
                        ⚠ CRITICAL
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
              className="border border-red-500/40 bg-red-950/40 rounded-lg p-2.5 mb-2 shadow-[0_0_20px_rgba(239,68,68,0.12)]"
            >
              <div className="flex items-center gap-2 mb-1.5">
                <div className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse shrink-0" />
                <span className="text-red-400 font-bold text-[10px]">CRITICAL — Quantum-Vulnerable Cryptography</span>
              </div>
              <div className="pl-3.5 space-y-0.5 text-[9.5px]">
                <Row label="algorithm" value="RSA-1024"     valueClass="text-red-300 font-semibold" />
                <Row label="file:line" value="crypto_utils.py:7" valueClass="text-sky-300" />
                <Row label="threat"    value="Broken by Shor's algorithm" valueClass="text-[#94a3b8]" />
                <Row label="replace"   value="ML-KEM-768 · NIST FIPS 203" valueClass="text-emerald-400 font-semibold" />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {scanDone && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.08 }}>
              <div>{prompt}</div>
              <div className="text-[10px] mt-0.5">
                <span className="text-red-400 font-semibold">2 CRITICAL</span>
                <span className="text-[#475569]"> vulnerabilities found. Run </span>
                <span style={{ color: "#4f8ef7" }}>q-bitron fix</span>
                <span className="text-[#475569]"> to remediate.</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Row({ label, value, valueClass }: { label: string; value: string; valueClass: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-[#475569] w-16 shrink-0">{label}</span>
      <span className={valueClass}>{value}</span>
    </div>
  );
}

function PythonTokens({ text }: { text: string }) {
  if (!text.trim()) return <span className="opacity-0">.</span>;
  const kw = new Set(["import","from","as","def","class","return","if","else","for","in","True","False","None"]);
  const parts = text.split(/(#.*)/);
  return (
    <>
      {parts[0] && (
        <>
          {parts[0].split(/(\b\w+\b|[^a-zA-Z0-9_]+)/g).filter(Boolean).map((p, i) => {
            if (kw.has(p))             return <span key={i} style={{ color: "#a78bfa" }}>{p}</span>;
            if (/^\d+$/.test(p))       return <span key={i} className="text-cyan-300">{p}</span>;
            if (/^[A-Z]\w+/.test(p))   return <span key={i} className="text-sky-300">{p}</span>;
            if (/^b?['"]/.test(p))     return <span key={i} className="text-amber-300">{p}</span>;
            if (/^[a-z_]{3,}/.test(p)) return <span key={i} className="text-[#94a3b8]">{p}</span>;
            return <span key={i} className="text-[#475569]">{p}</span>;
          })}
        </>
      )}
      {parts[1] && <span className="text-[#2d3f5c] italic">{parts[1]}</span>}
    </>
  );
}

function LaptopFrame({ children, lidRotateX }: {
  children: React.ReactNode;
  lidRotateX: ReturnType<typeof useMotionValue<number>>;
}) {
  return (
    <div className="flex flex-col items-center" style={{ perspective: "1200px", willChange: "transform" }}>
      <motion.div
        style={{ rotateX: lidRotateX, transformOrigin: "bottom center", transformStyle: "preserve-3d", willChange: "transform" }}
        className="relative w-[580px] h-[360px] rounded-t-2xl bg-[#0d1224] border border-[#4f8ef7]/15 shadow-[0_-8px_60px_rgba(79,142,247,0.1)]"
      >
        <div className="absolute inset-2 rounded-xl overflow-hidden bg-[#050810] border border-white/5">
          {children}
        </div>
        <div className="absolute top-2 left-1/2 -translate-x-1/2 h-1.5 w-1.5 rounded-full bg-neutral-700" />
        <div className="absolute bottom-0 left-4 right-4 h-[3px] rounded-full bg-[#131d35]" />
      </motion.div>
      <div className="relative w-[600px] h-[30px] rounded-b-xl bg-gradient-to-b from-[#0d1224] to-[#050810] border-x border-b border-[#4f8ef7]/10 shadow-[0_16px_50px_rgba(0,0,0,0.9)]">
        <div className="absolute top-0 inset-x-0 h-[3px] bg-[#131d35]" />
        <div className="absolute bottom-3.5 left-1/2 -translate-x-1/2 w-20 h-3.5 rounded bg-white/5 border border-white/8" />
        <div className="absolute top-3 inset-x-5 h-2 grid grid-cols-12 gap-0.5">
          {Array.from({ length: 48 }).map((_, i) => (
            <div key={i} className="rounded-[1px] bg-white/[0.04] border border-white/[0.05]" />
          ))}
        </div>
      </div>
      <div className="w-[640px] h-[2px] bg-gradient-to-r from-transparent via-[#4f8ef7]/10 to-transparent rounded-full mt-1" />
    </div>
  );
}

type IntroPhaseName = "sliding" | "opening" | "terminal" | "closing" | "done";

export function IntroScreen({ onDone }: { onDone: () => void }) {
  const [phase, setPhase]               = useState<IntroPhaseName>("sliding");
  const [showTerminal, setShowTerminal] = useState(false);
  const lidRotateX                      = useMotionValue(-82);

  useEffect(() => {
    let controls: { stop: () => void }[] = [];
    const t1 = setTimeout(() => {
      setPhase("opening");
      const c = animate(lidRotateX, 0, {
        duration: 0.9,
        ease: [0.32, 0.72, 0, 1],
        onComplete: () => { setShowTerminal(true); setPhase("terminal"); },
      });
      controls.push(c);
    }, 580);
    return () => { clearTimeout(t1); controls.forEach(c => c.stop()); };
  }, []);

  const handleTerminalDone = useCallback(() => {
    setPhase("closing");
    setShowTerminal(false);
    const c = animate(lidRotateX, -82, {
      duration: 0.65, ease: [0.4, 0, 0.8, 0.3],
      onComplete: () => setPhase("done"),
    });
    return () => c.stop();
  }, []);

  const skip = useCallback(() => setPhase("done"), []);

  return (
    <AnimatePresence onExitComplete={onDone}>
      {phase !== "done" && (
        <motion.div
          key="intro-overlay"
          exit={{ opacity: 0, scale: 1.1, filter: "blur(12px)" }}
          transition={{ duration: 0.7, ease: [0.4, 0, 1, 1] }}
          className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-[#050810] overflow-hidden"
          style={{ willChange: "transform, opacity, filter" }}
        >
          {/* Ambient glow */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[900px] h-[600px] rounded-full bg-[#4f8ef7]/5 blur-[140px]" />
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[500px] h-[200px] rounded-full bg-[#a78bfa]/4 blur-[90px]" />
          </div>

          {/* Label */}
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12, duration: 0.4 }}
            className="relative z-10 mb-10 flex items-center gap-2.5 text-[11px] font-mono font-semibold uppercase tracking-[0.28em] text-[#94a3b8]"
          >
            <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
            Scanning for quantum vulnerabilities…
          </motion.div>

          {/* Laptop — slides in from right */}
          <motion.div
            initial={{ x: "58vw", opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{ duration: 0.52, ease: [0.22, 1, 0.36, 1] }}
            className="relative z-10"
            style={{ willChange: "transform, opacity" }}
          >
            <LaptopFrame lidRotateX={lidRotateX}>
              {showTerminal ? (
                <IntroTerminal onDone={handleTerminalDone} />
              ) : (
                <div className="w-full h-full bg-[#050810] flex items-center justify-center">
                  <div className="flex gap-1.5">
                    {[0, 1, 2].map(i => (
                      <motion.div
                        key={i}
                        className="h-1.5 w-1.5 rounded-full bg-[#4f8ef7]/60"
                        animate={{ opacity: [0.3, 1, 0.3] }}
                        transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </LaptopFrame>
          </motion.div>

          {/* Skip */}
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 2.2, duration: 0.4 }}
            onClick={skip}
            className="relative z-10 mt-10 text-[11px] text-[#2d3f5c] hover:text-[#475569] transition-colors underline underline-offset-2 cursor-pointer"
          >
            Skip intro
          </motion.button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
