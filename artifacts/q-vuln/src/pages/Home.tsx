import { useEffect, useState, useRef } from "react";
import { useGetGlobalStats, useListDemoRepos } from "@workspace/api-client-react";
import { Shield, Zap, Code, TrendingUp, AlertTriangle, Terminal, GitBranch, Lock, ChevronRight, Cpu, Atom } from "lucide-react";
import { motion, AnimatePresence, useMotionValue, useSpring, useTransform } from "framer-motion";
import { Link } from "wouter";
import { Typewriter } from "@/components/Typewriter";
import { DevJoke, KonamiEgg, StatusDot } from "@/components/EasterEggs";
import { GalaxyBackground } from "@/components/GalaxyBackground";

// ── Scroll-reveal wrapper ─────────────────────────────────────────────────────
function Reveal({
  children, className, delay = 0, y = 28, x = 0, scale = 1,
}: {
  children: React.ReactNode; className?: string;
  delay?: number; y?: number; x?: number; scale?: number;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y, x, scale }}
      whileInView={{ opacity: 1, y: 0, x: 0, scale: 1 }}
      viewport={{ once: true, margin: "-50px" }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1], delay }}
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

  useEffect(() => {
    const unsub = spring.on("change", (v) => setDisplay(Math.round(v)));
    return unsub;
  }, [spring]);

  return (
    <motion.span
      onViewportEnter={() => {
        if (!hasAnimated.current) { hasAnimated.current = true; mv.set(value); }
      }}
      viewport={{ once: true }}
    >
      {display.toLocaleString()}
    </motion.span>
  );
}

// ── Terminal demo block ───────────────────────────────────────────────────────
function TerminalBlock() {
  const [lines, setLines] = useState<{ text: string; color?: string }[]>([]);
  const SEQUENCE = [
    { text: "$ q-bitron scan ./src --recursive", color: "#7ab3ff" },
    { text: "  Analyzing cryptographic primitives...", color: "#475569" },
    { text: "  [████████████░░░░] 78% — crypto_utils.py", color: "#475569" },
    { text: "  ⚠  RSA-2048 detected on line 42 [CRITICAL]", color: "#f87171" },
    { text: "  ⚠  ECDH-256 detected on line 91 [CRITICAL]", color: "#f87171" },
    { text: "  ✓  AES-256-GCM on line 103 [SAFE]", color: "#34d399" },
    { text: "  [████████████████] 100% complete", color: "#475569" },
    { text: "  Mapped 2 findings → NIST FIPS 203/204", color: "#4f8ef7" },
    { text: "$ q-bitron fix --apply --standard fips-203", color: "#7ab3ff" },
  ];
  useEffect(() => {
    let i = 0;
    const next = () => {
      if (i < SEQUENCE.length) {
        setLines(prev => [...prev, SEQUENCE[i++]]);
        setTimeout(next, 380 + Math.random() * 180);
      }
    };
    setTimeout(next, 500);
  }, []);

  return (
    <div className="rounded-xl border border-white/8 bg-[#0d1224] overflow-hidden shadow-[0_0_60px_rgba(79,142,247,0.1)]">
      <div className="flex items-center gap-1.5 px-4 py-2.5 bg-[#131d35] border-b border-white/6">
        <div className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <div className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <div className="h-3 w-3 rounded-full bg-[#28c840]" />
        <span className="flex-1 text-center text-[10px] text-[#475569] font-mono tracking-wider">
          q-bitron — quantum vulnerability scanner v2.0
        </span>
      </div>
      <div className="p-5 font-mono text-[12px] space-y-1 min-h-[200px]">
        <AnimatePresence>
          {lines.map((l, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2 }}
              style={{ color: l.color ?? "#94a3b8" }}
            >
              {l.text}
            </motion.div>
          ))}
        </AnimatePresence>
        {lines.length < SEQUENCE.length && (
          <span className="inline-block w-[7px] h-3.5 bg-[#4f8ef7] cursor-blink align-middle"
            style={{ boxShadow: "0 0 8px rgba(79,142,247,0.8)" }} />
        )}
      </div>
    </div>
  );
}

// ── Algorithm threat cards ────────────────────────────────────────────────────
const ALGOS = [
  { name: "RSA-2048",  threat: "Shor's algorithm", eta: "~2027–2035", color: "#f87171" },
  { name: "ECDSA-256", threat: "Shor's algorithm", eta: "~2027–2035", color: "#f87171" },
  { name: "DH-2048",   threat: "Shor's algorithm", eta: "~2027–2035", color: "#f87171" },
  { name: "MD5",       threat: "Grover's algorithm", eta: "Right now",  color: "#fbbf24" },
  { name: "SHA-1",     threat: "Grover's algorithm", eta: "Right now",  color: "#fbbf24" },
];

// ── How it works steps ────────────────────────────────────────────────────────
const HOW_IT_WORKS = [
  {
    step: "01",
    title: "Connect your repo",
    desc: "Drop a GitHub URL or paste code. Python, Java, Go, Rust, TypeScript and more are supported.",
    icon: <GitBranch className="h-5 w-5" />,
    color: "#4f8ef7",
  },
  {
    step: "02",
    title: "Deep static analysis",
    desc: "Every use of RSA, ECDSA, DH, MD5, SHA-1 and other quantum-vulnerable primitives is flagged.",
    icon: <Cpu className="h-5 w-5" />,
    color: "#a78bfa",
  },
  {
    step: "03",
    title: "NIST-mapped remediation",
    desc: "Each finding maps directly to FIPS 203/204/205 with effort estimates and AI guidance.",
    icon: <Shield className="h-5 w-5" />,
    color: "#34d399",
  },
];

