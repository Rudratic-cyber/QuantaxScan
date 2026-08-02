import { useEffect, useState, useRef, useCallback } from "react";
import { useGetGlobalStats, useListProjects, useListCommunityPosts, useVoteCommunityPost } from "@workspace/api-client-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Shield, AlertTriangle, CheckCircle, Zap, ShieldCheck, Terminal,
  ChevronDown, RefreshCw, Folder, BrainCircuit, Users, MessageSquare,
  ThumbsUp, ThumbsDown, TrendingUp, Clock, Target, Award, Sparkles,
  FileCode2, Activity, BarChart3, Layers, ChevronRight, ArrowUpRight,
  Download,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, PieChart, Pie, RadialBarChart, RadialBar, Legend,
  AreaChart, Area,
} from "recharts";
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";
import { apiUrl } from "@/lib/api";

// ── THEME: Quantum Void + Cyber Galaxy (clean mix) ──
const THEME = {
  bg: { dark: "#0a0e1f", darker: "#050810" },
  cyan: "#00d9ff",
  pink: "#ff006e",
  yellow: "#ffbe0b",
  green: "#00ff88",
  blue: "#3a86ff",
  magenta: "#ff00ff",
};

// ── helpers ──────────────────────────────────────────────────────────────────
function cn(...classes: (string | false | undefined | null)[]) {
  return classes.filter(Boolean).join(" ");
}

function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1], delay }}
    >
      {children}
    </motion.div>
  );
}

// ── types ─────────────────────────────────────────────────────────────────────
interface ProjectFinding {
  id: number; scanId: number; fileName: string; lineNumber: number;
  severity: "critical" | "alert" | "safe"; algorithm: string;
  codeSnippet: string; explanation: string;
}

// ── data hooks ────────────────────────────────────────────────────────────────
function useProjectFindings(projectId: number | null) {
  const [findings, setFindings] = useState<ProjectFinding[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!projectId) { setFindings([]); return; }
    setLoading(true);
    fetch(apiUrl(`/api/projects/${projectId}/findings`))
      .then(r => r.ok ? r.json() as Promise<ProjectFinding[]> : [])
      .then(data => { setFindings(data); setLoading(false); })
      .catch(() => { setFindings([]); setLoading(false); });
  }, [projectId]);
  return { findings, loading };
}

