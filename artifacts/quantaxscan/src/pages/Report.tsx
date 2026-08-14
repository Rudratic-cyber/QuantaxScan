import { useEffect, useState } from "react";
import { useParams, useLocation } from "wouter";
import { Shield, AlertTriangle, CheckCircle2, Download, ExternalLink, Clock, Zap, Github, ChevronRight } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { apiUrl } from "@/lib/api";
import { QuantaXscanLogo } from "@/components/QuantaXscanLogo";

/** One resolved regulatory claim. Mirrors `Obligation` in @workspace/mappings. */
interface Obligation {
  framework: string; frameworkName?: string; requirement: string; severity: string;
  deadline?: { label: string; inEffect: boolean; after?: string; in?: string; since?: string; appliesTo?: string };
  replacement?: { algorithm: string; standard: string };
  citation: { document: string; section?: string; url: string; retrievedAt?: string };
  confidence: string; draftStatus?: string; caveats: string[]; source: string;
}

/**
 * Output of the C1 mapping engine, carried on every finding.
 *
 * Optional because a report shared before this shipped has no compliance block in its
 * frozen snapshot — the page falls back to severity grouping for those.
 */
interface FindingCompliance {
  bucket: string; bucketLabel: string; bucketDescription: string;
  complianceStatus: string; riskTrack: string; countsTowardPostQuantumScore: boolean;
  headline: string; useDependent: boolean;
  useConditions: { use: string; status: string; permitted: boolean; framework: string }[];
  obligations: Obligation[];
  detection: { multiplier: number; reviewRequired: boolean; reason: string | null };
  reportingNote: string | null;
  caveats: string[]; dataVersion: string; asOf: string;
}

interface GithubFinding {
  lineNumber: number; severity: "critical" | "alert" | "safe";
  algorithm: string; codeSnippet: string;
  nistReplacement: string | null; nistStandard: string | null;
  explanation: string; effortHours: number; fileName: string;
  compliance?: FindingCompliance | null;
}

/**
 * Report grouping, in the order a CISO should read it. Deliberately NOT severity order:
 * a DSA signing site is non-compliant today and outranks an RSA certificate whose
 * deadline is years out, even though both are "critical" (G-07). Colour is a cue, not
 * the claim — the claim is the bucket label and the obligations under it.
 */
const BUCKET_ORDER = ["immediate-compliance-failure", "pqc-migration", "classical-hygiene", "best-practice", "no-obligation"] as const;

const BUCKET_STYLE: Record<string, { fg: string; bg: string; border: string }> = {
  "immediate-compliance-failure": { fg: "#b91c1c", bg: "#fef2f2", border: "#fecaca" },
  "pqc-migration":                { fg: "#c2410c", bg: "#fff7ed", border: "#fed7aa" },
  "classical-hygiene":            { fg: "#a16207", bg: "#fffbeb", border: "#fde68a" },
  "best-practice":                { fg: "#4f46e5", bg: "#eef0fe", border: "#c7d2fe" },
  "no-obligation":                { fg: "#059669", bg: "#ecfdf5", border: "#a7f3d0" },
};

const bucketStyle = (bucket: string) => BUCKET_STYLE[bucket] ?? BUCKET_STYLE["no-obligation"];

const mappingsVersionForExport = (d: GithubScanResult) => d.findings.find(f => f.compliance)?.compliance?.dataVersion;