// ── Hero taglines that cycle ───────────────────────────────────────────────────
const HERO_TAGLINES = [
  "Your RSA keys die on Q-Day — find them now.",
  "Post-quantum or post-mortem. Your choice.",
  "Shor's algorithm will break your crypto.",
  "Quantum computers break ECDSA in seconds.",
  "We find every vulnerable key before they do.",
];

// ── Space: Floating planet orb ────────────────────────────────────────────────
function PlanetOrb() {
  return (
    <motion.div
      className="absolute pointer-events-none"
      style={{ right: "-2%", top: "8%", zIndex: 2 }}
      initial={{ opacity: 0, scale: 0.7, x: 60 }}
      animate={{ opacity: 1, scale: 1, x: 0 }}
      transition={{ duration: 1.8, ease: [0.22, 1, 0.36, 1], delay: 0.4 }}
    >
      <motion.div
        animate={{ y: [0, -18, 0] }}
        transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
        className="relative"
      >
        {/* Outer atmosphere glow */}
        <div className="absolute inset-0 rounded-full" style={{
          width: 220, height: 220,
          background: "radial-gradient(circle at 38% 38%, rgba(79,142,247,0.18) 0%, rgba(79,142,247,0.06) 50%, transparent 75%)",
          filter: "blur(18px)",
          transform: "scale(1.5)",
        }} />
        {/* Planet body */}
        <div style={{
          width: 220, height: 220,
          borderRadius: "50%",
          background: "radial-gradient(circle at 35% 35%, #1e3a6e 0%, #0d1e40 40%, #050c1f 80%, #020610 100%)",
          boxShadow: "0 0 60px rgba(79,142,247,0.35), 0 0 120px rgba(79,142,247,0.12), inset -30px -20px 60px rgba(0,0,0,0.8)",
          position: "relative",
          overflow: "hidden",
        }}>
          {/* Surface bands */}
          <div style={{
            position: "absolute", inset: 0, borderRadius: "50%",
            background: "linear-gradient(160deg, transparent 30%, rgba(79,142,247,0.07) 50%, transparent 70%)",
          }} />
          {/* Terminator line */}
          <div style={{
            position: "absolute", inset: 0, borderRadius: "50%",
            background: "linear-gradient(to right, transparent 45%, rgba(79,142,247,0.12) 55%, transparent 65%)",
          }} />
          {/* City lights on dark side */}
          {[
            { top: "60%", left: "20%", size: 2 },
            { top: "70%", left: "30%", size: 1.5 },
            { top: "55%", left: "15%", size: 1 },
            { top: "65%", left: "25%", size: 2.5 },
            { top: "75%", left: "18%", size: 1.5 },
          ].map((dot, i) => (
            <motion.div
              key={i}
              animate={{ opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 2 + i * 0.7, repeat: Infinity, delay: i * 0.4 }}
              style={{
                position: "absolute",
                top: dot.top, left: dot.left,
                width: dot.size, height: dot.size,
                borderRadius: "50%",
                background: "#4f8ef7",
                boxShadow: `0 0 ${dot.size * 3}px rgba(79,142,247,0.9)`,
              }}
            />
          ))}
        </div>
        {/* Orbital ring around planet */}
        <div style={{
          position: "absolute",
          top: "50%", left: "50%",
          width: 290, height: 80,
          marginLeft: -145, marginTop: -40,
          border: "1.5px solid rgba(167,139,250,0.3)",
          borderRadius: "50%",
          transform: "rotateX(72deg)",
          boxShadow: "0 0 12px rgba(167,139,250,0.15)",
        }} />
        {/* Orbiting dot */}
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 12, repeat: Infinity, ease: "linear" }}
          style={{
            position: "absolute",
            top: "50%", left: "50%",
            width: 290, height: 80,
            marginLeft: -145, marginTop: -40,
            transform: "rotateX(72deg)",
          }}
        >
          <div style={{
            position: "absolute", top: -3, left: "50%",
            width: 6, height: 6, marginLeft: -3,
            borderRadius: "50%",
            background: "#a78bfa",
            boxShadow: "0 0 10px rgba(167,139,250,0.9)",
          }} />
        </motion.div>
      </motion.div>
    </motion.div>
  );
}

