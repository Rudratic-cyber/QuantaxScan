import { useEffect, useState } from "react";
import { useParams, useLocation } from "wouter";
import { Shield, AlertTriangle, CheckCircle2, Download, ExternalLink, Clock, Zap, Github, ChevronRight } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { apiUrl } from "@/lib/api";

interface GithubFinding {
  lineNumber: number; severity: "critical" | "alert" | "safe";
  algorithm: string; codeSnippet: string;
  nistReplacement: string | null; nistStandard: string | null;
  explanation: string; effortHours: number; fileName: string;
}
interface GithubFileResult {
  path: string; language: string; lines: number;
  criticalCount: number; alertCount: number;
  findings?: GithubFinding[];
}
interface GithubScanResult {
  repoUrl: string; owner: string; repo: string; totalFiles: number;
  findings: GithubFinding[]; criticalCount: number; alertCount: number;
  cleanCount: number; riskScore: number; totalLines: number;
  totalEffortHours?: number; executiveSummary: string;
  fileResults: GithubFileResult[];
}
interface SharedReport {
  id: string; owner: string; repo: string; repoUrl: string;
  data: GithubScanResult; createdAt: string;
}

function RiskGauge({ score }: { score: number }) {
  const color = score >= 70 ? "#ef4444" : score >= 40 ? "#f59e0b" : "#22c55e";
  const label = score >= 70 ? "CRITICAL RISK" : score >= 40 ? "MODERATE RISK" : "LOW RISK";
  const circumference = 2 * Math.PI * 40;
  const dashOffset = circumference * (1 - score / 100);
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative w-28 h-28">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="8" />
          <circle cx="50" cy="50" r="40" fill="none" stroke={color} strokeWidth="8"
            strokeDasharray={circumference} strokeDashoffset={dashOffset}
            strokeLinecap="round" style={{ transition: "stroke-dashoffset 1s ease" }} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold font-mono" style={{ color }}>{score}</span>
          <span className="text-[9px] text-neutral-500 font-mono">/100</span>
        </div>
      </div>
      <span className="text-[10px] font-bold tracking-widest font-mono" style={{ color }}>{label}</span>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  if (severity === "critical") return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-500/15 text-red-400 border border-red-500/25">
      <AlertTriangle className="h-2.5 w-2.5" /> CRITICAL
    </span>
  );
  if (severity === "alert") return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-yellow-500/15 text-yellow-400 border border-yellow-500/25">
      <AlertTriangle className="h-2.5 w-2.5" /> ALERT
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
      <CheckCircle2 className="h-2.5 w-2.5" /> SAFE
    </span>
  );
}

function FindingCard({ finding, index }: { finding: GithubFinding; index: number }) {
  const [open, setOpen] = useState(false);
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.03 }}
      className={cn("rounded-lg border overflow-hidden", finding.severity === "critical" ? "border-red-500/20 bg-red-500/4" : "border-yellow-500/20 bg-yellow-500/4")}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-start gap-3 p-3 text-left hover:bg-white/3 transition-colors">
        <SeverityBadge severity={finding.severity} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-mono text-[11px] font-bold text-white">{finding.algorithm}</span>
            <span className="text-[10px] text-neutral-500 font-mono truncate">{finding.fileName}:{finding.lineNumber}</span>
          </div>
          <p className="text-[11px] text-neutral-400 line-clamp-2">{finding.explanation}</p>
        </div>
        <ChevronRight className={cn("h-3.5 w-3.5 text-neutral-600 shrink-0 transition-transform mt-0.5", open && "rotate-90")} />
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 border-t border-white/5 pt-2">
          <pre className="bg-black/40 rounded px-2.5 py-2 text-[10px] font-mono text-neutral-300 overflow-x-auto border border-white/8">{finding.codeSnippet}</pre>
          {finding.nistReplacement && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-neutral-500">Replace with:</span>
              <code className="text-[10px] font-mono text-[#4f8ef7] bg-[#4f8ef7]/10 px-1.5 py-0.5 rounded">{finding.nistReplacement}</code>
              {finding.nistStandard && <span className="text-[10px] text-neutral-600">({finding.nistStandard})</span>}
            </div>
          )}
          <div className="flex items-center gap-1 text-[10px] text-neutral-500">
            <Clock className="h-3 w-3" /> Est. {finding.effortHours}h remediation effort
          </div>
        </div>
      )}
    </motion.div>
  );
}