function deadlineText(o: Obligation): string | null {
  if (!o.deadline) return null;
  const when = o.deadline.since
    ? `since ${o.deadline.since}`
    : o.deadline.after
      ? `after ${o.deadline.after}`
      : o.deadline.in
        ? `in ${o.deadline.in}`
        : "now";
  return `${o.deadline.label} ${when}${o.deadline.inEffect ? " — in effect" : ""}`;
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
  const color = score >= 70 ? "#dc2626" : score >= 40 ? "#d97706" : "#059669";
  const label = score >= 70 ? "CRITICAL RISK" : score >= 40 ? "MODERATE RISK" : "LOW RISK";
  const circumference = 2 * Math.PI * 40;
  const dashOffset = circumference * (1 - score / 100);
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative w-28 h-28">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(15,23,42,0.08)" strokeWidth="8" />
          <circle cx="50" cy="50" r="40" fill="none" stroke={color} strokeWidth="8"
            strokeDasharray={circumference} strokeDashoffset={dashOffset}
            strokeLinecap="round" style={{ transition: "stroke-dashoffset 1s ease" }} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold font-mono" style={{ color }}>{score}</span>
          <span className="text-[9px] text-[#6b7280] font-mono">/100</span>
        </div>
      </div>
      <span className="text-[10px] font-bold tracking-widest font-mono" style={{ color }}>{label}</span>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  if (severity === "critical") return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#fef2f2] text-[#dc2626] border border-[#fecaca]">
      <AlertTriangle className="h-2.5 w-2.5" /> CRITICAL
    </span>
  );
  if (severity === "alert") return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#fffbeb] text-[#d97706] border border-[#fde68a]">
      <AlertTriangle className="h-2.5 w-2.5" /> ALERT
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#ecfdf5] text-[#059669] border border-[#a7f3d0]">
      <CheckCircle2 className="h-2.5 w-2.5" /> SAFE
    </span>
  );
}