// ── Space: Radar scan rings ────────────────────────────────────────────────────
function RadarRings() {
  return (
    <motion.div
      className="absolute pointer-events-none"
      style={{ left: "-6%", bottom: "5%", zIndex: 2 }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 1.2, delay: 0.8 }}
    >
      <div className="relative" style={{ width: 180, height: 180 }}>
        {/* Static rings */}
        {[1, 0.65, 0.38].map((scale, i) => (
          <div key={i} style={{
            position: "absolute",
            top: "50%", left: "50%",
            width: 180 * scale, height: 180 * scale,
            marginLeft: -(180 * scale) / 2,
            marginTop: -(180 * scale) / 2,
            borderRadius: "50%",
            border: `1px solid rgba(79,142,247,${0.12 + i * 0.06})`,
          }} />
        ))}
        {/* Pulsing rings */}
        {[0, 1, 2].map((i) => (
          <motion.div
            key={`pulse-${i}`}
            initial={{ scale: 0.2, opacity: 0.7 }}
            animate={{ scale: 1.1, opacity: 0 }}
            transition={{ duration: 3, repeat: Infinity, delay: i * 1, ease: "easeOut" }}
            style={{
              position: "absolute",
              top: "50%", left: "50%",
              width: 180, height: 180,
              marginLeft: -90, marginTop: -90,
              borderRadius: "50%",
              border: "1.5px solid rgba(79,142,247,0.5)",
            }}
          />
        ))}
        {/* Sweep arm */}
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
          style={{
            position: "absolute", top: "50%", left: "50%",
            width: 90, height: 1,
            marginTop: -0.5,
            transformOrigin: "0% 50%",
            background: "linear-gradient(to right, rgba(79,142,247,0.8), transparent)",
          }}
        />
        {/* Center dot */}
        <div style={{
          position: "absolute", top: "50%", left: "50%",
          width: 8, height: 8, marginLeft: -4, marginTop: -4,
          borderRadius: "50%",
          background: "#4f8ef7",
          boxShadow: "0 0 12px rgba(79,142,247,0.9)",
        }} />
        {/* Blips */}
        {[
          { angle: 48, r: 0.55 },
          { angle: 130, r: 0.35 },
          { angle: 220, r: 0.7 },
        ].map((blip, i) => {
          const a = (blip.angle * Math.PI) / 180;
          const bx = 90 + Math.cos(a) * 90 * blip.r;
          const by = 90 + Math.sin(a) * 90 * blip.r;
          return (
            <motion.div
              key={`blip-${i}`}
              animate={{ opacity: [0, 1, 0.5, 0] }}
              transition={{ duration: 3.5, repeat: Infinity, delay: i * 1.1, ease: "easeOut" }}
              style={{
                position: "absolute",
                left: bx - 3, top: by - 3,
                width: 6, height: 6,
                borderRadius: "50%",
                background: "#34d399",
                boxShadow: "0 0 8px rgba(52,211,153,0.9)",
              }}
            />
          );
        })}
      </div>
    </motion.div>
  );
}

// ── Space: Floating quantum particles ─────────────────────────────────────────
function FloatingParticles() {
  const particles = [
    { x: "8%",  startY: "95%", color: "#4f8ef7", size: 3, dur: 8,  delay: 0 },
    { x: "15%", startY: "90%", color: "#a78bfa", size: 2, dur: 11, delay: 1.5 },
    { x: "22%", startY: "88%", color: "#4f8ef7", size: 4, dur: 9,  delay: 0.8 },
    { x: "72%", startY: "92%", color: "#a78bfa", size: 2, dur: 7,  delay: 2 },
    { x: "82%", startY: "85%", color: "#4f8ef7", size: 3, dur: 10, delay: 0.4 },
    { x: "90%", startY: "90%", color: "#34d399", size: 2, dur: 8,  delay: 1.2 },
    { x: "55%", startY: "95%", color: "#a78bfa", size: 2, dur: 12, delay: 3 },
    { x: "42%", startY: "88%", color: "#4f8ef7", size: 3, dur: 9,  delay: 0.6 },
  ];
  return (
    <>
      {particles.map((p, i) => (
        <motion.div
          key={i}
          className="absolute pointer-events-none"
          style={{ left: p.x, top: p.startY, zIndex: 3 }}
          initial={{ opacity: 0, y: 0 }}
          animate={{ opacity: [0, 0.8, 0.8, 0], y: [0, -200, -380, -500] }}
          transition={{
            duration: p.dur, repeat: Infinity, delay: p.delay,
            ease: "linear", times: [0, 0.15, 0.8, 1],
          }}
        >
          <div style={{
            width: p.size, height: p.size, borderRadius: "50%",
            background: p.color,
            boxShadow: `0 0 ${p.size * 4}px ${p.color}`,
          }} />
        </motion.div>
      ))}
    </>
  );
}

