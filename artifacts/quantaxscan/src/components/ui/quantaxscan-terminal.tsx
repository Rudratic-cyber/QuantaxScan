/**
 * QuantaXscan Terminal — auto-types insecure crypto code, then highlights
 * vulnerable lines and shows findings. Designed for the MacBook screen.
 * No audio dependency required.
 */
import React, { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

// ── Vulnerability metadata ─────────────────────────────────────────────────────
interface VulnFlag {
  lineIndex: number;
  label: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  fix: string;
}

// ── The demo source file ───────────────────────────────────────────────────────
const CODE_LINES = [
  { text: "import hashlib",                      vuln: null },
  { text: "from Crypto.Cipher import DES",       vuln: null },
  { text: "from Crypto.PublicKey import RSA",    vuln: null },
  { text: "from Crypto.Cipher import ARC4",      vuln: null },
  { text: "",                                     vuln: null },
  { text: "# Generate RSA-1024 key pair",        vuln: null },
  { text: "key = RSA.generate(1024)",
    vuln: { label: "RSA-1024", severity: "CRITICAL" as const, fix: "Use ML-KEM-768 (NIST FIPS 203)" } },
  { text: "",                                     vuln: null },
  { text: "# DES encryption (56-bit key)",       vuln: null },
  { text: "cipher = DES.new(b'8bytekey', DES.MODE_ECB)",
    vuln: { label: "DES/ECB", severity: "CRITICAL" as const, fix: "Use AES-256-GCM or ChaCha20-Poly1305" } },
  { text: "ct = cipher.encrypt(b'secret_data_!')", vuln: null },
  { text: "",                                     vuln: null },
  { text: "# RC4 stream cipher",                 vuln: null },
  { text: "rc4 = ARC4.new(b'weakkey12345')",
    vuln: { label: "RC4 stream cipher", severity: "HIGH" as const, fix: "Use ChaCha20-Poly1305" } },
  { text: "",                                     vuln: null },
  { text: "# MD5 password hashing",              vuln: null },
  { text: "digest = hashlib.md5(b'p@ssw0rd').hexdigest()",
    vuln: { label: "MD5 hash", severity: "HIGH" as const, fix: "Use SHA3-256 or BLAKE3" } },
];

const FINDINGS: VulnFlag[] = CODE_LINES
  .map((l, i) => l.vuln ? { lineIndex: i, label: l.vuln.label, severity: l.vuln.severity, fix: l.vuln.fix } : null)
  .filter(Boolean) as VulnFlag[];

const SEVERITY_STYLES = {
  CRITICAL: { dot: "bg-red-500", badge: "bg-red-500/15 border-red-500/40 text-red-400", glow: "shadow-[0_0_8px_rgba(239,68,68,0.3)]" },
  HIGH:     { dot: "bg-orange-400", badge: "bg-orange-500/15 border-orange-400/40 text-orange-300", glow: "shadow-[0_0_8px_rgba(251,146,60,0.25)]" },
  MEDIUM:   { dot: "bg-yellow-400", badge: "bg-yellow-500/15 border-yellow-400/40 text-yellow-300", glow: "" },
};

// ── InView hook ────────────────────────────────────────────────────────────────
function useInView(ref: React.RefObject<HTMLElement | null>) {
  const [inView, setInView] = useState(false);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || done.current) return;
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !done.current) {
        setInView(true);
        done.current = true;
        obs.disconnect();
      }
    }, { threshold: 0.1 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return inView;
}