function FindingCard({ finding, index }: { finding: GithubFinding; index: number }) {
  const [open, setOpen] = useState(false);
  const c = finding.compliance;
  const style = c ? bucketStyle(c.bucket) : null;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.03 }}
      className="rounded-lg border overflow-hidden"
      style={style
        ? { borderColor: style.border, background: style.bg }
        : undefined}>
      <button onClick={() => setOpen(o => !o)}
        className={cn("w-full flex items-start gap-3 p-3 text-left hover:bg-black/[0.02] transition-colors",
          !style && (finding.severity === "critical" ? "border-[#fecaca] bg-[#fef2f2]" : "border-[#fde68a] bg-[#fffbeb]"))}>
        <SeverityBadge severity={finding.severity} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="font-mono text-[11px] font-bold text-[#0a0e1a]">{finding.algorithm}</span>
            <span className="text-[10px] text-[#6b7280] font-mono truncate">{finding.fileName}:{finding.lineNumber}</span>
            {c?.detection.reviewRequired && (
              <span className="text-[9px] font-bold tracking-wide px-1.5 py-0.5 rounded bg-white/70 border border-[#e5e7eb] text-[#6b7280]">
                NEEDS REVIEW
              </span>
            )}
          </div>
          {/* The headline is composed from the mapping data, not written in this file. */}
          <p className="text-[11px] text-[#475569] line-clamp-2">{c ? c.headline : finding.explanation}</p>
        </div>
        <ChevronRight className={cn("h-3.5 w-3.5 text-[#9aa3b2] shrink-0 transition-transform mt-0.5", open && "rotate-90")} />
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3 border-t border-[#e5e7eb] pt-2">
          <pre className="bg-[#f7f8fa] rounded px-2.5 py-2 text-[10px] font-mono text-[#334155] overflow-x-auto border border-[#e5e7eb]">{finding.codeSnippet}</pre>

          {c?.detection.reviewRequired && c.detection.reason && (
            <div className="rounded border border-[#e5e7eb] bg-white/80 px-2.5 py-2">
              <p className="text-[10px] font-bold text-[#6b7280] tracking-wide uppercase mb-1">Confidence reduced — confirm the use</p>
              <p className="text-[11px] text-[#475569] leading-relaxed">{c.detection.reason}</p>
            </div>
          )}

          {/* G-08: when the standard's answer depends on the use, print the uses, not a verdict. */}
          {c && c.useConditions.length > 0 && (
            <div className="rounded border border-[#e5e7eb] bg-white/80 overflow-x-auto">
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="bg-[#f7f8fa] border-b border-[#e5e7eb] text-[#6b7280]">
                    <th className="text-left px-2.5 py-1.5 font-semibold">Use</th>
                    <th className="text-left px-2.5 py-1.5 font-semibold">Status</th>
                    <th className="text-left px-2.5 py-1.5 font-semibold">Under</th>
                  </tr>
                </thead>
                <tbody>
                  {c.useConditions.map((u, i) => (
                    <tr key={i} className="border-b border-[#eceef2] last:border-0">
                      <td className="px-2.5 py-1.5 text-[#334155]">{u.use}</td>
                      <td className="px-2.5 py-1.5 font-semibold" style={{ color: u.permitted ? "#059669" : "#b91c1c" }}>{u.status}</td>
                      <td className="px-2.5 py-1.5 text-[#6b7280]">{u.framework}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {c && c.obligations.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-bold text-[#6b7280] tracking-wide uppercase">Obligations</p>
              {c.obligations.map((o, i) => (
                <div key={i} className="rounded border border-[#e5e7eb] bg-white/80 px-2.5 py-2">
                  <div className="flex items-center gap-2 flex-wrap mb-0.5">
                    <span className="text-[10px] font-mono font-bold text-[#4f46e5]">{o.frameworkName ?? o.framework}</span>
                    {deadlineText(o) && <span className="text-[10px] text-[#6b7280]">{deadlineText(o)}</span>}
                    {o.confidence !== "verified" && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-[#fffbeb] text-[#a16207] border border-[#fde68a]">
                        INDICATIVE — UNVERIFIED
                      </span>
                    )}
                    {o.draftStatus && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-[#f1f3f7] text-[#475569] border border-[#e5e7eb]">
                        DRAFT GUIDANCE
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-[#334155] leading-relaxed">{o.requirement}</p>
                  {/* "Says who?" — the question the report exists to answer. */}
                  <a href={o.citation.url} target="_blank" rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-[10px] text-[#6b7280] hover:text-[#4f46e5]">
                    {o.citation.document}{o.citation.section ? ` — ${o.citation.section}` : ""}
                    {o.citation.retrievedAt ? ` (retrieved ${o.citation.retrievedAt})` : ""}
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                </div>
              ))}
            </div>
          )}

          {!c && finding.nistReplacement && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-[#6b7280]">Replace with:</span>
              <code className="text-[10px] font-mono text-[#4f46e5] bg-[#eef0fe] px-1.5 py-0.5 rounded">{finding.nistReplacement}</code>
              {finding.nistStandard && <span className="text-[10px] text-[#9aa3b2]">({finding.nistStandard})</span>}
            </div>
          )}

          <div className="flex items-center gap-3 flex-wrap text-[10px] text-[#6b7280]">
            <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> Est. {finding.effortHours}h remediation effort</span>
            {c && <span className="font-mono">mappings {c.dataVersion} · resolved {c.asOf}</span>}
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
      `# QuantaXscan Post-Quantum Security Report`,
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
      // Every regulatory claim in the export carries its citation and its confidence, so
      // the markdown an auditor receives is as defensible as the page it came from.
      ...d.findings.map(f => {
        const c = f.compliance;
        const heading = c
          ? `### [${c.bucketLabel}] ${f.algorithm} — ${f.fileName}:${f.lineNumber}`
          : `### [${f.severity.toUpperCase()}] ${f.algorithm} — ${f.fileName}:${f.lineNumber}`;
        const body = [heading, ``, c ? c.headline : f.explanation, ``];

        if (c?.detection.reviewRequired && c.detection.reason) {
          body.push(`> **Needs review — confidence reduced.** ${c.detection.reason}`, ``);
        }
        if (c && c.useConditions.length > 0) {
          body.push(`| Use | Status | Under |`, `|---|---|---|`);
          for (const u of c.useConditions) body.push(`| ${u.use} | ${u.status} | ${u.framework} |`);
          body.push(``);
        }
        if (c && c.obligations.length > 0) {
          body.push(`**Obligations**`, ``);
          for (const o of c.obligations) {
            const when = deadlineText(o);
            const flags = [o.confidence !== "verified" ? "indicative, unverified" : null, o.draftStatus ? "draft guidance" : null]
              .filter(Boolean).join("; ");
            body.push(
              `- **${o.frameworkName ?? o.framework}**${when ? ` (${when})` : ""}: ${o.requirement}` +
                `\n  Source: ${o.citation.document}${o.citation.section ? ` — ${o.citation.section}` : ""} — ${o.citation.url}` +
                `${o.citation.retrievedAt ? ` (retrieved ${o.citation.retrievedAt})` : ""}${flags ? ` [${flags}]` : ""}`,
            );
          }
          body.push(``);
        }
        if (!c && f.nistReplacement) body.push(`**Replace with:** ${f.nistReplacement} (${f.nistStandard ?? ""})`, ``);

        body.push("```", f.codeSnippet, "```", ``);
        if (c) body.push(`_Resolved from standards data ${c.dataVersion} on ${c.asOf}._`, ``);
        return body.join("\n");
      }),
      `---`,
      mappingsVersionForExport(d)
        ? `*Generated by QuantaXscan Post-Quantum Security Scanner · standards data ${mappingsVersionForExport(d)}*`
        : `*Generated by QuantaXscan Post-Quantum Security Scanner*`,
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href: url, download: `QuantaXscan_${d.repo}.md` }).click();
    URL.revokeObjectURL(url);
  };

  if (loading) return (
    <div className="min-h-screen bg-[#f7f8fa] flex items-center justify-center" style={{ background: "radial-gradient(ellipse at 50% 0%, #ffffff 0%, #f7f8fa 70%)" }}>
      <div className="flex flex-col items-center gap-4">
        <div className="w-10 h-10 border-2 border-[#4f46e5]/30 border-t-[#4f46e5] rounded-full animate-spin" />
        <p className="text-[13px] text-[#6b7280] font-mono">Loading report…</p>
      </div>
    </div>
  );

  if (error || !report) return (
    <div className="min-h-screen bg-[#f7f8fa] flex items-center justify-center" style={{ background: "radial-gradient(ellipse at 50% 0%, #ffffff 0%, #f7f8fa 70%)" }}>
      <div className="text-center space-y-4">
        <Shield className="h-12 w-12 text-[#9aa3b2] mx-auto" />
        <p className="text-[#0a0e1a] font-semibold">Report not found</p>
        <p className="text-[13px] text-[#6b7280]">{error}</p>
        <button onClick={() => setLocation("/scan")}
          className="px-4 py-2 bg-[#eef0fe] border border-[#4f46e5]/25 text-[#4f46e5] text-[13px] rounded-lg hover:bg-[#e0e3fc] transition-colors">
          Run a new scan
        </button>
      </div>
    </div>
  );

  const d = report.data;
  const criticalFindings = d.findings.filter(f => f.severity === "critical");
  const alertFindings    = d.findings.filter(f => f.severity === "alert");
  const totalEffort      = d.totalEffortHours ?? d.findings.reduce((s, f) => s + f.effortHours, 0);

  // Reports shared before the mapping engine existed have no compliance block in their
  // frozen snapshot; those still group by severity.
  // `every`, not `some`: a mixed response must not drop the findings that have no
  // compliance block, because the bucket groups below only collect findings that do.
  const hasCompliance = d.findings.length > 0 && d.findings.every(f => f.compliance);
  const complianceGroups = BUCKET_ORDER
    .map(bucket => ({
      bucket,
      findings: d.findings.filter(f => f.compliance?.bucket === bucket),
      label: d.findings.find(f => f.compliance?.bucket === bucket)?.compliance?.bucketLabel ?? bucket,
      description: d.findings.find(f => f.compliance?.bucket === bucket)?.compliance?.bucketDescription ?? "",
    }))
    .filter(g => g.findings.length > 0);
  const mappingsVersion = d.findings.find(f => f.compliance)?.compliance?.dataVersion;

  return (
    <div className="min-h-screen bg-[#f7f8fa] text-[#0a0e1a]" style={{ background: "radial-gradient(ellipse at 50% 0%, #ffffff 0%, #f7f8fa 60%)" }}>

      {/* ── Header ── */}
      <div className="relative z-10 border-b border-[#e5e7eb] bg-white/85 backdrop-blur-sm sticky top-0">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
          {/* Same hexagon mark + wordmark as the site nav — the report is the page most likely
              to be seen by someone who has never seen the product before. */}
          <button onClick={() => setLocation("/")} className="flex items-center gap-2 shrink-0">
            <QuantaXscanLogo variant="icon" size="xs" />
            <span className="font-bold text-[15px] tracking-tight text-[#0a0e1a]">
              Quanta<span style={{ color: "#4f46e5" }}>Xscan</span>
            </span>
          </button>
          <div className="flex items-center gap-1.5 min-w-0">
            <Github className="h-3.5 w-3.5 text-[#6b7280] shrink-0" />
            <a href={d.repoUrl} target="_blank" rel="noreferrer"
              className="font-mono text-[13px] text-[#475569] hover:text-[#0a0e1a] truncate flex items-center gap-1">
              {d.owner}/{d.repo} <ExternalLink className="h-3 w-3 text-[#9aa3b2] shrink-0" />
            </a>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={copyLink}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded border border-[#e5e7eb] bg-white hover:bg-[#f1f3f7] text-[11px] text-[#475569] hover:text-[#0a0e1a] transition-colors">
              {copied ? <><CheckCircle2 className="h-3 w-3 text-[#059669]" /> Copied!</> : <><ExternalLink className="h-3 w-3" /> Copy link</>}
            </button>
            <button onClick={downloadMarkdown}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded border border-[#e5e7eb] bg-white hover:bg-[#f1f3f7] text-[11px] text-[#475569] hover:text-[#0a0e1a] transition-colors">
              <Download className="h-3 w-3" /> Download
            </button>
            <button onClick={() => setLocation("/scan")}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded bg-[#eef0fe] border border-[#4f46e5]/25 text-[11px] text-[#4f46e5] hover:bg-[#e0e3fc] transition-colors">
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
          <div className="flex flex-col items-center justify-center p-6 rounded-2xl bg-white border border-[#e5e7eb] shadow-[0_8px_24px_rgba(15,23,42,0.06)]">
            <RiskGauge score={d.riskScore} />
            <p className="text-[10px] text-[#9aa3b2] mt-3 font-mono">POST-QUANTUM RISK SCORE</p>
          </div>
          {/* Stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {[
              { label: "Critical", value: d.criticalCount, color: "#dc2626", icon: <AlertTriangle className="h-4 w-4" /> },
              { label: "Alert",    value: d.alertCount,    color: "#d97706", icon: <AlertTriangle className="h-4 w-4" /> },
              { label: "Clean",    value: d.cleanCount,    color: "#059669", icon: <CheckCircle2 className="h-4 w-4" /> },
              { label: "Files",    value: d.totalFiles,    color: "#4f46e5", icon: <Shield className="h-4 w-4" /> },
              { label: "Lines",    value: d.totalLines.toLocaleString(), color: "#0d9488", icon: <Zap className="h-4 w-4" /> },
              { label: "Est. Effort", value: `${Math.round(totalEffort)}h`, color: "#6b7280", icon: <Clock className="h-4 w-4" /> },
            ].map(stat => (
              <div key={stat.label} className="p-4 rounded-xl bg-white border border-[#e5e7eb] shadow-sm flex flex-col gap-1">
                <div className="flex items-center gap-1.5" style={{ color: stat.color }}>
                  {stat.icon}
                  <span className="text-[10px] font-bold tracking-wider uppercase text-[#6b7280]">{stat.label}</span>
                </div>
                <span className="text-2xl font-bold font-mono" style={{ color: stat.color }}>{stat.value}</span>
              </div>
            ))}
          </div>
        </motion.div>

        {/* ── Executive summary ── */}
        {d.executiveSummary && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}
            className="p-5 rounded-2xl bg-[#eef0fe] border border-[#4f46e5]/25">
            <h2 className="text-[11px] font-bold text-[#4f46e5] tracking-widest uppercase mb-2">Executive Summary</h2>
            <p className="text-[13px] text-[#334155] leading-relaxed">{d.executiveSummary}</p>
          </motion.div>
        )}

        {/* ── Findings, grouped by compliance bucket ── */}
        {hasCompliance && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }} className="space-y-6">
            {complianceGroups.map(group => {
              const style = bucketStyle(group.bucket);
              return (
                <div key={group.bucket}>
                  <h2 className="text-[11px] font-bold tracking-widest uppercase mb-1 flex items-center gap-2" style={{ color: style.fg }}>
                    <AlertTriangle className="h-3.5 w-3.5" /> {group.label} ({group.findings.length})
                  </h2>
                  <p className="text-[11px] text-[#6b7280] leading-relaxed mb-3 max-w-3xl">{group.description}</p>
                  <div className="space-y-2">
                    {group.findings.map((f, i) => <FindingCard key={`${group.bucket}-${i}`} finding={f} index={i} />)}
                  </div>
                </div>
              );
            })}
            {mappingsVersion && (
              <p className="text-[10px] text-[#9aa3b2] font-mono">
                Obligations resolved from versioned standards data, mappings {mappingsVersion}. Every claim above links to its primary source.
              </p>
            )}
          </motion.div>
        )}

        {/* ── Findings (legacy reports with no compliance block) ── */}
        {!hasCompliance && (criticalFindings.length > 0 || alertFindings.length > 0) && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }} className="space-y-4">
            {criticalFindings.length > 0 && (
              <div>
                <h2 className="text-[11px] font-bold text-[#dc2626] tracking-widest uppercase mb-3 flex items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5" /> Critical Findings ({criticalFindings.length})
                </h2>
                <div className="space-y-2">
                  {criticalFindings.map((f, i) => <FindingCard key={i} finding={f} index={i} />)}
                </div>
              </div>
            )}
            {alertFindings.length > 0 && (
              <div>
                <h2 className="text-[11px] font-bold text-[#d97706] tracking-widest uppercase mb-3 flex items-center gap-2">
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
            <h2 className="text-[11px] font-bold text-[#6b7280] tracking-widest uppercase mb-3">Files Scanned</h2>
            <div className="rounded-xl border border-[#e5e7eb] bg-white overflow-hidden shadow-sm">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="bg-[#f7f8fa] border-b border-[#e5e7eb]">
                    <th className="text-left px-4 py-2.5 text-[10px] text-[#6b7280] font-semibold tracking-wider">File</th>
                    <th className="text-center px-3 py-2.5 text-[10px] text-[#6b7280] font-semibold tracking-wider">Lang</th>
                    <th className="text-center px-3 py-2.5 text-[10px] text-[#6b7280] font-semibold tracking-wider">Lines</th>
                    <th className="text-center px-3 py-2.5 text-[10px] text-[#dc2626] font-semibold tracking-wider">Critical</th>
                    <th className="text-center px-3 py-2.5 text-[10px] text-[#d97706] font-semibold tracking-wider">Alert</th>
                  </tr>
                </thead>
                <tbody>
                  {d.fileResults.map((f, i) => (
                    <tr key={i} className="border-b border-[#eceef2] last:border-0 hover:bg-[#f7f8fa] transition-colors">
                      <td className="px-4 py-2.5 font-mono text-[11px] text-[#334155] truncate max-w-[200px]">{f.path}</td>
                      <td className="px-3 py-2.5 text-center">
                        <span className="text-[9px] font-mono bg-[#f1f3f7] text-[#475569] px-1.5 py-0.5 rounded">{f.language}</span>
                      </td>
                      <td className="px-3 py-2.5 text-center font-mono text-[#475569]">{f.lines.toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-center">
                        {f.criticalCount > 0
                          ? <span className="font-mono font-bold text-[#dc2626]">{f.criticalCount}</span>
                          : <span className="text-[#9aa3b2]">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        {f.alertCount > 0
                          ? <span className="font-mono font-bold text-[#d97706]">{f.alertCount}</span>
                          : <span className="text-[#9aa3b2]">—</span>}
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
          className="pt-4 border-t border-[#e5e7eb] flex flex-col sm:flex-row items-center justify-between gap-3 text-[11px] text-[#6b7280]">
          <span>Generated by <span className="text-[#4f46e5] font-medium">QuantaXscan</span> · Post-Quantum Security Scanner</span>
          <span className="font-mono">{new Date(report.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</span>
        </motion.div>
      </div>
    </div>
  );
}