// ── Space: Satellite ──────────────────────────────────────────────────────────
function Satellite() {
  return (
    <motion.div
      className="absolute pointer-events-none"
      style={{ zIndex: 3 }}
      initial={{ opacity: 0, x: -80, y: -40 }}
      animate={{ opacity: [0, 0.9, 0.9, 0], x: ["-5%", "110%"], y: ["15%", "35%"] }}
      transition={{ duration: 28, repeat: Infinity, delay: 4, ease: "linear" }}
    >
      <motion.div
        animate={{ rotate: [0, 8, -8, 0] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
      >
        <svg width="38" height="22" viewBox="0 0 38 22" fill="none">
          {/* Body */}
          <rect x="13" y="7" width="12" height="8" rx="2" fill="#1e3a6e" stroke="#4f8ef7" strokeWidth="1"/>
          {/* Solar panels */}
          <rect x="0" y="8" width="11" height="6" rx="1" fill="#0d2040" stroke="#4f8ef7" strokeWidth="0.8" opacity="0.9"/>
          <rect x="27" y="8" width="11" height="6" rx="1" fill="#0d2040" stroke="#4f8ef7" strokeWidth="0.8" opacity="0.9"/>
          {/* Panel grid lines */}
          <line x1="3.5" y1="8" x2="3.5" y2="14" stroke="#4f8ef7" strokeWidth="0.4" opacity="0.5"/>
          <line x1="7" y1="8" x2="7" y2="14" stroke="#4f8ef7" strokeWidth="0.4" opacity="0.5"/>
          <line x1="30.5" y1="8" x2="30.5" y2="14" stroke="#4f8ef7" strokeWidth="0.4" opacity="0.5"/>
          <line x1="34" y1="8" x2="34" y2="14" stroke="#4f8ef7" strokeWidth="0.4" opacity="0.5"/>
          {/* Antenna */}
          <line x1="19" y1="7" x2="19" y2="2" stroke="#a78bfa" strokeWidth="0.8"/>
          <circle cx="19" cy="1.5" r="1.5" fill="#a78bfa" opacity="0.9"/>
          {/* Signal */}
          <motion.g
            animate={{ opacity: [0, 1, 0] }}
            transition={{ duration: 1.5, repeat: Infinity }}
          >
            <path d="M22 4 Q25 2 28 4" stroke="#4f8ef7" strokeWidth="0.8" fill="none" opacity="0.7"/>
            <path d="M23 2 Q26 -1 29 2" stroke="#4f8ef7" strokeWidth="0.6" fill="none" opacity="0.4"/>
          </motion.g>
        </svg>
      </motion.div>
    </motion.div>
  );
}

// ── Space: Data stream columns ────────────────────────────────────────────────
function DataStreams() {
  const streams = [
    { x: "5%",  chars: ["0","1","Q","K","E","Y","0","1"], delay: 0, dur: 4 },
    { x: "94%", chars: ["R","S","A","X","0","1","P","Q"], delay: 1.5, dur: 5 },
    { x: "2%",  chars: ["1","0","0","1","X","Q","1","0"], delay: 3, dur: 6 },
    { x: "97%", chars: ["P","Q","C","0","1","M","L","K"], delay: 2, dur: 4.5 },
  ];
  return (
    <>
      {streams.map((stream, si) => (
        <motion.div
          key={si}
          className="absolute pointer-events-none flex flex-col items-center"
          style={{ left: stream.x, top: 0, zIndex: 2 }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1 + stream.delay, duration: 1 }}
        >
          {stream.chars.map((ch, ci) => (
            <motion.span
              key={ci}
              className="font-mono text-[9px] block leading-relaxed"
              animate={{ opacity: [0.05, 0.35, 0.05] }}
              transition={{
                duration: stream.dur,
                repeat: Infinity,
                delay: stream.delay + ci * (stream.dur / stream.chars.length),
                ease: "easeInOut",
              }}
              style={{ color: ci % 3 === 0 ? "#4f8ef7" : ci % 3 === 1 ? "#a78bfa" : "#1e3a6e" }}
            >
              {ch}
            </motion.span>
          ))}
        </motion.div>
      ))}
    </>
  );
}

// ── Space: Nebula wisps ───────────────────────────────────────────────────────
function NebulaPulse() {
  return (
    <>
      {/* Left nebula bloom */}
      <motion.div
        className="absolute pointer-events-none"
        style={{ left: "-8%", top: "20%", zIndex: 1 }}
        animate={{ opacity: [0.4, 0.7, 0.4], scale: [1, 1.12, 1] }}
        transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
      >
        <div style={{
          width: 300, height: 200,
          borderRadius: "50%",
          background: "radial-gradient(ellipse, rgba(79,142,247,0.12) 0%, rgba(79,142,247,0.04) 50%, transparent 75%)",
          filter: "blur(30px)",
          transform: "rotate(-20deg)",
        }} />
      </motion.div>
      {/* Right nebula bloom */}
      <motion.div
        className="absolute pointer-events-none"
        style={{ right: "-4%", top: "55%", zIndex: 1 }}
        animate={{ opacity: [0.3, 0.6, 0.3], scale: [1, 1.08, 1] }}
        transition={{ duration: 11, repeat: Infinity, ease: "easeInOut", delay: 3 }}
      >
        <div style={{
          width: 260, height: 180,
          borderRadius: "50%",
          background: "radial-gradient(ellipse, rgba(167,139,250,0.14) 0%, rgba(167,139,250,0.04) 50%, transparent 75%)",
          filter: "blur(28px)",
          transform: "rotate(15deg)",
        }} />
      </motion.div>
      {/* Top center subtle glow */}
      <motion.div
        className="absolute pointer-events-none"
        style={{ left: "30%", top: "-5%", zIndex: 1 }}
        animate={{ opacity: [0.2, 0.5, 0.2] }}
        transition={{ duration: 13, repeat: Infinity, ease: "easeInOut", delay: 5 }}
      >
        <div style={{
          width: 400, height: 180,
          borderRadius: "50%",
          background: "radial-gradient(ellipse, rgba(99,121,247,0.1) 0%, transparent 70%)",
          filter: "blur(40px)",
        }} />
      </motion.div>
    </>
  );
}

// ── Space: Quantum entanglement lines ─────────────────────────────────────────
function EntanglementLines() {
  return (
    <svg
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 2 }}
      width="100%" height="100%"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Curved arc — left to right across hero */}
      <motion.path
        d="M -50 400 Q 400 80 900 350 Q 1200 520 1500 200"
        fill="none"
        stroke="rgba(79,142,247,0.12)"
        strokeWidth="1"
        strokeDasharray="6 14"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 3, delay: 1.2, ease: "easeOut" }}
      />
      {/* Second curve — higher */}
      <motion.path
        d="M 200 500 Q 600 100 1100 300 Q 1350 420 1600 180"
        fill="none"
        stroke="rgba(167,139,250,0.08)"
        strokeWidth="0.8"
        strokeDasharray="4 18"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 3.5, delay: 1.8, ease: "easeOut" }}
      />
      {/* Moving pulse dot on first arc */}
      <motion.circle
        r="3"
        fill="#4f8ef7"
        filter="url(#pulseGlow)"
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 1, 0] }}
        transition={{ duration: 4, repeat: Infinity, delay: 2 }}
      >
        <animateMotion
          dur="6s"
          repeatCount="indefinite"
          path="M -50 400 Q 400 80 900 350 Q 1200 520 1500 200"
        />
      </motion.circle>
      <defs>
        <filter id="pulseGlow">
          <feGaussianBlur stdDeviation="3" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
    </svg>
  );
}