// ── mini components ───────────────────────────────────────────────────────────
function RiskRing({ score }: { score: number }) {
  const [isHovering, setIsHovering] = useState(false);
  const color = score > 75 ? THEME.pink : score > 40 ? THEME.yellow : THEME.green;
  const label = score > 75 ? "CRITICAL" : score > 40 ? "ELEVATED" : "LOW";
  const description = score > 75 ? "Immediate action required" : score > 40 ? "Review recommended" : "Low exposure";
  const r = 52; const circ = 2 * Math.PI * r;
  const offset = circ - (score / 100) * circ;
  return (
    <div 
      className="relative flex items-center justify-center" 
      style={{ width: 140, height: 140 }}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      <svg className="-rotate-90 absolute inset-0 w-full h-full">
        <circle cx="70" cy="70" r={r} stroke="rgba(79,142,247,0.08)" strokeWidth="10" fill="none" />
        <motion.circle
          cx="70" cy="70" r={r} stroke={color} strokeWidth="10" fill="none"
          strokeDasharray={circ}
          initial={{ strokeDashoffset: circ }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 1.6, ease: "easeOut" }}
          strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 8px ${color}77)` }}
        />
      </svg>
      <div className="relative flex flex-col items-center z-10">
        <motion.span
          initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
          className="text-3xl font-bold font-mono" style={{ color }}
        >{score}</motion.span>
        <span className="text-[8px] font-mono tracking-widest mt-0.5" style={{ color: color + "99" }}>{label}</span>
        <span className="text-[8px] font-mono text-[#475569] tracking-widest">RISK</span>
      </div>

      {/* Tooltip */}
      <AnimatePresence>
        {isHovering && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.95 }}
            animate={{ opacity: 1, y: -12, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="absolute top-full mt-3 bg-[#0a0e1f] rounded-lg border pointer-events-none whitespace-nowrap z-50 px-3 py-2"
            style={{
              borderColor: color + "44",
              boxShadow: `0 4px 12px rgba(0, 0, 0, 0.4), 0 0 20px ${color}22`
            }}
          >
            <div className="text-[10px] font-mono text-[#f1f5f9] font-semibold">{score}% Risk Score</div>
            <div className="text-[9px] font-mono mt-1" style={{ color: color + "cc" }}>{label}</div>
            <div className="text-[8px] font-mono text-[#475569] mt-1">{description}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function StatCard({
  label, value, icon: Icon, color, sub, delay = 0,
}: {
  label: string; value: string | number; icon: React.ElementType;
  color: string; sub?: string; delay?: number;
}) {
  const isNeon = [THEME.cyan, THEME.pink, THEME.yellow, THEME.green].includes(color);
  return (
    <Reveal delay={delay}>
      <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-[#0a0e1f] to-[#050810] p-5 h-full flex flex-col justify-between transition-all hover:shadow-xl"
        style={{
          borderColor: color + "1a",
          boxShadow: `0 4px 12px rgba(0, 0, 0, 0.3), inset 0 1px 0px rgba(${color === THEME.cyan ? "0,217,255" : color === THEME.pink ? "255,0,110" : color === THEME.yellow ? "255,190,11" : "0,255,136"},0.1)`
        }}>
        <div className="absolute -top-4 -right-4 opacity-[0.02]">
          <Icon className="h-20 w-20" style={{ color }} />
        </div>
        <div className="flex items-center gap-2 mb-2">
          <div className="h-6 w-6 rounded-md flex items-center justify-center" style={{ 
            background: color + "12",
            boxShadow: `inset 0 1px 2px ${color}22`
          }}>
            <Icon className="h-3.5 w-3.5" style={{ color }} />
          </div>
          <span className="text-[9px] font-mono uppercase tracking-widest" style={{ color: color + "88" }}>{label}</span>
        </div>
        <div className="text-3xl font-bold font-mono" style={{ color }}>{value}</div>
        {sub && <div className="text-[10px] font-mono mt-1" style={{ color: color + "66" }}>{sub}</div>}
      </div>
    </Reveal>
  );
}

// severity donut — using neon theme colors
const SEVERITY_COLORS = { critical: THEME.pink, alert: THEME.yellow, safe: THEME.green };

function SeverityDonut({ critical, alert, safe }: { critical: number; alert: number; safe: number }) {
  const data = [
    { name: "Critical", value: critical, fill: SEVERITY_COLORS.critical },
    { name: "Alert", value: alert, fill: SEVERITY_COLORS.alert },
    { name: "Safe", value: safe, fill: SEVERITY_COLORS.safe },
  ].filter(d => d.value > 0);
  const total = critical + alert + safe;
  if (data.length === 0) return <div className="flex items-center justify-center h-full text-[#475569] text-xs font-mono">no data</div>;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie data={data} cx="50%" cy="50%" innerRadius={48} outerRadius={68}
          dataKey="value" paddingAngle={3} strokeWidth={1} stroke="#0a0e1f">
          {data.map((entry, i) => <Cell key={i} fill={entry.fill} style={{ filter: `drop-shadow(0 0 8px ${entry.fill}88)` }} />)}
        </Pie>
        <Tooltip
          contentStyle={{ 
            backgroundColor: "#0a0e1f", 
            borderColor: THEME.cyan + "44", 
            borderRadius: 8, 
            fontFamily: "monospace", 
            fontSize: 10, 
            color: "#f1f5f9",
            padding: "8px 12px",
            boxShadow: `0 4px 12px rgba(0, 0, 0, 0.3)` 
          }}
          formatter={(value: number, name: string, props: any) => {
            const percentage = ((value / total) * 100).toFixed(1);
            return [
              <div key="content" className="space-y-1">
                <div className="font-bold text-[#f1f5f9]">{name}</div>
                <div className="text-[9px] font-semibold text-[#00d9ff]">{value} findings</div>
                <div className="text-[9px] font-semibold text-[#00ff88]">{percentage}% of total</div>
              </div>,
              ""
            ];
          }}
          labelStyle={{ color: "#94a3b8", fontFamily: "monospace", fontSize: 9 }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

// algorithm horizontal bar
function AlgoBar({ data }: { data: { name: string; count: number }[] }) {
  const barColors = [THEME.pink, THEME.pink, THEME.yellow, THEME.yellow, THEME.green, THEME.green, THEME.cyan];
  const total = data.reduce((sum, item) => sum + item.count, 0);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ top: 12, right: 24, left: 95, bottom: 12 }}>
        <CartesianGrid strokeDasharray="0" stroke="rgba(0,217,255,0.04)" horizontal={true} vertical={false} />
        <XAxis 
          type="number" 
          stroke="rgba(0,217,255,0.1)" 
          fontSize={10} 
          tickLine={false} 
          axisLine={false} 
          tick={{ fill: "#475569", fontFamily: "monospace", fontSize: 9 }}
          domain={[0, 'dataMax + 100']}
        />
        <YAxis 
          dataKey="name" 
          type="category" 
          fontSize={11} 
          tickLine={false} 
          axisLine={false} 
          width={95} 
          tick={{ fill: "#94a3b8", fontFamily: "monospace", fontSize: 10, fontWeight: 500 }}
        />
        <Tooltip
          contentStyle={{ 
            backgroundColor: "#0a0e1f", 
            borderColor: THEME.cyan + "22", 
            border: `1px solid ${THEME.cyan}22`,
            borderRadius: 8, 
            fontFamily: "monospace", 
            fontSize: 11, 
            color: "#f1f5f9",
            boxShadow: `0 4px 12px rgba(0, 0, 0, 0.3)`,
            padding: "8px 12px"
          }}
          cursor={{ fill: "rgba(0,217,255,0.04)" }}
          formatter={(value: number, name: string, props: any) => {
            const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : "0";
            const algoName = props.payload.name;
            return [
              <div key="content" className="space-y-1">
                <div className="font-bold text-[#f1f5f9]">{algoName}</div>
                <div className="text-[9px] font-semibold text-[#ff006e]">{value.toLocaleString()} occurrences</div>
                <div className="text-[9px] font-semibold text-[#ffbe0b]">{percentage}% of {total.toLocaleString()}</div>
              </div>,
              ""
            ];
          }}
          labelStyle={{ color: "#94a3b8", fontFamily: "monospace", fontSize: 9 }}
        />
        <Bar dataKey="count" radius={[0, 6, 6, 0]} isAnimationActive={true} animationDuration={800}>
          {data.map((_, i) => {
            const color = barColors[i] || THEME.cyan;
            return <Cell key={i} fill={color} style={{ filter: `drop-shadow(0 2px 4px ${color}44)` }} />;
          })}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// file heatmap row
function FileRiskRow({ name, critical, alert, score, onClick }: {
  name: string; critical: number; alert: number; score: number; onClick: () => void;
}) {
  const color = score > 75 ? THEME.pink : score > 40 ? THEME.yellow : THEME.green;
  const pct = Math.min(100, score);
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/4 transition-colors group text-left">
      <FileCode2 className="h-3.5 w-3.5 text-[#475569] shrink-0 group-hover:text-cyan-400 transition-colors" />
      <span className="flex-1 text-[11px] font-mono text-[#94a3b8] truncate group-hover:text-[#f1f5f9] transition-colors">
        {name.split("/").pop()}
      </span>
      <div className="w-24 h-1.5 rounded-full bg-white/8 overflow-hidden shrink-0 border border-white/10">
        <motion.div className="h-full rounded-full" style={{ background: color, width: `${pct}%`, boxShadow: `0 0 8px ${color}66` }}
          initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.8, ease: "easeOut" }} />
      </div>
      {critical > 0 && <span className="text-[10px] font-mono shrink-0 w-8 text-right" style={{ color: THEME.pink }}>{critical}C</span>}
      {alert > 0 && <span className="text-[10px] font-mono shrink-0 w-8 text-right" style={{ color: THEME.yellow }}>{alert}A</span>}
      <ArrowUpRight className="h-3 w-3 text-[#475569] opacity-0 group-hover:opacity-100 transition-opacity" />
    </button>
  );
}

// ── AI Summary ────────────────────────────────────────────────────────────────
function AISummaryPanel({ project, findings }: {
  project: { name: string; language: string; riskScore?: number | null; criticalCount?: number | null; alertCount?: number | null } | null;
  findings: ProjectFinding[];
}) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    if (!project) return;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setText("");
    setDone(false);
    setLoading(true);

    const topAlgos = (() => {
      const m: Record<string, number> = {};
      for (const f of findings) if (f.severity !== "safe") m[f.algorithm] = (m[f.algorithm] ?? 0) + 1;
      return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a]) => a);
    })();

    const prompt = [
      `You are a post-quantum cryptography security expert. Analyze the scan results for project "${project.name}" (${project.language}).`,
      `Risk Score: ${project.riskScore ?? 0}/100. Critical findings: ${project.criticalCount ?? 0}. Alert findings: ${project.alertCount ?? 0}.`,
      topAlgos.length > 0 ? `Vulnerable algorithms detected: ${topAlgos.join(", ")}.` : "",
      `Provide a concise executive summary (3-4 sentences max), then list 3-4 prioritized remediation steps as a bullet list. Use bold for key terms. Be specific and actionable. No preamble.`,
    ].filter(Boolean).join("\n");

    try {
      const res = await fetch(apiUrl("/api/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: prompt, context: "" }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) throw new Error("failed");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done: d, value } = await reader.read();
        if (d) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") break;
          try {
            const parsed = JSON.parse(payload) as { content?: string };
            if (parsed.content) setText(t => t + parsed.content);
          } catch { /* ignore */ }
        }
      }
      setDone(true);
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== "AbortError") setText("Failed to generate summary. Check your API connection.");
      setDone(true);
    } finally {
      setLoading(false);
    }
  }, [project, findings]);

  useEffect(() => {
    if (project && findings.length >= 0) {
      const t = setTimeout(() => { void run(); }, 400);
      return () => clearTimeout(t);
    }
  }, [project?.name]);

  function renderMarkdown(raw: string) {
    return raw.split("\n").map((line, i) => {
      const parts = line.split(/(\*\*[^*]+\*\*)/g);
      const rendered = parts.map((p, j) =>
        p.startsWith("**") && p.endsWith("**")
          ? <strong key={j} className="text-[#f1f5f9] font-semibold">{p.slice(2, -2)}</strong>
          : <span key={j}>{p}</span>
      );
      if (line.startsWith("- ") || line.startsWith("• ")) {
        return (
          <div key={i} className="flex items-start gap-2 mt-1.5">
            <div className="h-1.5 w-1.5 rounded-full bg-[#4f8ef7] mt-[7px] shrink-0" />
            <span>{rendered}</span>
          </div>
        );
      }
      return <div key={i} className={i > 0 ? "mt-1" : ""}>{rendered}</div>;
    });
  }

  if (!project) return (
    <div className="flex flex-col items-center justify-center h-64 text-[#475569] font-mono text-sm">
      <BrainCircuit className="h-8 w-8 mb-3 opacity-30" />
      <p>Select a project to generate AI analysis</p>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg flex items-center justify-center" style={{ background: THEME.cyan + "15", border: `1px solid ${THEME.cyan}33` }}>
            <BrainCircuit className="h-4 w-4" style={{ color: THEME.cyan }} />
          </div>
          <div>
            <p className="text-[9px] font-mono uppercase tracking-widest" style={{ color: THEME.cyan + "88" }}>// ai_analysis</p>
            <h3 className="text-sm font-bold text-[#f1f5f9]">QuantaXscan Intelligence Report</h3>
          </div>
        </div>
        <button onClick={() => { void run(); }}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#4f8ef7]/30 text-[#4f8ef7]/70 text-[11px] font-mono hover:border-[#4f8ef7]/60 hover:text-[#4f8ef7] transition-colors disabled:opacity-40">
          <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
          {loading ? "Analyzing…" : "Re-analyze"}
        </button>
      </div>

      {/* project context pill */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-white/8 bg-white/3 text-[10px] font-mono text-[#94a3b8]">
          <Folder className="h-3 w-3 text-[#4f8ef7]" />{project.name}
        </span>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-white/8 bg-white/3 text-[10px] font-mono text-[#94a3b8]">
          <FileCode2 className="h-3 w-3 text-[#94a3b8]" />{project.language}
        </span>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-white/8 bg-white/3 text-[10px] font-mono"
          style={{ color: (project.riskScore ?? 0) > 75 ? "#f87171" : (project.riskScore ?? 0) > 40 ? "#fbbf24" : "#34d399" }}>
          <Activity className="h-3 w-3" />Risk {project.riskScore ?? 0}/100
        </span>
      </div>

      {/* output */}
      <div className="rounded-2xl border border-white/6 bg-gradient-to-b from-[#0a0e1f] to-[#050810] p-5" style={{
        boxShadow: `0 4px 12px rgba(0, 0, 0, 0.3), inset 0 1px 0px rgba(0,217,255,0.08)`
      }}>
        {loading && text.length === 0 ? (
          <div className="flex items-center gap-3 text-[#475569] font-mono text-sm py-6">
            <div className="flex gap-1">
              {[0, 0.15, 0.3].map((d, i) => (
                <motion.div key={i} className="h-1.5 w-1.5 rounded-full bg-[#4f8ef7]/60"
                  animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, delay: d, repeat: Infinity }} />
              ))}
            </div>
            <span>Analyzing security posture…</span>
          </div>
        ) : (
          <div className="text-[12px] font-mono text-[#94a3b8] leading-relaxed space-y-0.5">
            {renderMarkdown(text)}
            {loading && (
              <motion.span className="inline-block h-3.5 w-0.5 bg-[#4f8ef7] ml-0.5 align-middle"
                animate={{ opacity: [1, 0] }} transition={{ duration: 0.6, repeat: Infinity }} />
            )}
          </div>
        )}
        {done && text.length > 0 && (
          <div className="flex items-center gap-1.5 mt-3 pt-2 border-t border-white/5">
            <Sparkles className="h-3 w-3 text-[#4f8ef7]/50" />
            <span className="text-[9px] font-mono text-[#2d3f5c] uppercase tracking-widest">Powered by QuantaXscan AI</span>
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Run New Scan", href: "/scan", icon: Terminal, color: "#4f8ef7" },
          { label: "Full Report", href: "/community", icon: BarChart3, color: "#a78bfa" },
          { label: "Community Help", href: "/community", icon: Users, color: "#34d399" },
        ].map(({ label, href, icon: Icon, color }) => (
          <Link key={label} href={href}
            className="flex flex-col items-center gap-2 p-3 rounded-2xl border border-white/6 bg-[#0a0e1e] hover:border-white/12 transition-all group text-center hover:shadow-lg" style={{ boxShadow: `0 2px 8px rgba(0, 0, 0, 0.2)` }}>
            <div className="h-7 w-7 rounded-lg flex items-center justify-center" style={{ background: color + "12", boxShadow: `inset 0 1px 2px ${color}22` }}>
              <Icon className="h-3.5 w-3.5" style={{ color }} />
            </div>
            <span className="text-[10px] font-mono text-[#475569] group-hover:text-[#94a3b8] transition-colors">{label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ── Community Intel ───────────────────────────────────────────────────────────
function CommunityIntel({ project, findings }: {
  project: { name: string; language: string } | null;
  findings: ProjectFinding[];
}) {
  const { data: allPosts, refetch } = useListCommunityPosts();
  const { mutate: votePost } = useVoteCommunityPost();

  // Build relevance score for each post
  const projectAlgos = (() => {
    const s = new Set<string>();
    for (const f of findings) if (f.severity !== "safe") s.add(f.algorithm.toLowerCase());
    return s;
  })();
  const projectLang = project?.language?.toLowerCase() ?? "";

  const scored = (allPosts ?? []).map(post => {
    let score = 0;
    const text = (post.title + " " + (post.content ?? "")).toLowerCase();
    if (post.language?.toLowerCase() === projectLang) score += 5;
    if (text.includes(projectLang)) score += 2;
    for (const algo of projectAlgos) {
      if (text.includes(algo)) score += 4;
    }
    // boost questions/migration stories
    if (post.type === "migration-story") score += 1;
    if (post.upvotes - post.downvotes > 3) score += 1;
    return { ...post, relevance: score };
  }).sort((a, b) => b.relevance - a.relevance);

  const relevant = scored.filter(p => p.relevance > 0);
  const fallback = scored.filter(p => p.relevance === 0).slice(0, 3);
  const shown = relevant.length > 0 ? relevant.slice(0, 8) : fallback;

  const TYPE_COLOR: Record<string, string> = {
    article: "#4f8ef7",
    question: "#fbbf24",
    "migration-story": "#34d399",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="h-8 w-8 rounded-lg flex items-center justify-center" style={{ background: THEME.cyan + "15", border: `1px solid ${THEME.cyan}33` }}>
          <Users className="h-4 w-4" style={{ color: THEME.cyan }} />
        </div>
        <div>
          <p className="text-[9px] font-mono uppercase tracking-widest" style={{ color: THEME.cyan + "88" }}>// community_intel</p>
          <h3 className="text-sm font-bold text-[#f1f5f9]">
            {project ? `Posts relevant to ${project.name}` : "Community Discussions"}
          </h3>
        </div>
        {project && relevant.length > 0 && (
          <span className="ml-auto text-[10px] font-mono text-[#4f8ef7]/60 border border-[#4f8ef7]/20 rounded-full px-2 py-0.5">
            {relevant.length} matched
          </span>
        )}
      </div>

      {project && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[9px] font-mono text-[#475569] uppercase tracking-widest">Filtering by:</span>
          <span className="px-2 py-0.5 rounded-full border border-[#4f8ef7]/25 bg-[#4f8ef7]/8 text-[9px] font-mono text-[#4f8ef7]">
            lang:{project.language}
          </span>
          {[...projectAlgos].slice(0, 4).map(a => (
            <span key={a} className="px-2 py-0.5 rounded-full text-[9px] font-mono" style={{ background: THEME.yellow + "12", border: `1px solid ${THEME.yellow}33`, color: THEME.yellow }}>
              {a}
            </span>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <div className="rounded-2xl border border-white/6 bg-gradient-to-br from-[#0a0e1f] to-[#050810] flex flex-col items-center justify-center py-16 text-center" style={{ boxShadow: `0 4px 12px rgba(0, 0, 0, 0.3)` }}>
          <MessageSquare className="h-8 w-8 text-[#2d3f5c] mb-3" />
          <p className="text-sm font-mono text-[#475569]">// no_posts_found</p>
          <p className="text-xs font-mono text-[#2d3f5c] mt-1">Be the first to share knowledge about this vulnerability type</p>
          <Link href="/community"
            className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-mono transition-all" style={{ background: THEME.cyan + "12", border: `1px solid ${THEME.cyan}33`, color: THEME.cyan }}>
            <MessageSquare className="h-3 w-3" /> Go to Community
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {shown.map((post, i) => {
            const tagColor = TYPE_COLOR[post.type] ?? "#4f8ef7";
            const votes = post.upvotes - post.downvotes;
            return (
              <motion.div
                key={post.id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.04 }}
                className="rounded-2xl border border-white/6 bg-gradient-to-br from-[#0a0e1f] to-[#050810] hover:border-white/12 transition-all overflow-hidden flex hover:shadow-lg" style={{ boxShadow: `0 2px 8px rgba(0, 0, 0, 0.2)` }}
              >
                {/* vote strip */}
                <div className="flex flex-col items-center gap-1 px-2.5 py-3 border-r border-white/5 bg-[#050810]/50">
                  <ThumbsUp className="h-3 w-3 text-[#2d3f5c] hover:text-[#4f8ef7] cursor-pointer transition-colors"
                    onClick={() => votePost({ id: post.id, data: { direction: "up" } }, { onSuccess: () => void refetch() })} />
                  <span className={cn("text-[11px] font-mono font-bold", votes > 0 ? "text-[#4f8ef7]" : "text-[#475569]")}>{votes}</span>
                  <ThumbsDown className="h-3 w-3 text-[#2d3f5c] hover:text-red-400 cursor-pointer transition-colors"
                    onClick={() => votePost({ id: post.id, data: { direction: "down" } }, { onSuccess: () => void refetch() })} />
                </div>
                {/* content */}
                <div className="p-3 flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold border uppercase"
                      style={{ color: tagColor, borderColor: tagColor + "30", background: tagColor + "10" }}>
                      {post.type}
                    </span>
                    {post.language && (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-mono border border-white/8 text-[#475569]">
                        {post.language}
                      </span>
                    )}
                    {post.relevance > 5 && (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-mono border border-emerald-500/25 bg-emerald-500/8 text-emerald-500 flex items-center gap-1">
                        <Target className="h-2.5 w-2.5" /> relevant
                      </span>
                    )}
                    <span className="text-[9px] font-mono text-[#2d3f5c] ml-auto">
                      {formatDistanceToNow(new Date(post.createdAt))} ago
                    </span>
                  </div>
                  <h4 className="text-[12px] font-bold text-[#f1f5f9] leading-tight mb-1">{post.title}</h4>
                  <p className="text-[11px] font-mono text-[#475569] leading-relaxed line-clamp-2">{post.content}</p>
                </div>
              </motion.div>
            );
          })}
          <div className="pt-1">
            <Link href="/community"
              className="flex items-center justify-center gap-1.5 py-2 text-[11px] font-mono text-[#475569] hover:text-[#4f8ef7] transition-colors">
              View all community posts <ChevronRight className="h-3 w-3" />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
type DashTab = "overview" | "ai" | "community";

export function Dashboard() {
  const { data: globalStats } = useGetGlobalStats();
  const { data: projects, refetch: refetchProjects } = useListProjects();
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dashTab, setDashTab] = useState<DashTab>("overview");

  const sorted = [...(projects ?? [])].sort((a, b) => {
    if (!a.lastScanAt) return 1;
    if (!b.lastScanAt) return -1;
    return new Date(b.lastScanAt).getTime() - new Date(a.lastScanAt).getTime();
  });

  const project = sorted.find(p => p.id === selectedProjectId) ?? sorted[0] ?? null;

  useEffect(() => {
    if (project && selectedProjectId === null) setSelectedProjectId(project.id);
  }, [project, selectedProjectId]);

  const { findings, loading: findingsLoading } = useProjectFindings(project?.id ?? null);

  // build algo chart
  const algoChart = (() => {
    const counts: Record<string, number> = {};
    for (const f of findings) {
      if (f.severity === "safe") continue;
      counts[f.algorithm] = (counts[f.algorithm] ?? 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([name, count]) => ({ name, count }));
  })();

  // file risk table
  const fileRisk = (() => {
    const map: Record<string, { critical: number; alert: number; score: number }> = {};
    for (const f of findings) {
      if (!map[f.fileName]) map[f.fileName] = { critical: 0, alert: 0, score: 0 };
      if (f.severity === "critical") { map[f.fileName].critical++; map[f.fileName].score += 10; }
      if (f.severity === "alert") { map[f.fileName].alert++; map[f.fileName].score += 4; }
    }
    return Object.entries(map)
      .map(([name, v]) => ({ name, ...v, score: Math.min(100, v.score) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  })();

  // NIST migration suggestions from real algorithms
  const NIST_MAP: Record<string, { replacement: string; standard: string; effort: string; hours: number }> = {
    "RSA": { replacement: "ML-KEM (Kyber)", standard: "NIST FIPS 203", effort: "High", hours: 14 },
    "ECDSA": { replacement: "ML-DSA (Dilithium)", standard: "NIST FIPS 204", effort: "High", hours: 22 },
    "ECDH": { replacement: "ML-KEM (Kyber)", standard: "NIST FIPS 203", effort: "Medium", hours: 10 },
    "Diffie-Hellman": { replacement: "ML-KEM (Kyber)", standard: "NIST FIPS 203", effort: "High", hours: 18 },
    "AES-128": { replacement: "AES-256", standard: "NIST SP 800-38", effort: "Low", hours: 4 },
    "MD5": { replacement: "SHA-3 (FIPS 202)", standard: "NIST FIPS 202", effort: "Low", hours: 2 },
    "SHA-1": { replacement: "SHA-3 (FIPS 202)", standard: "NIST FIPS 202", effort: "Low", hours: 2 },
    "DSA": { replacement: "SLH-DSA (SPHINCS+)", standard: "NIST FIPS 205", effort: "High", hours: 20 },
  };

  const migrationItems = (() => {
    const seen = new Set<string>();
    const items: { algo: string; replacement: string; standard: string; effort: string; hours: number }[] = [];
    for (const f of findings) {
      if (f.severity === "safe") continue;
      const key = f.algorithm.toUpperCase();
      if (!seen.has(key)) {
        seen.add(key);
        const entry = Object.entries(NIST_MAP).find(([k]) => f.algorithm.toUpperCase().includes(k.toUpperCase()));
        if (entry) items.push({ algo: f.algorithm, ...entry[1] });
      }
    }
    return items.slice(0, 5);
  })();

  // Effort breakdown per file
  const effortChart = (() => {
    const map: Record<string, number> = {};
    for (const f of findings) {
      if (f.severity === "safe") continue;
      const entry = Object.entries(NIST_MAP).find(([k]) => f.algorithm.toUpperCase().includes(k.toUpperCase()));
      if (entry) {
        map[f.fileName] = (map[f.fileName] ?? 0) + entry[1].hours;
      }
    }
    return Object.entries(map)
      .map(([name, hours]) => ({ name, hours: Math.min(100, hours) }))
      .sort((a, b) => b.hours - a.hours)
      .slice(0, 15);
  })();

  const riskScore = project?.riskScore ?? 0;
  const critical = project?.criticalCount ?? 0;
  const alerts = project?.alertCount ?? 0;
  const safe = project?.cleanCount ?? 0;
  const totalFindings = critical + alerts;

  // Export report generator
  const handleExportReport = useCallback(() => {
    if (!project) return;
    
    const reportHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QuantaXscan Security Report - ${project.name}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Monaco', 'Menlo', monospace; background: #0a0e1f; color: #f1f5f9; line-height: 1.6; }
    .container { max-width: 900px; margin: 0 auto; padding: 40px 20px; }
    header { border-bottom: 2px solid #00d9ff; padding-bottom: 20px; margin-bottom: 30px; }
    h1 { font-size: 28px; color: #00d9ff; margin-bottom: 5px; }
    .subtitle { color: #475569; font-size: 12px; margin-bottom: 20px; }
    .report-time { color: #2d3f5c; font-size: 11px; }
    
    .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 30px; }
    .stat-card { background: rgba(0, 217, 255, 0.05); border: 1px solid #00d9ff33; padding: 15px; border-radius: 8px; }
    .stat-label { color: #475569; font-size: 10px; text-transform: uppercase; margin-bottom: 8px; }
    .stat-value { font-size: 24px; font-weight: bold; color: #f1f5f9; }
    .stat-critical { color: #ff006e; }
    .stat-alert { color: #ffbe0b; }
    .stat-safe { color: #00ff88; }
    
    section { margin-bottom: 40px; page-break-inside: avoid; }
    h2 { font-size: 14px; color: #00d9ff; text-transform: uppercase; letter-spacing: 0.15em; margin-bottom: 15px; border-bottom: 1px solid #00d9ff44; padding-bottom: 10px; }
    
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12px; }
    th { background: rgba(0, 217, 255, 0.1); color: #00d9ff; padding: 10px; text-align: left; font-weight: bold; border-bottom: 1px solid #00d9ff33; }
    td { padding: 8px 10px; border-bottom: 1px solid #00d9ff11; }
    tr:hover { background: rgba(0, 217, 255, 0.03); }
    
    .severity-critical { color: #ff006e; font-weight: bold; }
    .severity-alert { color: #ffbe0b; font-weight: bold; }
    .severity-safe { color: #00ff88; font-weight: bold; }
    
    .bar { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
    .bar-label { width: 150px; font-size: 11px; color: #94a3b8; }
    .bar-track { flex: 1; height: 20px; background: rgba(255, 255, 255, 0.05); border-radius: 4px; overflow: hidden; border: 1px solid rgba(255, 255, 255, 0.1); }
    .bar-fill { height: 100%; display: flex; align-items: center; justify-content: flex-end; padding-right: 6px; font-size: 10px; color: #f1f5f9; font-weight: bold; }
    
    .effort-high { background: linear-gradient(90deg, #ff006e44, #ff006e); }
    .effort-medium { background: linear-gradient(90deg, #ffbe0b44, #ffbe0b); }
    .effort-low { background: linear-gradient(90deg, #00ff8844, #00ff88); }
    
    .migration-card { background: rgba(0, 217, 255, 0.05); border-left: 3px solid #00d9ff; padding: 12px; margin: 10px 0; border-radius: 4px; }
    .migration-algo { color: #00d9ff; font-weight: bold; }
    .migration-replacement { color: #00ff88; }
    .migration-effort { color: #ffbe0b; }
    
    .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #00d9ff33; color: #475569; font-size: 10px; text-align: center; }
    
    @media print {
      body { background: white; color: #000; }
      .stat-card { border-color: #ccc; background: #f9f9f9; }
      h1, h2 { color: #333; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>QUANTAXSCAN Security Report</h1>
      <p class="subtitle">Post-Quantum Cryptography Vulnerability Assessment</p>
      <div>
        <strong>Project:</strong> ${project.name} (${project.language})<br>
        <span class="report-time">Generated: ${new Date().toLocaleString()}</span>
      </div>
    </header>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Risk Score</div>
        <div class="stat-value">${riskScore}<span style="font-size: 16px;">/100</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Critical</div>
        <div class="stat-value stat-critical">${critical}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Alerts</div>
        <div class="stat-value stat-alert">${alerts}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Safe Files</div>
        <div class="stat-value stat-safe">${safe}</div>
      </div>
    </div>

    ${algoChart.length > 0 ? `
    <section>
      <h2>Vulnerable Algorithms (Top ${Math.min(algoChart.length, 7)})</h2>
      <table>
        <thead>
          <tr>
            <th>Algorithm</th>
            <th style="text-align: right;">Occurrences</th>
            <th style="text-align: right;">% of Findings</th>
          </tr>
        </thead>
        <tbody>
          ${algoChart.map(item => {
            const pct = Math.round((item.count / (critical + alerts)) * 100);
            return `<tr>
              <td><strong style="color: #00d9ff;">${item.name}</strong></td>
              <td style="text-align: right;"><span class="severity-critical">${item.count}</span></td>
              <td style="text-align: right;"><span class="severity-alert">${pct}%</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </section>
    ` : ''}

    ${fileRisk.length > 0 ? `
    <section>
      <h2>File Risk Ranking (Top ${Math.min(fileRisk.length, 10)})</h2>
      <table>
        <thead>
          <tr>
            <th>File Name</th>
            <th style="text-align: right;">Critical</th>
            <th style="text-align: right;">Alert</th>
            <th style="text-align: right;">Risk Score</th>
          </tr>
        </thead>
        <tbody>
          ${fileRisk.map(item => `<tr>
            <td style="word-break: break-all; font-size: 11px;">${item.name}</td>
            <td style="text-align: right;"><span class="severity-critical">${item.critical}</span></td>
            <td style="text-align: right;"><span class="severity-alert">${item.alert}</span></td>
            <td style="text-align: right;"><strong>${item.score}</strong></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </section>
    ` : ''}

    ${effortChart.length > 0 ? `
    <section>
      <h2>Migration Effort by File (Hours Required)</h2>
      ${effortChart.map(item => {
        const pct = item.hours;
        const effortClass = pct > 70 ? 'effort-high' : pct > 40 ? 'effort-medium' : 'effort-low';
        return `<div class="bar">
          <div class="bar-label">${item.name.length > 25 ? item.name.substring(0, 25) + '...' : item.name}</div>
          <div class="bar-track">
            <div class="bar-fill ${effortClass}" style="width: ${pct}%;">${item.hours.toFixed(0)}h</div>
          </div>
        </div>`;
      }).join('')}
    </section>
    ` : ''}

    ${migrationItems.length > 0 ? `
    <section>
      <h2>NIST Migration Recommendations</h2>
      <p style="color: #94a3b8; font-size: 12px; margin-bottom: 15px;">Post-Quantum Safe Alternatives for Detected Algorithms</p>
      ${migrationItems.map(item => `
      <div class="migration-card">
        <div style="margin-bottom: 8px;">
          <span class="migration-algo">${item.algo}</span> → <span class="migration-replacement">${item.replacement}</span>
        </div>
        <div style="font-size: 11px; color: #94a3b8;">
          <strong>Standard:</strong> ${item.standard} | 
          <strong>Effort:</strong> <span class="migration-effort">${item.effort}</span> | 
          <strong>Est. Hours:</strong> <span style="color: #00d9ff;">${item.hours}h</span>
        </div>
      </div>
      `).join('')}
    </section>
    ` : ''}

    <div class="footer">
      <p>QUANTAXSCAN © 2026 | Post-Quantum Security Intelligence Platform</p>
      <p>This report contains sensitive security information. Handle with appropriate confidentiality.</p>
    </div>
  </div>
</body>
</html>`;

    const blob = new Blob([reportHTML], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `QuantaXscan-Report-${project.name.replace(/\s+/g, "-")}-${new Date().toISOString().split("T")[0]}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [project, riskScore, critical, alerts, safe, algoChart, fileRisk, effortChart, migrationItems]);

  const TABS: { key: DashTab; label: string; icon: React.ElementType }[] = [
    { key: "overview", label: "// overview", icon: BarChart3 },
    { key: "ai", label: "// ai_analysis", icon: BrainCircuit },
    { key: "community", label: "// community_intel", icon: Users },
  ];

  return (
    <div className="flex-1 bg-gradient-to-br from-[#0a0e1f] via-[#050810] to-[#0a0e1f] overflow-y-auto relative" onClick={() => setDropdownOpen(false)}>
      {/* Animated background grid effect */}
      <div className="fixed inset-0 opacity-5 pointer-events-none" style={{
        backgroundImage: `linear-gradient(0deg, transparent 24%, rgba(0, 217, 255, 0.05) 25%, rgba(0, 217, 255, 0.05) 26%, transparent 27%, transparent 74%, rgba(0, 217, 255, 0.05) 75%, rgba(0, 217, 255, 0.05) 76%, transparent 77%, transparent),
                          linear-gradient(90deg, transparent 24%, rgba(0, 217, 255, 0.05) 25%, rgba(0, 217, 255, 0.05) 26%, transparent 27%, transparent 74%, rgba(0, 217, 255, 0.05) 75%, rgba(0, 217, 255, 0.05) 76%, transparent 77%, transparent)`,
        backgroundSize: "50px 50px"
      }} />
      
      <div className="container mx-auto px-4 py-8 max-w-7xl relative z-10">

        {/* ── Header ─────────────────────────────────────────── */}
        <Reveal>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
            <div>
              <p className="text-[9px] font-mono text-[#4f8ef7]/50 tracking-[0.2em] mb-1 uppercase">// quantaxscan :: dashboard</p>
              <h1 className="text-2xl font-bold text-[#f1f5f9] tracking-tight">Security Intelligence</h1>
              <p className="text-[#475569] font-mono text-xs mt-1">
                {sorted.length > 0
                  ? `${sorted.length} project${sorted.length !== 1 ? "s" : ""} in scope — ${globalStats?.totalVulnerabilitiesFound.toLocaleString() ?? "—"} total findings`
                  : "No scans yet — run your first scan"}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button onClick={e => { e.stopPropagation(); void refetchProjects(); }}
                className="p-2 rounded-lg border border-white/8 text-[#475569] hover:text-[#f1f5f9] hover:border-white/16 transition-colors"
                title="Refresh projects">
                <RefreshCw className="h-3.5 w-3.5" />
              </button>

              {sorted.length > 0 && project && (
                <button onClick={e => { e.stopPropagation(); handleExportReport(); }}
                  className="p-2 rounded-lg border border-white/8 text-[#475569] hover:text-[#f1f5f9] hover:border-white/16 transition-colors"
                  title="Export comprehensive report">
                  <Download className="h-3.5 w-3.5" />
                </button>
              )}

              {sorted.length > 0 && (
                <div className="relative" onClick={e => e.stopPropagation()}>
                  <button
                    onClick={() => setDropdownOpen(v => !v)}
                    className="flex items-center gap-2 h-9 pl-3 pr-2.5 rounded-lg border border-white/10 bg-[#0d1224] text-[12px] text-[#f1f5f9] font-mono hover:border-white/20 transition-colors min-w-[180px] max-w-[260px]"
                  >
                    <div className="h-2 w-2 rounded-full shrink-0" style={{ background: riskScore > 75 ? THEME.pink : riskScore > 40 ? THEME.yellow : THEME.green }} />
                    <span className="flex-1 text-left truncate">{project?.name ?? "Select project"}</span>
                    <ChevronDown className={cn("h-3 w-3 text-neutral-500 shrink-0 transition-transform", dropdownOpen && "rotate-180")} />
                  </button>

                  {dropdownOpen && (
                    <div className="absolute right-0 top-10 z-50 w-72 rounded-lg border border-white/10 bg-[#0d1224] shadow-2xl overflow-hidden">
                      <div className="px-3 py-2 border-b border-white/6">
                        <p className="text-[9px] font-mono text-[#475569] uppercase tracking-widest">Projects — most recent first</p>
                      </div>
                      <div className="max-h-64 overflow-y-auto">
                        {sorted.map(p => (
                          <button key={p.id}
                            onClick={() => { setSelectedProjectId(p.id); setDropdownOpen(false); }}
                            className={cn("w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-white/5 transition-colors border-b border-white/4 last:border-0",
                              p.id === project?.id && "bg-[#4f8ef7]/8"
                            )}>
                            <div className={cn("h-2 w-2 rounded-full shrink-0",
                              (p.riskScore ?? 0) > 75 ? "bg-red-500" : (p.riskScore ?? 0) > 40 ? "bg-yellow-500" : "bg-emerald-500"
                            )} />
                            <div className="flex-1 min-w-0">
                              <p className={cn("text-[12px] font-mono truncate", p.id === project?.id ? "text-[#4f8ef7]" : "text-[#f1f5f9]")}>{p.name}</p>
                              <p className="text-[10px] text-[#475569] font-mono">{p.language} · {p.criticalCount ?? 0}C {p.alertCount ?? 0}A · risk {p.riskScore ?? 0}</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </Reveal>

        {/* ── Tab bar ─────────────────────────────────────────── */}
        <Reveal delay={0.05}>
          <div className="flex items-center gap-0 mb-6 border-b border-white/6">
            {TABS.map(({ key, label, icon: Icon }) => (
              <button key={key} onClick={() => setDashTab(key)}
                className={cn(
                  "flex items-center gap-2 px-5 py-2.5 text-[11px] font-mono border-b-2 transition-all",
                  dashTab === key
                    ? "border-[#4f8ef7] text-[#4f8ef7]"
                    : "border-transparent text-[#475569] hover:text-[#94a3b8]"
                )}>
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        </Reveal>

        {/* ── Empty state ─────────────────────────────────────── */}
        {sorted.length === 0 ? (
          <Reveal delay={0.1}>
            <div className="rounded-2xl border border-white/6 bg-[#0a0e1e] flex flex-col items-center justify-center py-28 px-8 text-center" style={{ boxShadow: `0 4px 12px rgba(0, 0, 0, 0.3)` }}>
              <div className="h-20 w-20 rounded-2xl bg-[#4f8ef7]/8 border border-[#4f8ef7]/20 flex items-center justify-center mb-6" style={{ boxShadow: `0 4px 12px rgba(79,142,247,0.1)` }}>
                <Shield className="h-10 w-10 text-[#4f8ef7]/50" />
              </div>
              <h2 className="text-lg font-bold text-[#f1f5f9] font-mono mb-2">No scans yet</h2>
              <p className="text-sm text-[#475569] font-mono mb-8 max-w-sm leading-relaxed">
                Upload code or paste a GitHub URL in the scanner to run your first post-quantum security scan.
              </p>
              <Link href="/scan"
                className="inline-flex items-center gap-2 rounded-lg border border-[#4f8ef7] bg-[#4f8ef7]/10 px-6 py-2.5 text-sm font-mono font-bold text-[#4f8ef7] shadow-[0_0_20px_rgba(79,142,247,0.25)] hover:bg-[#4f8ef7]/18 transition-all">
                <Terminal className="h-4 w-4" /> ./scan --now
              </Link>
            </div>
          </Reveal>
        ) : (
          <AnimatePresence mode="wait">

            {/* ════════════════════════════════════════════════════
                TAB: OVERVIEW
            ════════════════════════════════════════════════════ */}
            {dashTab === "overview" && (
              <motion.div key="overview" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.3 }}>

                {/* Stat cards row */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
                  <StatCard label="Risk Score" value={riskScore} icon={Activity} color={riskScore > 75 ? THEME.pink : riskScore > 40 ? THEME.yellow : THEME.green} sub="/ 100 max" delay={0.06} />
                  <StatCard label="Critical" value={critical} icon={AlertTriangle} color={THEME.pink} sub="quantum-vulnerable" delay={0.1} />
                  <StatCard label="Alerts" value={alerts} icon={Zap} color={THEME.yellow} sub="needs attention" delay={0.14} />
                  <StatCard label="Safe" value={safe} icon={CheckCircle} color={THEME.green} sub="files checked" delay={0.18} />
                </div>

                {/* Main content area */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-5">

                  {/* Risk gauge + donut */}
                  <Reveal delay={0.2}>
                    <div className="rounded-2xl border border-white/6 bg-gradient-to-br from-[#0a0e1f] to-[#050810] p-5 flex flex-col h-full" style={{
                      boxShadow: `0 4px 12px rgba(0, 0, 0, 0.3), inset 0 1px 0px rgba(0,217,255,0.08)`
                    }}>
                      <p className="text-[9px] font-mono text-[#00d9ff] uppercase tracking-widest mb-4">Current Exposure</p>
                      <div className="flex items-center justify-center py-4">
                        <RiskRing score={riskScore} />
                      </div>
                      <div className="mt-4 pt-4 border-t border-white/5">
                        <p className="text-[9px] font-mono text-[#00d9ff] uppercase tracking-widest mb-3">Severity Split</p>
                        <div className="h-36">
                          <SeverityDonut critical={critical} alert={alerts} safe={safe} />
                        </div>
                        <div className="flex items-center justify-center gap-4 mt-1">
                          {[[THEME.pink, "Critical", critical], [THEME.yellow, "Alert", alerts], [THEME.green, "Safe", safe]].map(([c, l, v]) => (
                            <div key={l as string} className="flex items-center gap-1.5">
                              <div className="h-2 w-2 rounded-full" style={{ background: c as string, boxShadow: `0 2px 4px ${c}44` }} />
                              <span className="text-[10px] font-mono text-[#475569]">{l} <span style={{ color: c as string }}>{v}</span></span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </Reveal>

                  {/* Algorithm breakdown */}
                  <Reveal delay={0.22}>
                    <div className="lg:col-span-2 rounded-2xl border border-white/6 bg-gradient-to-br from-[#0a0e1f] to-[#050810] p-5 flex flex-col h-full" style={{
                      boxShadow: `0 4px 12px rgba(0, 0, 0, 0.3), inset 0 1px 0px rgba(0,217,255,0.08)`
                    }}>
                      <div className="flex items-center gap-2 mb-4">
                        <p className="text-[9px] font-mono text-[#00d9ff] uppercase tracking-widest flex-1">
                          Vulnerable Algorithms
                          {project && <span className="text-[#2d3f5c] ml-2">— {project.name}</span>}
                        </p>
                        {findingsLoading && <span className="h-3 w-3 border-2 border-[#4f8ef7]/50 border-t-transparent rounded-full animate-spin" />}
                      </div>
                      {algoChart.length > 0 ? (
                        <div className="flex-1 min-h-[220px]">
                          <AlgoBar data={algoChart} />
                        </div>
                      ) : (
                        <div className="flex-1 flex items-center justify-center text-[#2d3f5c] font-mono text-xs">
                          {findingsLoading ? "Loading findings…" : "No algorithm data — run a scan first"}
                        </div>
                      )}
                    </div>
                  </Reveal>

                  {/* Effort breakdown per file */}
                  <Reveal delay={0.24}>
                    <div className="rounded-2xl border border-white/6 bg-gradient-to-br from-[#0a0e1f] to-[#050810] p-5 flex flex-col h-full" style={{
                      boxShadow: `0 4px 12px rgba(0, 0, 0, 0.3), inset 0 1px 0px rgba(0,217,255,0.08)`
                    }}>
                      <div className="flex items-center gap-2 mb-4">
                        <p className="text-[9px] font-mono text-[#00d9ff] uppercase tracking-widest flex-1">
                          Effort Breakdown — Hours Per File
                        </p>
                        {findingsLoading && <span className="h-3 w-3 border-2 border-[#4f8ef7]/50 border-t-transparent rounded-full animate-spin" />}
                      </div>
                      {effortChart.length > 0 ? (
                        <div className="flex-1 overflow-x-auto min-h-[220px] pb-2">
                          <div className="space-y-2 min-w-max pr-2">
                            {effortChart.map((item, i) => {
                              const percentage = item.hours;
                              const barColor = percentage > 70 ? THEME.pink : percentage > 40 ? THEME.yellow : THEME.green;
                              return (
                                <div key={item.name} className="flex items-center gap-3">
                                  <span className="text-[9px] font-mono text-[#94a3b8] w-32 truncate">{item.name}</span>
                                  <div className="flex-1 h-6 bg-white/3 rounded-lg overflow-hidden border border-white/6">
                                    <motion.div
                                      initial={{ width: 0 }}
                                      animate={{ width: `${percentage}%` }}
                                      transition={{ duration: 0.8, ease: "easeOut", delay: i * 0.05 }}
                                      className="h-full rounded-lg"
                                      style={{
                                        background: `linear-gradient(90deg, ${barColor}20, ${barColor})`,
                                        boxShadow: `0 0 12px ${barColor}44`
                                      }}
                                    />
                                  </div>
                                  <span className="text-[9px] font-mono font-semibold text-[#f1f5f9] min-w-[40px] text-right" style={{ color: barColor }}>
                                    {item.hours.toFixed(0)}h
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : (
                        <div className="flex-1 flex items-center justify-center text-[#2d3f5c] font-mono text-xs">
                          {findingsLoading ? "Computing effort…" : "Run a scan to see effort breakdown"}
                        </div>
                      )}
                    </div>
                  </Reveal>
                </div>

                {/* File risk heatmap + migration path */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">

                  {/* File risk heatmap */}
                  <Reveal delay={0.26}>
                    <div className="rounded-2xl border border-white/6 bg-gradient-to-br from-[#0a0e1f] to-[#050810] p-5" style={{
                      boxShadow: `0 4px 12px rgba(0, 0, 0, 0.3), inset 0 1px 0px rgba(0,217,255,0.08)`
                    }}>
                      <div className="flex items-center gap-2 mb-3">
                        <Layers className="h-3.5 w-3.5 text-[#4f8ef7]" />
                        <p className="text-[9px] font-mono text-[#00d9ff] uppercase tracking-widest">File Risk Heatmap</p>
                      </div>
                      {fileRisk.length > 0 ? (
                        <div className="space-y-0.5">
                          {fileRisk.map(f => (
                            <FileRiskRow key={f.name} name={f.name} critical={f.critical}
                              alert={f.alert} score={f.score} onClick={() => {}} />
                          ))}
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center py-12 text-[#2d3f5c] font-mono text-xs">
                          <FileCode2 className="h-6 w-6 mb-2 opacity-30" />
                          {findingsLoading ? "Loading file data…" : "Run a project scan to see file risk breakdown"}
                        </div>
                      )}
                    </div>
                  </Reveal>

                  {/* NIST Migration Path */}
                  <Reveal delay={0.28}>
                    <div className="rounded-2xl border border-white/6 bg-gradient-to-br from-[#0a0e1f] to-[#050810] p-5" style={{
                      boxShadow: `0 4px 12px rgba(0, 0, 0, 0.3), inset 0 1px 0px rgba(0,217,255,0.08)`
                    }}>
                      <div className="flex items-center gap-2 mb-3">
                        <ShieldCheck className="h-3.5 w-3.5 text-[#4f8ef7]" />
                        <p className="text-[9px] font-mono text-[#00d9ff] uppercase tracking-widest">NIST Migration Path</p>
                      </div>
                      {migrationItems.length > 0 ? (
                        <div className="space-y-2">
                          {migrationItems.map((item) => {
                            const effortColor = item.effort === "High" ? "#f87171" : item.effort === "Medium" ? "#fbbf24" : "#34d399";
                            return (
                              <div key={item.algo} className="rounded-lg border border-white/5 bg-[#050810]/60 p-3 flex items-start gap-3">
                                <div className="h-6 w-6 rounded-md border-2 shrink-0 mt-0.5 flex items-center justify-center"
                                  style={{ borderColor: effortColor + "60", background: effortColor + "10" }}>
                                  <ChevronRight className="h-3 w-3" style={{ color: effortColor }} />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-[11px] font-mono font-bold text-[#f1f5f9] truncate">{item.algo}</span>
                                    <span className="text-[9px] font-mono text-[#475569]">→</span>
                                    <span className="text-[11px] font-mono text-[#4f8ef7] truncate">{item.replacement}</span>
                                  </div>
                                  <div className="flex items-center gap-3 mt-1">
                                    <span className="text-[9px] font-mono text-[#2d3f5c]">{item.standard}</span>
                                    <span className="text-[9px] font-mono flex items-center gap-1" style={{ color: effortColor + "99" }}>
                                      <Clock className="h-2.5 w-2.5" /> ~{item.hours}h
                                    </span>
                                    <span className="text-[9px] font-mono" style={{ color: effortColor }}>{item.effort}</span>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="rounded-lg border border-white/5 bg-[#050810]/60 p-5 flex flex-col items-center text-center">
                          <ShieldCheck className="h-7 w-7 text-emerald-500/40 mb-2" />
                          <p className="text-[11px] font-mono text-[#475569]">
                            {findings.length === 0 && !findingsLoading
                              ? "Run a project scan to see NIST migration recommendations"
                              : "No critical algorithms detected — good posture!"}
                          </p>
                        </div>
                      )}
                    </div>
                  </Reveal>
                </div>

                {/* Global platform stats */}
                {globalStats && (
                  <Reveal delay={0.3}>
                    <div className="rounded-2xl border border-white/6 bg-gradient-to-br from-[#0a0e1f] to-[#050810] p-5 mb-5" style={{
                      boxShadow: `0 4px 12px rgba(0, 0, 0, 0.3), inset 0 1px 0px rgba(0,217,255,0.08)`
                    }}>
                      <p className="text-[9px] font-mono text-[#475569] uppercase tracking-widest mb-4">Platform Intelligence</p>
                      <div className="grid grid-cols-3 gap-4">
                        {[
                          { label: "Repos Scanned", value: globalStats.totalReposScanned.toLocaleString(), icon: Folder, color: "#4f8ef7" },
                          { label: "Vulnerabilities Found", value: globalStats.totalVulnerabilitiesFound.toLocaleString(), icon: AlertTriangle, color: "#f87171" },
                          { label: "Lines Analyzed", value: globalStats.totalLinesScanned.toLocaleString(), icon: FileCode2, color: "#a78bfa" },
                        ].map(({ label, value, icon: Icon, color }) => (
                          <div key={label} className="flex flex-col items-center gap-2 py-4 px-3 rounded-xl border border-white/5 bg-[#050810]/50">
                            <Icon className="h-5 w-5" style={{ color }} />
                            <div className="text-xl font-bold font-mono" style={{ color }}>{value}</div>
                            <div className="text-[9px] font-mono text-[#475569] uppercase tracking-widest text-center">{label}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </Reveal>
                )}

                {/* All projects table */}
                <Reveal delay={0.32}>
                  <div className="rounded-2xl border border-white/6 bg-gradient-to-br from-[#0a0e1f] to-[#050810] p-5 mb-5" style={{
                    boxShadow: `0 4px 12px rgba(0, 0, 0, 0.3), inset 0 1px 0px rgba(0,217,255,0.08)`
                  }}>
                    <div className="flex items-center gap-2 mb-3">
                      <Folder className="h-3.5 w-3.5 text-[#4f8ef7]" />
                      <p className="text-[9px] font-mono text-[#475569] uppercase tracking-widest">All Projects</p>
                      <span className="ml-auto text-[9px] font-mono text-[#2d3f5c] border border-white/6 rounded-full px-2 py-0.5">{sorted.length}</span>
                    </div>
                    <div className="space-y-1">
                      {sorted.map(p => {
                        const rs = p.riskScore ?? 0;
                        const rc = rs > 75 ? "#f87171" : rs > 40 ? "#fbbf24" : "#34d399";
                        return (
                          <button key={p.id} onClick={() => setSelectedProjectId(p.id)}
                            className={cn(
                              "w-full flex items-center gap-4 px-3 py-2.5 rounded-lg border transition-all text-left",
                              p.id === project?.id ? "border-[#4f8ef7]/30 bg-[#4f8ef7]/5" : "border-transparent hover:border-white/8 hover:bg-white/3"
                            )}>
                            <div className="h-2 w-2 rounded-full shrink-0" style={{ background: rc, boxShadow: `0 2px 4px ${rc}44` }} />
                            <span className={cn("flex-1 text-[12px] font-mono truncate", p.id === project?.id ? "text-[#4f8ef7]" : "text-[#f1f5f9]")}>{p.name}</span>
                            <span className="text-[10px] font-mono text-[#475569] shrink-0">{p.language}</span>
                            <div className="flex items-center gap-1.5">
                              {(p.criticalCount ?? 0) > 0 && <span className="text-[10px] font-mono text-red-400">{p.criticalCount}C</span>}
                              {(p.alertCount ?? 0) > 0 && <span className="text-[10px] font-mono text-yellow-400">{p.alertCount}A</span>}
                            </div>
                            <div className="w-16 h-1 rounded-full bg-white/5 overflow-hidden shrink-0">
                              <div className="h-full rounded-full" style={{ width: `${rs}%`, background: rc }} />
                            </div>
                            <span className="text-[10px] font-mono shrink-0 w-8 text-right" style={{ color: rc }}>{rs}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </Reveal>

                {/* CTA */}
                <Reveal delay={0.36}>
                  <div className="flex items-center justify-center gap-4">
                    <Link href="/scan"
                      className="inline-flex items-center gap-2 rounded-lg border border-[#4f8ef7] bg-[#4f8ef7]/10 px-6 py-2.5 text-sm font-mono font-bold text-[#4f8ef7] shadow-[0_0_20px_rgba(79,142,247,0.2)] hover:bg-[#4f8ef7]/18 hover:shadow-[0_0_32px_rgba(79,142,247,0.4)] transition-all">
                      <Terminal className="h-4 w-4" /> ./scan --new-repo
                    </Link>
                  </div>
                </Reveal>
              </motion.div>
            )}

            {/* ════════════════════════════════════════════════════
                TAB: AI ANALYSIS
            ════════════════════════════════════════════════════ */}
            {dashTab === "ai" && (
              <motion.div key="ai" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.3 }}>
                <div className="max-w-3xl">
                  <Reveal delay={0.06}>
                    <div className="rounded-2xl border border-white/6 bg-[#0a0e1e] p-6" style={{ boxShadow: `0 4px 12px rgba(0, 0, 0, 0.3)` }}>
                      <AISummaryPanel project={project} findings={findings} />
                    </div>
                  </Reveal>

                  {/* supplementary stat cards */}
                  {project && (
                    <Reveal delay={0.12}>
                      <div className="grid grid-cols-3 gap-3 mt-5">
                        <div className="rounded-2xl border border-white/6 bg-[#0a0e1e] p-4 text-center" style={{ boxShadow: `0 2px 8px rgba(0, 0, 0, 0.2)` }}>
                          <div className="text-2xl font-bold font-mono text-red-400">{critical}</div>
                          <div className="text-[9px] font-mono text-[#475569] uppercase tracking-widest mt-1">Critical</div>
                        </div>
                        <div className="rounded-2xl border border-white/6 bg-[#0a0e1e] p-4 text-center" style={{ boxShadow: `0 2px 8px rgba(0, 0, 0, 0.2)` }}>
                          <div className="text-2xl font-bold font-mono text-yellow-400">{alerts}</div>
                          <div className="text-[9px] font-mono text-[#475569] uppercase tracking-widest mt-1">Alerts</div>
                        </div>
                        <div className="rounded-2xl border border-white/6 bg-[#0a0e1e] p-4 text-center" style={{ boxShadow: `0 2px 8px rgba(0, 0, 0, 0.2)` }}>
                          <div className="text-2xl font-bold font-mono" style={{ color: riskScore > 75 ? "#f87171" : riskScore > 40 ? "#fbbf24" : "#34d399" }}>{riskScore}</div>
                          <div className="text-[9px] font-mono text-[#475569] uppercase tracking-widest mt-1">Risk Score</div>
                        </div>
                      </div>
                    </Reveal>
                  )}
                </div>
              </motion.div>
            )}

            {/* ════════════════════════════════════════════════════
                TAB: COMMUNITY INTEL
            ════════════════════════════════════════════════════ */}
            {dashTab === "community" && (
              <motion.div key="community" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.3 }}>
                <Reveal delay={0.06}>
                  <div className="rounded-2xl border border-white/6 bg-[#0a0e1e] p-6" style={{ boxShadow: `0 4px 12px rgba(0, 0, 0, 0.3)` }}>
                    <CommunityIntel project={project ? { name: project.name, language: project.language } : null} findings={findings} />
                  </div>
                </Reveal>
              </motion.div>
            )}

          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
