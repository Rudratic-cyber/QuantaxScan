import { useParams } from "wouter";
import { useEffect, useState } from "react";
import { useRunDemoScan, useListDemoRepos } from "@workspace/api-client-react";
import {
  Shield, AlertTriangle, Zap, Download, GitBranch, ChevronRight,
  FileCode, ExternalLink, CheckCircle2, Clock
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { motion } from "framer-motion";

interface DemoFinding {
  id: number;
  lineNumber: number;
  severity: "critical" | "alert" | "safe";
  algorithm: string;
  codeSnippet: string;
  nistReplacement: string | null;
  nistStandard: string | null;
  explanation: string;
  effortHours: number;
  fileName: string;
}

interface DemoFileResult {
  path: string;
  language: string;
  content: string;
  lines: number;
  criticalCount: number;
  alertCount: number;
  findings: DemoFinding[];
}

interface DemoScanResult {
  name: string;
  repoUrl: string;
  language: string;
  riskScore: number;
  totalLines: number;
  criticalCount: number;
  alertCount: number;
  cleanCount: number;
  totalEffortHours: number;
  executiveSummary: string;
  files: DemoFileResult[];
}

function fileIcon(path: string) {
  const ext = path.split(".").pop() ?? "";
  const icons: Record<string, string> = {
    py: "🐍", js: "🟨", ts: "🔷", go: "🐹", java: "☕",
    rs: "🦀", rb: "💎", php: "🐘",
  };
  return icons[ext] ?? "📄";
}

function CodeViewer({ file, allFindings }: { file: DemoFileResult; allFindings: DemoFinding[] }) {
  const [hoveredLine, setHoveredLine] = useState<number | null>(null);
  const lines = file.content.split("\n");
  const findingsByLine = new Map<number, DemoFinding>();
  for (const f of file.findings) {
    findingsByLine.set(f.lineNumber, f);
  }

  return (
    <div className="flex-1 flex flex-col bg-[#0d0d12] overflow-hidden">
      {/* File tab */}
      <div className="h-9 border-b border-white/10 flex items-center px-4 gap-2 shrink-0 bg-[#111118]">
        <span className="text-xs mr-1">{fileIcon(file.path)}</span>
        <span className="text-xs font-mono text-text-primary">{file.path}</span>
        <div className="ml-auto flex items-center gap-2 text-xs">
          {file.criticalCount > 0 && (
            <span className="text-critical font-mono font-bold">{file.criticalCount} critical</span>
          )}
          {file.alertCount > 0 && (
            <span className="text-alert font-mono font-bold">{file.alertCount} alert</span>
          )}
          {file.criticalCount === 0 && file.alertCount === 0 && (
            <span className="text-safe font-mono flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" /> clean
            </span>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="font-mono text-sm leading-relaxed">
          {lines.map((lineText, idx) => {
            const lineNum = idx + 1;
            const finding = findingsByLine.get(lineNum);
            const isCritical = finding?.severity === "critical";
            const isAlert = finding?.severity === "alert";

            return (
              <div
                key={idx}
                className={`flex group relative transition-colors ${
                  isCritical
                    ? "bg-critical/10 border-l-2 border-critical"
                    : isAlert
                    ? "bg-alert/10 border-l-2 border-alert"
                    : "border-l-2 border-transparent hover:bg-white/[0.03]"
                }`}
                onMouseEnter={() => finding && setHoveredLine(lineNum)}
                onMouseLeave={() => setHoveredLine(null)}
              >
                {/* Line number */}
                <div className={`w-12 shrink-0 text-right pr-3 py-0.5 select-none text-[11px] ${
                  finding ? (isCritical ? "text-critical/70" : "text-alert/70") : "text-white/20"
                }`}>
                  {lineNum}
                </div>

                {/* Severity icon for flagged lines */}
                <div className="w-5 shrink-0 flex items-center justify-center py-0.5">
                  {isCritical && <AlertTriangle className="h-3 w-3 text-critical" />}
                  {isAlert && <Zap className="h-3 w-3 text-alert" />}
                </div>

                {/* Code text */}
                <div className="flex-1 py-0.5 pr-4 whitespace-pre overflow-hidden text-ellipsis">
                  <span className={finding ? (isCritical ? "text-white" : "text-white") : "text-white/70"}>
                    {lineText}
                  </span>
                </div>

                {/* Hover tooltip */}
                {finding && hoveredLine === lineNum && (
                  <div className="absolute left-20 top-full z-30 mt-1 w-80 bg-bg-tertiary border border-white/20 rounded-lg p-3 shadow-2xl pointer-events-none">
                    <div className={`flex items-center gap-2 mb-2 text-sm font-bold ${
                      isCritical ? "text-critical" : "text-alert"
                    }`}>
                      {isCritical ? <AlertTriangle className="h-4 w-4" /> : <Zap className="h-4 w-4" />}
                      {finding.algorithm} — {isCritical ? "Quantum Critical" : "Quantum Alert"}
                    </div>
                    <p className="text-xs text-text-muted mb-2 leading-relaxed">{finding.explanation}</p>
                    {finding.nistReplacement && (
                      <div className="text-xs font-mono text-accent-secondary border-t border-white/10 pt-2 mt-2 flex items-center gap-1">
                        <ChevronRight className="h-3 w-3" />
                        Migrate to: {finding.nistReplacement}
                      </div>
                    )}
                    {finding.nistStandard && (
                      <div className="text-xs text-text-muted mt-1">Standard: {finding.nistStandard}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <div className="h-16" />
        </div>
      </ScrollArea>
    </div>
  );
}

export function Demo() {
  const { slug } = useParams();
  const runDemoScan = useRunDemoScan();
  const { data: demoRepos } = useListDemoRepos();

  const [scanResult, setScanResult] = useState<DemoScanResult | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [selectedFile, setSelectedFile] = useState<DemoFileResult | null>(null);

  const repoInfo = demoRepos?.find((r) => r.slug === slug);

  useEffect(() => {
    if (!slug) return;
    setIsScanning(true);
    setScanResult(null);
    setScanProgress(0);
    setSelectedFile(null);

    // Animate progress while scanning
    const progressInterval = setInterval(() => {
      setScanProgress((p) => Math.min(p + 8, 85));
    }, 120);

    runDemoScan.mutate({ slug } as { slug: string }, {
      onSuccess: (data: any) => {
        clearInterval(progressInterval);
        setScanProgress(100);
        setTimeout(() => {
          setScanResult(data as DemoScanResult);
          setIsScanning(false);
          if (data.files?.length) setSelectedFile(data.files[0]);
        }, 400);
      },
      onError: () => {
        clearInterval(progressInterval);
        setIsScanning(false);
      },
    });

    return () => clearInterval(progressInterval);
  }, [slug]);

  const generateReport = () => {
    if (!scanResult) return;
    const lines = [
      `# QUANTAXSCAN Post-Quantum Audit: ${scanResult.name}`,
      `Date: ${new Date().toISOString()}`,
      `Risk Score: ${scanResult.riskScore}/100`,
      ``,
      `## Executive Summary`,
      scanResult.executiveSummary,
      ``,
      `## Metrics`,
      `- Files Scanned: ${scanResult.files?.length ?? 0}`,
      `- Total Lines: ${scanResult.totalLines.toLocaleString()}`,
      `- Critical Vulnerabilities: ${scanResult.criticalCount}`,
      `- Alerts: ${scanResult.alertCount}`,
      `- Migration Effort: ${scanResult.totalEffortHours}h`,
      ``,
      `## Findings by File`,
    ];
    for (const file of scanResult.files ?? []) {
      if (file.findings.length === 0) {
        lines.push(`\n### ✓ ${file.path} (clean)`);
        continue;
      }
      lines.push(`\n### ⚠ ${file.path} (${file.criticalCount}C / ${file.alertCount}A)`);
      for (const f of file.findings) {
        lines.push(`- Line ${f.lineNumber} [${f.severity.toUpperCase()}] ${f.algorithm} → ${f.nistReplacement ?? "N/A"}`);
        lines.push(`  \`${f.codeSnippet}\``);
      }
    }
    lines.push(`\n---\n*Generated by QuantaXscan Post-Quantum Scanner*`);
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `QUANTAXSCAN_${slug}_${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex-1 flex flex-col h-[calc(100dvh-64px)] overflow-hidden bg-bg-primary">
      {/* Q-Day Banner */}
      <div className="bg-critical/10 border-b border-critical/20 px-4 py-2 flex items-center justify-center text-xs font-medium text-critical gap-2 shrink-0">
        <div className="absolute inset-0 bg-[repeating-linear-gradient(45deg,transparent,transparent_10px,rgba(255,77,77,0.04)_10px,rgba(255,77,77,0.04)_20px)] pointer-events-none" />
        <AlertTriangle className="h-3.5 w-3.5" />
        Q-DAY SIMULATION — RSA, ECDSA, and DH are considered broken in this environment
      </div>

      {/* Header */}
      <div className="h-14 border-b border-white/10 bg-bg-secondary flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded bg-white/5 flex items-center justify-center">
            <GitBranch className="h-4 w-4 text-text-muted" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-bold text-text-primary font-mono">
                {scanResult?.name ?? repoInfo?.name ?? slug}
              </h1>
              {scanResult?.repoUrl && (
                <a
                  href={scanResult.repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-text-muted hover:text-accent-secondary transition-colors"
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            <p className="text-[11px] text-text-muted">{repoInfo?.description ?? "Post-quantum vulnerability scan"}</p>
          </div>
        </div>

        {/* Stats bar */}
        {scanResult && (
          <div className="hidden md:flex items-center gap-4 text-xs">
            <div className="flex items-center gap-1.5 text-critical font-mono font-bold">
              <AlertTriangle className="h-3.5 w-3.5" />
              {scanResult.criticalCount} critical
            </div>
            <div className="flex items-center gap-1.5 text-alert font-mono font-bold">
              <Zap className="h-3.5 w-3.5" />
              {scanResult.alertCount} alerts
            </div>
            <div className="flex items-center gap-1.5 text-text-muted">
              <Clock className="h-3.5 w-3.5" />
              {scanResult.totalEffortHours}h to migrate
            </div>
            <div className={`text-2xl font-black font-mono ${
              scanResult.riskScore >= 70 ? "text-critical" : scanResult.riskScore >= 40 ? "text-alert" : "text-safe"
            }`}>
              {scanResult.riskScore}
              <span className="text-xs font-normal text-text-muted">/100</span>
            </div>
          </div>
        )}

        <Button
          onClick={generateReport}
          disabled={isScanning || !scanResult}
          variant="outline"
          size="sm"
          className="border-white/20 hover:bg-white/10 text-text-primary"
        >
          <Download className="h-4 w-4 mr-2" /> Export Report
        </Button>
      </div>

      {/* Scanning state */}
      {isScanning && (
        <div className="flex-1 flex flex-col items-center justify-center text-text-muted">
          <div className="w-64 mb-6">
            <div className="flex items-center justify-between text-xs mb-2">
              <span className="font-mono text-accent-primary">Scanning {repoInfo?.name ?? slug}…</span>
              <span className="font-mono">{scanProgress}%</span>
            </div>
            <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
              <motion.div
                className="h-full bg-accent-primary rounded-full"
                initial={{ width: 0 }}
                animate={{ width: `${scanProgress}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
          </div>
          <div className="space-y-2 text-xs font-mono text-text-muted/60 text-center">
            {["Fetching source files…", "Parsing cryptographic calls…", "Mapping NIST replacements…"].map((msg, i) => (
              <motion.div
                key={msg}
                initial={{ opacity: 0 }}
                animate={{ opacity: scanProgress > i * 30 ? 1 : 0.3 }}
              >
                {scanProgress > i * 30 ? "✓" : "○"} {msg}
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {/* Main 3-panel layout */}
      {!isScanning && scanResult && (
        <div className="flex-1 flex overflow-hidden">
          {/* LEFT: File tree */}
          <div className="w-64 border-r border-white/10 bg-bg-tertiary flex flex-col shrink-0">
            {/* Project summary */}
            <div className="p-3 border-b border-white/10">
              <div className="text-[10px] text-text-muted uppercase tracking-wider mb-2">Project Files</div>
              <div className="grid grid-cols-2 gap-1.5 text-xs">
                <div className="bg-critical/10 rounded p-1.5 text-center">
                  <div className="font-bold text-critical font-mono">{scanResult.criticalCount}</div>
                  <div className="text-text-muted text-[10px]">Critical</div>
                </div>
                <div className="bg-alert/10 rounded p-1.5 text-center">
                  <div className="font-bold text-alert font-mono">{scanResult.alertCount}</div>
                  <div className="text-text-muted text-[10px]">Alerts</div>
                </div>
              </div>
              <div className="mt-2 text-[10px] text-text-muted font-mono">
                {scanResult.totalLines.toLocaleString()} lines · {scanResult.files?.length ?? 0} files
              </div>
            </div>

            {/* File list */}
            <ScrollArea className="flex-1 p-2">
              {scanResult.files?.map((file) => {
                const isSelected = selectedFile?.path === file.path;
                const hasCritical = file.criticalCount > 0;
                const hasAlert = file.alertCount > 0;
                const isClean = !hasCritical && !hasAlert;

                return (
                  <button
                    key={file.path}
                    onClick={() => setSelectedFile(file)}
                    className={`w-full flex items-center gap-2 p-2 rounded text-left text-xs transition-colors mb-0.5 ${
                      isSelected
                        ? "bg-accent-primary/15 border border-accent-primary/30"
                        : "hover:bg-white/5 border border-transparent"
                    }`}
                  >
                    {/* Risk indicator */}
                    <div className={`h-2 w-2 rounded-full shrink-0 ${
                      hasCritical ? "bg-critical shadow-[0_0_4px_rgba(255,77,77,0.8)]" :
                      hasAlert ? "bg-alert shadow-[0_0_4px_rgba(255,193,7,0.8)]" :
                      "bg-safe/40"
                    }`} />

                    <span className="text-xs">{fileIcon(file.path)}</span>

                    <div className="flex-1 min-w-0">
                      <div className={`truncate font-mono ${isSelected ? "text-text-primary" : "text-text-muted"}`}>
                        {file.path.split("/").pop()}
                      </div>
                      <div className="text-text-muted/60 text-[10px] truncate">{file.path.split("/").slice(0, -1).join("/")}</div>
                    </div>

                    <div className="flex gap-1 shrink-0 text-[10px] font-mono">
                      {hasCritical && <span className="text-critical font-bold">{file.criticalCount}C</span>}
                      {hasAlert && <span className="text-alert font-bold">{file.alertCount}A</span>}
                      {isClean && <span className="text-safe opacity-60">✓</span>}
                    </div>
                  </button>
                );
              })}
            </ScrollArea>
          </div>

          {/* CENTER: Code viewer */}
          {selectedFile ? (
            <CodeViewer file={selectedFile} allFindings={scanResult.files?.flatMap((f) => f.findings) ?? []} />
          ) : (
            <div className="flex-1 flex items-center justify-center bg-[#0d0d12] text-text-muted">
              <div className="text-center">
                <FileCode className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p className="text-sm">Select a file to view its code</p>
              </div>
            </div>
          )}

          {/* RIGHT: Findings panel */}
          <div className="w-72 border-l border-white/10 bg-bg-secondary flex flex-col shrink-0">
            <div className="p-3 border-b border-white/10 text-[10px] text-text-muted uppercase tracking-wider flex items-center justify-between">
              <span>Findings {selectedFile ? `— ${selectedFile.path.split("/").pop()}` : ""}</span>
              {selectedFile && (
                <span className="font-mono normal-case text-text-muted/60">
                  {selectedFile.findings.length} issue{selectedFile.findings.length !== 1 ? "s" : ""}
                </span>
              )}
            </div>

            <ScrollArea className="flex-1">
              {selectedFile && selectedFile.findings.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                  <div className="h-12 w-12 rounded-full bg-safe/10 flex items-center justify-center mb-3">
                    <Shield className="h-6 w-6 text-safe" />
                  </div>
                  <p className="text-sm text-text-primary font-medium mb-1">No vulnerabilities</p>
                  <p className="text-xs text-text-muted">This file uses no quantum-vulnerable cryptography.</p>
                </div>
              )}

              {selectedFile && selectedFile.findings.length > 0 && (
                <div className="p-3 space-y-3">
                  {selectedFile.findings.map((finding, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.05 }}
                      className={`rounded-lg border p-3 ${
                        finding.severity === "critical"
                          ? "border-critical/30 bg-critical/5"
                          : "border-alert/30 bg-alert/5"
                      }`}
                    >
                      {/* Header */}
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-1.5">
                          {finding.severity === "critical" ? (
                            <AlertTriangle className="h-3.5 w-3.5 text-critical" />
                          ) : (
                            <Zap className="h-3.5 w-3.5 text-alert" />
                          )}
                          <span className={`text-sm font-bold font-mono ${
                            finding.severity === "critical" ? "text-critical" : "text-alert"
                          }`}>
                            {finding.algorithm}
                          </span>
                        </div>
                        <span className="text-[10px] text-text-muted font-mono">L{finding.lineNumber}</span>
                      </div>

                      {/* Code snippet */}
                      <div className="font-mono text-[11px] bg-black/30 rounded px-2 py-1 text-white/70 truncate mb-2">
                        {finding.codeSnippet}
                      </div>

                      {/* Explanation */}
                      <p className="text-[11px] text-text-muted leading-relaxed mb-2">{finding.explanation}</p>

                      {/* NIST replacement */}
                      {finding.nistReplacement && (
                        <div className="flex items-center gap-1 text-[11px] font-mono text-accent-secondary">
                          <ChevronRight className="h-3 w-3 shrink-0" />
                          {finding.nistReplacement}
                        </div>
                      )}

                      {/* Footer */}
                      <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/10 text-[10px] text-text-muted">
                        {finding.nistStandard && <span>{finding.nistStandard}</span>}
                        {finding.effortHours > 0 && (
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {finding.effortHours}h effort
                          </span>
                        )}
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}

              {/* Summary at bottom */}
              {scanResult.executiveSummary && (
                <div className="p-3 border-t border-white/10 mt-2">
                  <div className="text-[10px] text-text-muted uppercase tracking-wider mb-2">Executive Summary</div>
                  <p className="text-[11px] text-text-muted/80 leading-relaxed italic">
                    "{scanResult.executiveSummary}"
                  </p>
                </div>
              )}
            </ScrollArea>
          </div>
        </div>
      )}

      {/* Error state */}
      {!isScanning && !scanResult && (
        <div className="flex-1 flex items-center justify-center text-critical">
          Failed to load demo. Please try again.
        </div>
      )}
    </div>
  );
}