// ── Space: Asteroid / space rocks ─────────────────────────────────────────────
function SpaceRocks() {
  const rocks = [
    { size: 6, x: "18%", y: "78%", duration: 22, delay: 0, tilt: 35 },
    { size: 4, x: "75%", y: "82%", duration: 18, delay: 7, tilt: -20 },
    { size: 8, x: "88%", y: "72%", duration: 30, delay: 3, tilt: 55 },
    { size: 3, x: "35%", y: "88%", duration: 15, delay: 11, tilt: -40 },
  ];
  return (
    <>
      {rocks.map((r, i) => (
        <motion.div
          key={i}
          className="absolute pointer-events-none"
          style={{ left: r.x, top: r.y, zIndex: 2 }}
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0.6, 0.6, 0], rotate: [r.tilt, r.tilt + 180], y: [0, -120] }}
          transition={{ duration: r.duration, repeat: Infinity, delay: r.delay, ease: "linear" }}
        >
          <div style={{
            width: r.size, height: r.size * 0.7,
            borderRadius: "45% 55% 40% 60% / 50% 45% 55% 50%",
            background: `rgba(79,142,247,0.4)`,
            boxShadow: `0 0 ${r.size * 2}px rgba(79,142,247,0.3)`,
          }} />
        </motion.div>
      ))}
    </>
  );
}

