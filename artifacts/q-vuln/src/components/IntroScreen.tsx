/**
 * IntroScreen — brief, fully-skippable product boot.
 * A clean scanner card types a scan, flags a vulnerable key, and maps it to a
 * NIST PQC replacement — then fades to reveal the site.
 *
 * Skippable three ways: the always-visible Skip button, the Esc key, or a click
 * anywhere on the backdrop. Plays once per visitor (persisted by the caller).
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

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

function ScannerCard({ onDone }: { onDone: () => void }) {
  const [cmdText, setCmdText]           = useState("");
  const [phase, setPhase]               = useState<"wait"|"cmd"|"code"|"scan"|"done">("wait");
  const [visibleLines, setVisibleLines] = useState(0);
  const [flagged, setFlagged]           = useState<Set<number>>(new Set());
  const [finding, setFinding]           = useState(false);
  const [scanDone, setScanDone]         = useState(false);
  const [cursor, setCursor]             = useState(true);
  const scrollRef                       = useRef<HTMLDivElement>(null);
  const CMD = "q-vuln scan ./crypto_utils.py";

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
          ? setTimeout(typeChar, 26 + Math.random() * 12)
          : setTimeout(() => setPhase("code"), 180);
      };
      typeChar();
    }, 120);
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
      <span className="font-semibold" style={{ color: "#4f46e5" }}>q-vuln</span>
      <span style={{ color: "#9aa3b2" }}> ~ </span>
    </span>
  );

  return (
    <div className="w-full overflow-hidden rounded-2xl border border-[#e5e7eb] bg-white shadow-[0_24px_70px_rgba(15,23,42,0.14)]">
      {/* window chrome */}
      <div className="flex items-center gap-1.5 border-b border-[#eceef2] bg-[#f7f8fa] px-4 py-3">
        <div className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <div className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <div className="h-3 w-3 rounded-full bg-[#28c840]" />
        <span className="flex-1 text-center text-[11px] font-medium tracking-wide text-[#6b7280]">
          Q-Vuln — cryptographic scanner
        </span>
      </div>

      <div ref={scrollRef} className="max-h-[340px] overflow-y-auto p-4 font-mono text-[12px] leading-relaxed">
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
                    <span className={isFlagged ? "text-[#b91c1c]" : "text-[#475569]"}>{line.t || " "}</span>
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
                <Row label="algorithm" value="RSA-1024" valueClass="font-semibold text-[#b91c1c]" />
                <Row label="threat" value="Broken by Shor's algorithm" valueClass="text-[#6b7280]" />
                <Row label="replace" value="ML-KEM-768 · NIST FIPS 203" valueClass="font-semibold text-[#059669]" />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {scanDone && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.06 }} className="mt-2">
              <span className="font-semibold text-[#dc2626]">2 critical</span>
              <span className="text-[#6b7280]"> findings mapped to NIST replacements.</span>
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
      <span className="w-16 shrink-0 text-[#9aa3b2]">{label}</span>
      <span className={valueClass}>{value}</span>
    </div>
  );
}

export function IntroScreen({ onDone }: { onDone: () => void }) {
  const [done, setDone] = useState(false);

  const skip = useCallback(() => setDone(true), []);

  // Esc anywhere skips.
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
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
          onClick={skip}
          className="fixed inset-0 z-[200] flex flex-col items-center justify-center overflow-hidden bg-white px-4"
          style={{
            backgroundImage:
              "radial-gradient(60% 50% at 50% 0%, rgba(79,70,229,0.07) 0%, transparent 70%), radial-gradient(50% 40% at 80% 100%, rgba(13,148,136,0.05) 0%, transparent 70%)",
          }}
        >
          {/* Always-visible Skip — high contrast, top-right, never delayed */}
          <button
            onClick={(e) => { e.stopPropagation(); skip(); }}
            className="fixed right-5 top-5 z-10 inline-flex items-center gap-2 rounded-lg border border-[#e5e7eb] bg-white px-4 py-2 text-sm font-semibold text-[#0a0e1a] shadow-sm transition-all hover:border-[#d8dce3] hover:bg-[#f7f8fa]"
          >
            Skip intro
            <kbd className="rounded border border-[#e5e7eb] bg-[#f1f3f7] px-1.5 py-0.5 text-[10px] font-medium text-[#6b7280]">Esc</kbd>
          </button>

          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05, duration: 0.4 }}
            className="mb-6 flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.24em] text-[#6b7280]"
          >
            <span className="h-2 w-2 animate-pulse rounded-full bg-[#4f46e5]" />
            Scanning for quantum-vulnerable cryptography
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg"
          >
            <ScannerCard onDone={skip} />
          </motion.div>

          <p className="mt-6 text-[12px] text-[#9aa3b2]">Click anywhere to continue</p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