// ── Syntax colours for Python ──────────────────────────────────────────────────
function PythonLine({ text }: { text: string }) {
  if (text.startsWith("#")) return <span className="text-neutral-500 italic">{text}</span>;

  const parts: JSX.Element[] = [];
  const tokens = text.split(/(\s+|[().,='])/);
  const keywords = new Set(["import","from","as","def","class","return","if","else","for","in","and","or","not","True","False","None"]);

  tokens.forEach((tok, i) => {
    if (!tok) return;
    if (/^\s+$/.test(tok)) { parts.push(<span key={i}>{tok}</span>); return; }
    if (keywords.has(tok)) { parts.push(<span key={i} className="text-violet-400 font-semibold">{tok}</span>); return; }
    if (/^b['"]/.test(tok) || /^['"]/.test(tok)) { parts.push(<span key={i} className="text-amber-300">{tok}</span>); return; }
    if (/^\d+$/.test(tok)) { parts.push(<span key={i} className="text-purple-300">{tok}</span>); return; }
    if (/^[A-Z]/.test(tok) && tok.length > 1) { parts.push(<span key={i} className="text-sky-300">{tok}</span>); return; }
    if (/^[a-z_]+$/.test(tok) && tok.length > 2) { parts.push(<span key={i} className="text-emerald-300">{tok}</span>); return; }
    parts.push(<span key={i} className="text-neutral-300">{tok}</span>);
  });

  return <>{parts}</>;
}

// ── Main component ─────────────────────────────────────────────────────────────
export function QuantaXscanTerminal({ className }: { className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  const inView = useInView(rootRef as React.RefObject<HTMLElement>);

  const [phase, setPhase] = useState<"idle"|"cmd"|"typing"|"scanning"|"done">("idle");
  const [cmdText, setCmdText] = useState("");
  const [visibleLines, setVisibleLines] = useState(0);
  const [flaggedLines, setFlaggedLines] = useState<Set<number>>(new Set());
  const [visibleFindings, setVisibleFindings] = useState(0);
  const [cursorOn, setCursorOn] = useState(true);

  const FULL_CMD = "quantaxscan scan ./crypto_utils.py";

  const animateRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearT = () => { if (animateRef.current) clearTimeout(animateRef.current); };

  // Cursor blink
  useEffect(() => {
    const id = setInterval(() => setCursorOn(v => !v), 530);
    return () => clearInterval(id);
  }, []);

  // Scroll code into view as lines appear
  useEffect(() => {
    if (codeRef.current) codeRef.current.scrollTop = codeRef.current.scrollHeight;
  }, [visibleLines, visibleFindings]);

  const run = useCallback(() => {
    setPhase("cmd");
    let ci = 0;
    const typeCmd = () => {
      if (ci <= FULL_CMD.length) {
        setCmdText(FULL_CMD.slice(0, ci));
        ci++;
        animateRef.current = setTimeout(typeCmd, 55 + Math.random() * 25);
      } else {
        animateRef.current = setTimeout(() => {
          setPhase("typing");
          let li = 0;
          const showLine = () => {
            setVisibleLines(li + 1);
            const line = CODE_LINES[li];
            if (line.vuln) {
              animateRef.current = setTimeout(() => {
                setFlaggedLines(prev => new Set([...prev, li]));
                li++;
                if (li < CODE_LINES.length) {
                  animateRef.current = setTimeout(showLine, 120);
                } else {
                  animateRef.current = setTimeout(startScan, 600);
                }
              }, 300);
            } else {
              li++;
              if (li < CODE_LINES.length) {
                animateRef.current = setTimeout(showLine, 90);
              } else {
                animateRef.current = setTimeout(startScan, 600);
              }
            }
          };
          showLine();
        }, 400);
      }
    };
    typeCmd();
  }, []);

  const startScan = () => {
    setPhase("scanning");
    let fi = 0;
    const addFinding = () => {
      setVisibleFindings(fi + 1);
      fi++;
      if (fi < FINDINGS.length) {
        animateRef.current = setTimeout(addFinding, 350);
      } else {
        animateRef.current = setTimeout(() => setPhase("done"), 400);
      }
    };
    animateRef.current = setTimeout(addFinding, 500);
  };

  useEffect(() => {
    if (inView && phase === "idle") {
      animateRef.current = setTimeout(run, 800);
    }
    return clearT;
  }, [inView, phase, run]);

  const cmdDone = phase !== "cmd";

  return (
    <div
      ref={rootRef}
      className={cn("w-full h-full bg-[#0d0d14] font-mono text-[11px] flex flex-col overflow-hidden", className)}
    >
      {/* Title bar */}
      <div className="flex items-center gap-2 bg-[#1a1a26] px-3 py-2 border-b border-white/8 shrink-0">
        <div className="flex gap-1.5">
          <div className="h-2.5 w-2.5 rounded-full bg-red-500/90" />
          <div className="h-2.5 w-2.5 rounded-full bg-yellow-500/90" />
          <div className="h-2.5 w-2.5 rounded-full bg-green-500/90" />
        </div>
        <span className="flex-1 text-center text-[10px] text-neutral-400 tracking-wide">quantaxscan — bash — crypto_utils.py</span>
        <div className="w-10" />
      </div>

      <div ref={codeRef} className="flex-1 overflow-y-auto p-3 space-y-0.5 scrollbar-hide">

        {/* Prompt line */}
        {phase !== "idle" && (
          <div className="flex items-center gap-1 mb-1.5">
            <span className="text-violet-400 font-semibold">quantaxscan</span>
            <span className="text-neutral-500">:</span>
            <span className="text-sky-400">~</span>
            <span className="text-neutral-500">$</span>
            <span className="ml-1 text-neutral-200">{cmdText}</span>
            {phase === "cmd" && (
              <span className={cn("inline-block h-3 w-1.5 bg-neutral-300 align-middle ml-0.5 transition-opacity", !cursorOn && "opacity-0")} />
            )}
          </div>
        )}

        {/* Code lines */}
        {cmdDone && (
          <div className="mb-2">
            <div className="text-neutral-500 text-[10px] mb-1 select-none">— crypto_utils.py ——————————————</div>
            {CODE_LINES.slice(0, visibleLines).map((line, i) => {
              const flagged = flaggedLines.has(i);
              const sev = line.vuln?.severity;
              const s = sev ? SEVERITY_STYLES[sev] : null;
              return (
                <div key={i} className="relative flex items-start leading-[1.6]">
                  <span className="w-6 shrink-0 text-right text-neutral-600 select-none mr-2">{i + 1}</span>
                  <div className={cn(
                    "flex-1 px-1.5 rounded-sm transition-all duration-300",
                    flagged && s && `${s.badge} ${s.glow} border-l-2 ml-0 pr-1`,
                  )}>
                    <PythonLine text={line.text} />
                    {flagged && line.vuln && (
                      <motion.span
                        initial={{ opacity: 0, x: -4 }}
                        animate={{ opacity: 1, x: 0 }}
                        className={cn("ml-2 text-[9px] font-bold px-1.5 py-0.5 rounded border", s?.badge)}
                      >
                        ⚠ {line.vuln.label}
                      </motion.span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Scan output */}
        <AnimatePresence>
          {phase === "scanning" || phase === "done" ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="border-t border-white/8 pt-2 mt-1"
            >
              <div className="text-neutral-500 text-[10px] mb-1.5">— quantaxscan findings ———————————————</div>
              {FINDINGS.slice(0, visibleFindings).map((f, i) => {
                const s = SEVERITY_STYLES[f.severity];
                return (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.25 }}
                    className={cn("flex items-start gap-2 mb-1.5 px-2 py-1 rounded border", s.badge, s.glow)}
                  >
                    <div className={cn("mt-0.5 h-1.5 w-1.5 rounded-full shrink-0", s.dot)} />
                    <div className="flex-1 min-w-0">
                      <span className="font-bold">{f.severity}</span>
                      <span className="text-neutral-300 mx-1">·</span>
                      <span className="text-neutral-200">{f.label}</span>
                      <div className="text-[9px] text-neutral-400 mt-0.5">→ {f.fix}</div>
                    </div>
                  </motion.div>
                );
              })}
              {phase === "done" && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.3 }}
                  className="mt-2 flex items-center gap-2 text-[10px]"
                >
                  <div className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                  <span className="text-red-400 font-semibold">
                    {FINDINGS.filter(f => f.severity === "CRITICAL").length} critical &nbsp;·&nbsp;
                    {FINDINGS.filter(f => f.severity === "HIGH").length} high &nbsp;·&nbsp;
                    <span className="text-neutral-400">Replace with NIST PQC standards</span>
                  </span>
                </motion.div>
              )}
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* Idle cursor after done */}
        {phase === "done" && (
          <div className="flex items-center gap-1 mt-2">
            <span className="text-violet-400 font-semibold">quantaxscan</span>
            <span className="text-neutral-500">:</span>
            <span className="text-sky-400">~</span>
            <span className="text-neutral-500">$</span>
            <span className={cn("inline-block h-3 w-1.5 bg-neutral-300 align-middle ml-1 transition-opacity", !cursorOn && "opacity-0")} />
          </div>
        )}
      </div>
    </div>
  );
}
