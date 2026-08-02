import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

const DEV_JOKES = [
  { setup: "Why do programmers prefer dark mode?", punchline: "Because light attracts bugs. 🐛" },
  { setup: "How many programmers does it take to change a lightbulb?", punchline: "None. That's a hardware problem." },
  { setup: "A SQL query walks into a bar,", punchline: 'walks up to two tables and asks... "Can I JOIN you?"' },
  { setup: "Why did the developer go broke?", punchline: "Because he used up all his cache." },
  { setup: "99 little bugs in the code,", punchline: "99 little bugs... take one down, patch it around... 127 little bugs in the code." },
  { setup: "A QA engineer walks into a bar", punchline: 'orders 1 beer. orders 0 beers. orders 99999 beers. orders -1 beers. orders a bear.' },
  { setup: "Why is RSA-1024 like a screen door?", punchline: "It keeps honest people honest, but a quantum computer walks right through." },
  { setup: "What did the quantum computer say to the RSA key?", punchline: '"You\'re not even my final boss."' },
  { setup: "Schrödinger\'s bug:", punchline: "It exists and doesn\'t exist until someone pushes to prod." },
];

const KONAMI = ["ArrowUp","ArrowUp","ArrowDown","ArrowDown","ArrowLeft","ArrowRight","ArrowLeft","ArrowRight","b","a"];

export function DevJoke() {
  const [joke]  = useState(() => DEV_JOKES[Math.floor(Math.random() * DEV_JOKES.length)]);
  const [show, setShow]   = useState(false);
  const [phase, setPhase] = useState<"setup"|"punchline">("setup");

  useEffect(() => {
    const t = setTimeout(() => setShow(true), 1000);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!show) return;
    const t = setTimeout(() => setPhase("punchline"), 2200);
    return () => clearTimeout(t);
  }, [show]);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -12, scale: 0.94 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="fixed bottom-20 right-5 z-50 max-w-xs rounded-lg border border-white/10 bg-[#0d1224] shadow-[0_8px_32px_rgba(0,0,0,0.6)] p-4 font-mono text-[11px]"
        >
          <div className="flex items-start gap-2 mb-2">
            <span className="text-[#4f8ef7] text-[9px] font-bold tracking-widest uppercase shrink-0 mt-0.5">// joke.ts</span>
            <button onClick={() => setShow(false)} className="ml-auto text-[#475569] hover:text-[#94a3b8] transition-colors">✕</button>
          </div>
          <p className="text-[#94a3b8] leading-relaxed mb-1.5">{joke.setup}</p>
          <AnimatePresence>
            {phase === "punchline" && (
              <motion.p
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-[#f1f5f9] font-semibold"
              >
                {joke.punchline}
              </motion.p>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function KonamiEgg() {
  const [seq, setSeq] = useState<string[]>([]);
  const [activated, setActivated] = useState(false);

  const handleKey = useCallback((e: KeyboardEvent) => {
    setSeq(prev => {
      const next = [...prev, e.key].slice(-KONAMI.length);
      if (JSON.stringify(next) === JSON.stringify(KONAMI)) {
        setActivated(true);
        setTimeout(() => setActivated(false), 3500);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  return (
    <AnimatePresence>
      {activated && (
        <motion.div
          initial={{ opacity: 0, scale: 0.85 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 1.05 }}
          className="fixed inset-0 z-[999] flex items-center justify-center pointer-events-none"
          style={{ background: "rgba(5,8,16,0.85)", backdropFilter: "blur(6px)" }}
        >
          <div className="text-center font-mono">
            <div className="text-5xl mb-5">⚛️</div>
            <p className="text-[#4f8ef7] text-2xl font-bold tracking-widest" style={{ textShadow: "0 0 20px rgba(79,142,247,0.6)" }}>
              QUANTUM UNLOCKED
            </p>
            <p className="text-[#475569] text-sm mt-2 tracking-widest">// konami code activated</p>
            <p className="text-[#2d3f5c] text-xs mt-1">// RSA could not protect this secret</p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function TerminalHint({ className, children }: { className?: string; children?: React.ReactNode }) {
  const [vis, setVis] = useState(false);
  const cmds = [
    "quantaxscan scan ./your-repo --deep",
    "quantaxscan fix --algo ML-KEM-768",
    "quantaxscan report --format sarif",
    "quantaxscan doctor --check-all",
  ];
  const [cmd] = useState(() => cmds[Math.floor(Math.random() * cmds.length)]);

  return (
    <span
      className={cn("relative", className)}
      onMouseEnter={() => setVis(true)}
      onMouseLeave={() => setVis(false)}
    >
      {children}
      <AnimatePresence>
        {vis && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            className="absolute top-full mt-2 left-0 z-50 whitespace-nowrap rounded border border-white/10 bg-[#0d1224] px-3 py-1.5 font-mono text-[10px] text-[#94a3b8] shadow-[0_4px_20px_rgba(0,0,0,0.5)]"
          >
            <span className="text-[#475569]">$ </span>
            <span className="text-[#f1f5f9]">{cmd}</span>
            <span className="cursor-blink text-[#4f8ef7] ml-0.5">▊</span>
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  );
}

const STATUS_MSGS = [
  "All quantum defenses nominal",
  "Monitoring Shor's algorithm research",
  "NIST FIPS 203 — ready",
  "Post-quantum migration engine active",
  "Entanglement shields operational",
];

export function StatusDot({ className }: { className?: string }) {
  const [msg] = useState(() => STATUS_MSGS[Math.floor(Math.random() * STATUS_MSGS.length)]);
  const [vis, setVis] = useState(false);
  return (
    <span
      className={cn("relative inline-flex items-center gap-1.5 cursor-help", className)}
      onMouseEnter={() => setVis(true)}
      onMouseLeave={() => setVis(false)}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-[#34d399] glow-pulse shrink-0" />
      <AnimatePresence>
        {vis && (
          <motion.span
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            className="absolute left-4 whitespace-nowrap text-[9px] font-mono text-[#94a3b8] tracking-wider"
          >
            {msg}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