export function Report() {
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const [report, setReport] = useState<SharedReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!params.id) return;
    fetch(apiUrl(`/api/reports/${params.id}`))
      .then(r => r.ok ? r.json() : r.json().then((e: { error?: string }) => Promise.reject(e.error ?? "Not found")))
      .then((d: SharedReport) => setReport(d))
      .catch((e: unknown) => setError(typeof e === "string" ? e : "Report not found"))
      .finally(() => setLoading(false));
  }, [params.id]);

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadMarkdown = () => {
    if (!report) return;
    const d = report.data;
    const lines = [
      `# Q-Bitron Post-Quantum Security Report`,
      `## Repository: ${d.owner}/${d.repo}`,
      ``,
      `**Risk Score:** ${d.riskScore}/100`,
      `**Files Scanned:** ${d.totalFiles}`,
      `**Total Lines:** ${d.totalLines.toLocaleString()}`,
      `**Critical Findings:** ${d.criticalCount}`,
      `**Alert Findings:** ${d.alertCount}`,
      ``,
      `## Executive Summary`,
      ``,
      d.executiveSummary,
      ``,
      `## Findings`,
      ``,
      ...d.findings.map(f =>
        `### [${f.severity.toUpperCase()}] ${f.algorithm} — ${f.fileName}:${f.lineNumber}\n\n${f.explanation}\n\n**Replace with:** ${f.nistReplacement ?? "N/A"} (${f.nistStandard ?? ""})\n\n\`\`\`\n${f.codeSnippet}\n\`\`\`\n`
      ),
      `---`,
      `*Generated by Q-Bitron Post-Quantum Security Scanner*`,
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href: url, download: `Q-Bitron_${d.repo}.md` }).click();
    URL.revokeObjectURL(url);
  };

  if (loading) return (
    <div className="min-h-screen bg-[#050810] flex items-center justify-center" style={{ background: "radial-gradient(ellipse at 50% 0%, #0d1424 0%, #050810 70%)" }}>
      <div className="flex flex-col items-center gap-4">
        <div className="w-10 h-10 border-2 border-[#4f8ef7]/50 border-t-[#4f8ef7] rounded-full animate-spin" />
        <p className="text-[13px] text-neutral-500 font-mono">Loading report…</p>
      </div>
    </div>
  );

  if (error || !report) return (
    <div className="min-h-screen bg-[#050810] flex items-center justify-center" style={{ background: "radial-gradient(ellipse at 50% 0%, #0d1424 0%, #050810 70%)" }}>
      <div className="text-center space-y-4">
        <Shield className="h-12 w-12 text-neutral-700 mx-auto" />
        <p className="text-white font-semibold">Report not found</p>
        <p className="text-[13px] text-neutral-500">{error}</p>
        <button onClick={() => setLocation("/scan")}
          className="px-4 py-2 bg-[#4f8ef7]/15 border border-[#4f8ef7]/30 text-[#4f8ef7] text-[13px] rounded-lg hover:bg-[#4f8ef7]/25 transition-colors">
          Run a new scan
        </button>
      </div>
    </div>
  );

  const d = report.data;
  const criticalFindings = d.findings.filter(f => f.severity === "critical");
  const alertFindings    = d.findings.filter(f => f.severity === "alert");
  const totalEffort      = d.totalEffortHours ?? d.findings.reduce((s, f) => s + f.effortHours, 0);

  return (
    <div className="min-h-screen bg-[#050810] text-white" style={{ background: "radial-gradient(ellipse at 50% 0%, #0d1830 0%, #050810 60%)" }}>

      {/* ── Header ── */}
      <div className="relative z-10 border-b border-white/8 bg-[#0a0a0f]/80 backdrop-blur-sm sticky top-0">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
          <button onClick={() => setLocation("/")} className="flex items-center gap-2 shrink-0">
            <Shield className="h-5 w-5 text-[#4f8ef7]" />
            <span className="font-bold text-[15px] tracking-tight">Q-Bitron</span>
          </button>
          <div className="flex items-center gap-1.5 min-w-0">
            <Github className="h-3.5 w-3.5 text-neutral-500 shrink-0" />
            <a href={d.repoUrl} target="_blank" rel="noreferrer"
              className="font-mono text-[13px] text-neutral-300 hover:text-white truncate flex items-center gap-1">
              {d.owner}/{d.repo} <ExternalLink className="h-3 w-3 text-neutral-600 shrink-0" />
            </a>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={copyLink}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded border border-white/10 bg-white/4 hover:bg-white/8 text-[11px] text-neutral-400 hover:text-white transition-colors">
              {copied ? <><CheckCircle2 className="h-3 w-3 text-emerald-400" /> Copied!</> : <><ExternalLink className="h-3 w-3" /> Copy link</>}
            </button>
            <button onClick={downloadMarkdown}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded border border-white/10 bg-white/4 hover:bg-white/8 text-[11px] text-neutral-400 hover:text-white transition-colors">
              <Download className="h-3 w-3" /> Download
            </button>
            <button onClick={() => setLocation("/scan")}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded bg-[#4f8ef7]/15 border border-[#4f8ef7]/30 text-[11px] text-[#4f8ef7] hover:bg-[#4f8ef7]/25 transition-colors">
              <Zap className="h-3 w-3" /> New scan
            </button>
          </div>
        </div>
      </div>

      <div className="relative z-10 max-w-5xl mx-auto px-4 py-8 space-y-8">

        {/* ── Hero metrics row ── */}
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
          className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-6">
          {/* Gauge */}
          <div className="flex flex-col items-center justify-center p-6 rounded-2xl bg-white/3 border border-white/8">
            <RiskGauge score={d.riskScore} />
            <p className="text-[10px] text-neutral-600 mt-3 font-mono">POST-QUANTUM RISK SCORE</p>
          </div>
          {/* Stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {[
              { label: "Critical", value: d.criticalCount, color: "#ef4444", icon: <AlertTriangle className="h-4 w-4" /> },
              { label: "Alert",    value: d.alertCount,    color: "#f59e0b", icon: <AlertTriangle className="h-4 w-4" /> },
              { label: "Clean",    value: d.cleanCount,    color: "#22c55e", icon: <CheckCircle2 className="h-4 w-4" /> },
              { label: "Files",    value: d.totalFiles,    color: "#4f8ef7", icon: <Shield className="h-4 w-4" /> },
              { label: "Lines",    value: d.totalLines.toLocaleString(), color: "#a78bfa", icon: <Zap className="h-4 w-4" /> },
              { label: "Est. Effort", value: `${Math.round(totalEffort)}h`, color: "#94a3b8", icon: <Clock className="h-4 w-4" /> },
            ].map(stat => (
              <div key={stat.label} className="p-4 rounded-xl bg-white/3 border border-white/8 flex flex-col gap-1">
                <div className="flex items-center gap-1.5" style={{ color: stat.color }}>
                  {stat.icon}
                  <span className="text-[10px] font-bold tracking-wider uppercase text-neutral-500">{stat.label}</span>
                </div>
                <span className="text-2xl font-bold font-mono" style={{ color: stat.color }}>{stat.value}</span>
              </div>
            ))}
          </div>
        </motion.div>

        {/* ── Executive summary ── */}
        {d.executiveSummary && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}
            className="p-5 rounded-2xl bg-[#4f8ef7]/5 border border-[#4f8ef7]/15">
            <h2 className="text-[11px] font-bold text-[#4f8ef7] tracking-widest uppercase mb-2">Executive Summary</h2>
            <p className="text-[13px] text-neutral-300 leading-relaxed">{d.executiveSummary}</p>
          </motion.div>
        )}

        {/* ── Findings ── */}
        {(criticalFindings.length > 0 || alertFindings.length > 0) && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }} className="space-y-4">
            {criticalFindings.length > 0 && (
              <div>
                <h2 className="text-[11px] font-bold text-red-400 tracking-widest uppercase mb-3 flex items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5" /> Critical Findings ({criticalFindings.length})
                </h2>
                <div className="space-y-2">
                  {criticalFindings.map((f, i) => <FindingCard key={i} finding={f} index={i} />)}
                </div>
              </div>
            )}
            {alertFindings.length > 0 && (
              <div>
                <h2 className="text-[11px] font-bold text-yellow-400 tracking-widest uppercase mb-3 flex items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5" /> Alert Findings ({alertFindings.length})
                </h2>
                <div className="space-y-2">
                  {alertFindings.map((f, i) => <FindingCard key={i} finding={f} index={i + criticalFindings.length} />)}
                </div>
              </div>
            )}
          </motion.div>
        )}

        {/* ── File breakdown ── */}
        {d.fileResults.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}>
            <h2 className="text-[11px] font-bold text-neutral-500 tracking-widest uppercase mb-3">Files Scanned</h2>
            <div className="rounded-xl border border-white/8 overflow-hidden">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="bg-white/3 border-b border-white/8">
                    <th className="text-left px-4 py-2.5 text-[10px] text-neutral-500 font-semibold tracking-wider">File</th>
                    <th className="text-center px-3 py-2.5 text-[10px] text-neutral-500 font-semibold tracking-wider">Lang</th>
                    <th className="text-center px-3 py-2.5 text-[10px] text-neutral-500 font-semibold tracking-wider">Lines</th>
                    <th className="text-center px-3 py-2.5 text-[10px] text-red-400 font-semibold tracking-wider">Critical</th>
                    <th className="text-center px-3 py-2.5 text-[10px] text-yellow-400 font-semibold tracking-wider">Alert</th>
                  </tr>
                </thead>
                <tbody>
                  {d.fileResults.map((f, i) => (
                    <tr key={i} className="border-b border-white/5 last:border-0 hover:bg-white/2 transition-colors">
                      <td className="px-4 py-2.5 font-mono text-[11px] text-neutral-300 truncate max-w-[200px]">{f.path}</td>
                      <td className="px-3 py-2.5 text-center">
                        <span className="text-[9px] font-mono bg-white/5 text-neutral-400 px-1.5 py-0.5 rounded">{f.language}</span>
                      </td>
                      <td className="px-3 py-2.5 text-center font-mono text-neutral-400">{f.lines.toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-center">
                        {f.criticalCount > 0
                          ? <span className="font-mono font-bold text-red-400">{f.criticalCount}</span>
                          : <span className="text-neutral-700">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        {f.alertCount > 0
                          ? <span className="font-mono font-bold text-yellow-400">{f.alertCount}</span>
                          : <span className="text-neutral-700">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.div>
        )}

        {/* ── Footer ── */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }}
          className="pt-4 border-t border-white/6 flex flex-col sm:flex-row items-center justify-between gap-3 text-[11px] text-neutral-600">
          <span>Generated by <span className="text-[#4f8ef7]">Q-Bitron</span> · Post-Quantum Security Scanner</span>
          <span className="font-mono">{new Date(report.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</span>
        </motion.div>
      </div>
    </div>
  );
}