export function Home() {
  const { data: globalStats } = useGetGlobalStats();
  const { data: demoRepos }   = useListDemoRepos();
  const [timeLeft, setTimeLeft] = useState("608d 00h 00m 00s");
  const [jokeVisible, setJokeVisible] = useState(false);
  const [clickCount, setClickCount]   = useState(0);

  useEffect(() => {
    const target = new Date("2027-01-01T00:00:00Z").getTime();
    const tick = () => {
      const d = target - Date.now();
      if (d <= 0) { setTimeLeft("00d 00h 00m 00s"); return; }
      const days = Math.floor(d / 86400000);
      const hrs  = Math.floor((d % 86400000) / 3600000);
      const mins = Math.floor((d % 3600000) / 60000);
      const secs = Math.floor((d % 60000) / 1000);
      setTimeLeft(`${days}d ${String(hrs).padStart(2,"0")}h ${String(mins).padStart(2,"0")}m ${String(secs).padStart(2,"0")}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const handleBadgeClick = () => {
    const next = clickCount + 1;
    setClickCount(next);
    if (next >= 5) { setJokeVisible(true); setClickCount(0); }
  };

  return (
    <div className="flex-1 flex flex-col w-full relative bg-[#050810]">
      <KonamiEgg />
      {jokeVisible && <DevJoke />}

      {/* ── HERO ─────────────────────────────────────────────────────────── */}
      <section className="relative w-full overflow-hidden" style={{ minHeight: "68vh" }}>
        {/* Galaxy canvas fills the hero */}
        <div className="absolute inset-0 z-0">
          <GalaxyBackground className="absolute inset-0" />
        </div>

        {/* ── Space atmosphere layers ── */}
        <NebulaPulse />
        <EntanglementLines />
        <PlanetOrb />
        <RadarRings />
        <FloatingParticles />
        <Satellite />
        <DataStreams />
        <SpaceRocks />

        {/* Gradient overlays for depth */}
        <div className="absolute inset-0 z-3 pointer-events-none"
          style={{ background: "radial-gradient(ellipse 80% 60% at 50% 50%, rgba(79,142,247,0.07) 0%, transparent 70%)" }} />
        <div className="absolute bottom-0 left-0 right-0 h-40 z-3 pointer-events-none"
          style={{ background: "linear-gradient(to bottom, transparent, #050810)" }} />

        <div className="relative z-10 flex flex-col items-center justify-center px-4 md:px-10 pt-24 pb-16 text-center">

          {/* Q-Day countdown badge */}
          <motion.div
            initial={{ opacity: 0, y: -16, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.5, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
            onClick={handleBadgeClick}
            className="mb-7 inline-flex items-center gap-2 rounded-full border border-[#f87171]/35 bg-[#f87171]/8 px-5 py-1.5 text-xs font-mono font-semibold text-[#f87171] backdrop-blur-sm cursor-pointer select-none hover:border-[#f87171]/55 hover:bg-[#f87171]/14 transition-all"
            title="Click me 5 times 👀"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            EST. Q-DAY:&nbsp;<span className="font-bold tracking-wider tabular-nums">{timeLeft}</span>
            <StatusDot className="ml-1" />
          </motion.div>

          {/* Single-line typewriter headline */}
          <motion.div
            initial={{ opacity: 0, y: 32 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.75, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="max-w-5xl w-full"
          >
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.22] text-blue-glow min-h-[2.5em] flex items-center justify-center">
              <Typewriter
                texts={HERO_TAGLINES}
                speed={38}
                deleteSpeed={22}
                pauseMs={2600}
                loop
              />
            </h1>
          </motion.div>

          {/* Sub-headline */}
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.38 }}
            className="mt-4 text-base md:text-lg text-[#94a3b8] font-mono max-w-xl"
          >
            Scan any codebase for quantum-vulnerable cryptography and get NIST-approved remediation in seconds.
          </motion.p>

          {/* CTA buttons */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.5 }}
            className="mt-8 flex flex-col sm:flex-row items-center gap-4"
          >
            <Link href="/scan">
              <motion.div
                whileHover={{ scale: 1.04, boxShadow: "0 0 40px rgba(79,142,247,0.5)" }}
                whileTap={{ scale: 0.97 }}
                className="inline-flex h-12 items-center justify-center rounded-xl border border-[#4f8ef7] bg-[#4f8ef7]/14 px-8 text-sm font-mono font-bold text-[#4f8ef7] shadow-[0_0_24px_rgba(79,142,247,0.28)] transition-all cursor-pointer"
              >
                <Terminal className="mr-2 h-4 w-4" />
                ./scan --your-repo
              </motion.div>
            </Link>
            <Link href="/demo/paramiko-ssh">
              <motion.div
                whileHover={{ x: 4 }}
                className="inline-flex h-12 items-center justify-center px-8 text-sm font-mono font-medium text-[#94a3b8] hover:text-[#f1f5f9] transition-colors cursor-pointer gap-1"
              >
                <GitBranch className="h-4 w-4 text-[#4f8ef7]/50 mr-1.5" />
                view --demo-scan
                <ChevronRight className="h-3.5 w-3.5 opacity-50" />
              </motion.div>
            </Link>
          </motion.div>

          {/* Floating tech badges */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.8 }}
            className="mt-10 flex flex-wrap items-center justify-center gap-2"
          >
            {["NIST FIPS 203", "ML-KEM", "ML-DSA", "SLH-DSA", "Post-Quantum"].map((tag, i) => (
              <motion.span
                key={tag}
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.9 + i * 0.07 }}
                whileHover={{ scale: 1.08, borderColor: "rgba(79,142,247,0.5)" }}
                className="px-3 py-1 rounded-full text-[10px] font-mono border border-[#4f8ef7]/15 bg-[#4f8ef7]/6 text-[#4f8ef7]/70 tracking-widest uppercase cursor-default"
              >
                {tag}
              </motion.span>
            ))}
          </motion.div>

          {/* Live signal indicator */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.4, duration: 0.6 }}
            className="mt-8 flex items-center gap-6 text-[10px] font-mono text-[#2d3f5c]"
          >
            {[
              { label: "THREATS TRACKED", value: "2,847", color: "#f87171" },
              { label: "QUANTUM READY", value: "FIPS-203", color: "#34d399" },
              { label: "SCAN SPEED", value: "<2s", color: "#4f8ef7" },
            ].map((item, i) => (
              <motion.div
                key={item.label}
                className="flex flex-col items-center gap-0.5"
                animate={{ opacity: [0.5, 1, 0.5] }}
                transition={{ duration: 3, repeat: Infinity, delay: i * 0.8, ease: "easeInOut" }}
              >
                <span style={{ color: item.color }} className="text-sm font-bold tabular-nums">{item.value}</span>
                <span className="tracking-widest text-[8px]">{item.label}</span>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* ── Stats bar ─────────────────────────────────────────────────────── */}
      {globalStats && (
        <section className="border-y border-white/5 bg-[#0d1224]/80 py-12 relative z-10 backdrop-blur-sm overflow-hidden">
          <div className="absolute inset-0 opacity-30 pointer-events-none dot-grid" />
          <div className="container mx-auto px-4 relative">
            <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
              {[
                { icon: <Code className="h-6 w-6 text-[#4f8ef7]" />, value: globalStats.totalReposScanned, label: "Repositories Scanned", color: "#4f8ef7" },
                { icon: <Shield className="h-6 w-6 text-[#f87171]" />, value: globalStats.totalVulnerabilitiesFound, label: "Vulnerabilities Found", color: "#f87171" },
                { icon: <TrendingUp className="h-6 w-6 text-[#34d399]" />, value: globalStats.totalLinesScanned, label: "Lines Analyzed", color: "#34d399" },
              ].map((stat, i) => (
                <Reveal key={stat.label} delay={i * 0.1} y={24}>
                  <motion.div
                    whileHover={{ y: -3, boxShadow: `0 8px 36px ${stat.color}18` }}
                    transition={{ duration: 0.2 }}
                    className="flex flex-col items-center justify-center text-center p-8 rounded-xl border border-white/6 bg-[#050810]/60 cursor-default"
                  >
                    <div className="mb-3 p-2.5 rounded-xl bg-white/4 border border-white/8"
                      style={{ boxShadow: `0 0 16px ${stat.color}18` }}>
                      {stat.icon}
                    </div>
                    <span className="text-4xl font-bold text-[#f1f5f9] font-mono">
                      <AnimatedNumber value={stat.value} />
                    </span>
                    <span className="text-xs font-mono uppercase tracking-widest text-[#475569] mt-2">{stat.label}</span>
                  </motion.div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <section className="container mx-auto px-4 py-20 relative z-10">
        <Reveal className="mb-14 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#4f8ef7]/15 bg-[#4f8ef7]/6 px-4 py-1 text-[10px] font-mono text-[#4f8ef7]/70 tracking-widest uppercase mb-4">
            <Atom className="h-3 w-3" /> how it works
          </div>
          <h2 className="text-3xl font-bold text-[#f1f5f9]">Three steps to quantum safety</h2>
        </Reveal>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {HOW_IT_WORKS.map((step, i) => (
            <Reveal key={step.step} delay={i * 0.12} y={32}>
              <motion.div
                whileHover={{ y: -5, boxShadow: `0 16px 48px ${step.color}14` }}
                transition={{ duration: 0.25 }}
                className="relative p-7 rounded-xl border border-white/6 bg-[#0d1224] h-full overflow-hidden cursor-default"
              >
                <div className="absolute top-4 right-5 text-6xl font-bold font-mono opacity-[0.04] select-none"
                  style={{ color: step.color }}>{step.step}</div>

                <div className="flex items-center gap-3 mb-5">
                  <motion.div
                    whileHover={{ rotate: 10, scale: 1.1 }}
                    className="p-2.5 rounded-xl border"
                    style={{ backgroundColor: step.color + "12", borderColor: step.color + "30", color: step.color }}
                  >
                    {step.icon}
                  </motion.div>
                  <span className="text-xs font-mono text-[#475569] tracking-widest">STEP {step.step}</span>
                </div>
                <h3 className="text-[#f1f5f9] font-semibold text-base mb-2.5">{step.title}</h3>
                <p className="text-sm text-[#94a3b8] leading-relaxed">{step.desc}</p>

                <div className="absolute bottom-0 left-0 h-[2px] w-0 group-hover:w-full transition-all duration-500 rounded-b-xl"
                  style={{ background: `linear-gradient(to right, transparent, ${step.color}, transparent)` }} />
              </motion.div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── Live Terminal Demo ────────────────────────────────────────────── */}
      <section className="bg-[#0d1224]/60 py-20 relative z-10 border-y border-white/5 overflow-hidden">
        <div className="absolute inset-0 pointer-events-none"
          style={{ background: "radial-gradient(ellipse 60% 80% at 80% 50%, rgba(79,142,247,0.04) 0%, transparent 70%)" }} />
        <div className="container mx-auto px-4 relative">
          <Reveal className="mb-10 text-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#4f8ef7]/15 bg-[#4f8ef7]/6 px-4 py-1 text-[10px] font-mono text-[#4f8ef7]/70 tracking-widest uppercase mb-4">
              <Terminal className="h-3 w-3" /> live demo
            </div>
            <h2 className="text-3xl font-bold text-[#f1f5f9]">Watch it find your vulnerabilities</h2>
            <p className="mt-2 text-[#94a3b8] text-sm">Real scanner output, real findings.</p>
          </Reveal>
          <Reveal delay={0.12}>
            <div className="max-w-2xl mx-auto">
              <TerminalBlock />
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Vulnerable Algorithms ────────────────────────────────────────── */}
      <section className="py-20 relative z-10">
        <div className="container mx-auto px-4">
          <Reveal className="mb-12 text-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#f87171]/20 bg-[#f87171]/6 px-4 py-1 text-[10px] font-mono text-[#f87171]/80 tracking-widest uppercase mb-4">
              <AlertTriangle className="h-3 w-3" /> threat matrix
            </div>
            <h2 className="text-3xl font-bold text-[#f1f5f9]">Algorithms on death row</h2>
            <p className="mt-2 text-[#94a3b8] text-sm">These are broken — or soon will be — by quantum computers.</p>
          </Reveal>
          <div className="flex flex-row gap-3 justify-center overflow-x-auto pb-2 scrollbar-hide">
            {ALGOS.map((a, i) => (
              <Reveal key={a.name} delay={i * 0.07} y={16}>
                <motion.div
                  whileHover={{ scale: 1.07, y: -4, boxShadow: `0 12px 36px ${a.color}28` }}
                  whileTap={{ scale: 0.97 }}
                  transition={{ duration: 0.18 }}
                  className="rounded-xl border px-5 py-4 font-mono text-center shrink-0 cursor-default"
                  style={{ borderColor: a.color + "2a", backgroundColor: a.color + "09" }}
                >
                  <div className="text-sm font-bold mb-1.5 whitespace-nowrap" style={{ color: a.color }}>{a.name}</div>
                  <div className="text-[10px] text-[#475569] whitespace-nowrap">{a.threat}</div>
                  <div className="text-[10px] mt-0.5 font-semibold whitespace-nowrap" style={{ color: a.color + "99" }}>{a.eta}</div>
                </motion.div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Featured Demos ───────────────────────────────────────────────── */}
      <section className="bg-[#0d1224]/60 py-20 relative z-10 border-y border-white/5">
        <div className="container mx-auto px-4">
          <Reveal className="mb-12 text-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#4f8ef7]/15 bg-[#4f8ef7]/6 px-4 py-1 text-[10px] font-mono text-[#4f8ef7]/70 tracking-widest uppercase mb-4">
              <Code className="h-3 w-3" /> real world scans
            </div>
            <h2 className="text-3xl font-bold text-[#f1f5f9]">Demo Repos. Scanned.</h2>
            <p className="mt-2 text-[#94a3b8] text-sm">You'd be surprised what we find.</p>
          </Reveal>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {demoRepos?.map((repo, i) => (
              <Reveal key={repo.slug} delay={i * 0.08} y={32} scale={0.97}>
                <Link href={`/demo/${repo.slug}`}>
                  <motion.div
                    whileHover={{ y: -5, boxShadow: "0 16px 48px rgba(79,142,247,0.14)", borderColor: "rgba(79,142,247,0.28)" }}
                    transition={{ duration: 0.22 }}
                    className="group relative flex h-full flex-col overflow-hidden rounded-xl border border-white/6 bg-[#050810] p-6 cursor-pointer transition-colors"
                  >
                    <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-[#4f8ef7]/20 to-transparent" />

                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-base font-bold text-[#f1f5f9] font-mono">{repo.name}</h3>
                      <div className="flex items-center rounded-lg bg-[#131d35] px-2 py-1 text-[10px] font-mono text-[#94a3b8] border border-white/6">
                        <span className="h-1.5 w-1.5 rounded-full bg-[#4f8ef7]/70 mr-1.5 animate-pulse" />
                        {repo.language}
                      </div>
                    </div>
                    <p className="text-xs text-[#94a3b8] mb-5 flex-1 font-mono leading-relaxed">{repo.description}</p>
                    <div className="flex items-center justify-between border-t border-white/5 pt-4">
                      <div className="flex items-center space-x-4">
                        <div className="flex items-center text-[#f87171] font-mono text-xs font-semibold">
                          <AlertTriangle className="mr-1.5 h-3.5 w-3.5" />
                          {repo.criticalCount}
                        </div>
                        <div className="flex items-center text-[#fbbf24] font-mono text-xs font-semibold">
                          <Zap className="mr-1.5 h-3.5 w-3.5" />
                          {repo.alertCount}
                        </div>
                      </div>
                      <motion.div
                        whileHover={{ x: 4 }}
                        className="text-[11px] font-mono text-[#475569] group-hover:text-[#4f8ef7] transition-colors flex items-center gap-0.5"
                      >
                        view scan <ChevronRight className="h-3 w-3" />
                      </motion.div>
                    </div>
                  </motion.div>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Activity Feed ────────────────────────────────────────────────── */}
      {globalStats?.recentActivity && globalStats.recentActivity.length > 0 && (
        <section className="container mx-auto px-4 py-14 relative z-10">
          <Reveal>
            <div className="rounded-xl border border-white/6 bg-[#0d1224] p-6 max-w-2xl mx-auto overflow-hidden relative">
              <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-[#34d399]/25 to-transparent" />
              <div className="mb-4 flex items-center space-x-2">
                <div className="h-2 w-2 rounded-full bg-[#34d399] animate-pulse" />
                <h3 className="text-[10px] font-mono font-semibold uppercase tracking-widest text-[#475569]">
                  live.activity_feed
                </h3>
              </div>
              <div className="space-y-3 font-mono text-xs">
                {globalStats.recentActivity.slice(0, 5).map((activity, i) => (
                  <Reveal key={activity.id} delay={i * 0.07} x={-16} y={0}>
                    <div className="flex items-start space-x-4">
                      <span className="text-[#2d3f5c] shrink-0 tabular-nums">{new Date(activity.timestamp).toLocaleTimeString()}</span>
                      <span className={`shrink-0 h-1.5 w-1.5 mt-1.5 rounded-full ${
                        activity.severity === "critical" ? "bg-[#f87171] shadow-[0_0_4px_#f87171]" :
                        activity.severity === "alert" ? "bg-[#fbbf24] shadow-[0_0_4px_#fbbf24]" : "bg-[#34d399] shadow-[0_0_4px_#34d399]"
                      }`} />
                      <span className="text-[#94a3b8] leading-relaxed">{activity.description}</span>
                    </div>
                  </Reveal>
                ))}
              </div>
            </div>
          </Reveal>
        </section>
      )}

      {/* ── CTA strip ────────────────────────────────────────────────────── */}
      <section className="relative z-10 border-t border-white/5 py-24 overflow-hidden">
        <div className="absolute inset-0 z-0">
          <GalaxyBackground className="absolute inset-0 opacity-60" />
        </div>
        <div className="absolute inset-0 z-1 pointer-events-none"
          style={{ background: "radial-gradient(ellipse 70% 80% at 50% 50%, rgba(79,142,247,0.06) 0%, transparent 70%)" }} />

        <div className="container mx-auto px-4 text-center relative z-10">
          <Reveal>
            <motion.div
              whileHover={{ scale: 1.08, rotate: 5 }}
              transition={{ duration: 0.3 }}
              className="inline-block mb-6"
            >
              <div className="h-14 w-14 rounded-2xl border border-[#4f8ef7]/25 bg-[#4f8ef7]/10 flex items-center justify-center mx-auto"
                style={{ boxShadow: "0 0 30px rgba(79,142,247,0.2)" }}>
                <Lock className="h-7 w-7 text-[#4f8ef7]" />
              </div>
            </motion.div>
            <h2 className="text-4xl font-bold text-[#f1f5f9] mb-3">
              Q-Day is{" "}
              <span className="text-blue-glow font-mono tabular-nums">{timeLeft}</span>{" "}
              away.
            </h2>
            <p className="text-[#94a3b8] font-mono text-sm mb-10">
              // every day without a scan is a day closer to a breach
            </p>
            <Link href="/scan">
              <motion.div
                whileHover={{ scale: 1.05, boxShadow: "0 0 60px rgba(79,142,247,0.6)" }}
                whileTap={{ scale: 0.97 }}
                className="inline-flex items-center justify-center rounded-xl border border-[#4f8ef7] bg-[#4f8ef7]/12 px-12 py-3.5 text-sm font-mono font-bold text-[#4f8ef7] shadow-[0_0_30px_rgba(79,142,247,0.3)] transition-all cursor-pointer"
              >
                Start Scanning Now <ChevronRight className="ml-2 h-4 w-4" />
              </motion.div>
            </Link>
          </Reveal>
        </div>
      </section>
    </div>
  );
}
