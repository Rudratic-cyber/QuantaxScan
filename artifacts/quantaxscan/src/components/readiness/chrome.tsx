import { AlertTriangle } from "lucide-react";

/**
 * D1 — shared chrome for the CISA readiness dashboard's panels.
 *
 * Same visual language as `CoverageMeter` and `PostureTimeline` (D3, D7) —
 * white card, `#e5e7eb` border, the same soft shadow, mono uppercase eyebrow
 * labels — deliberately duplicated rather than imported from those files,
 * matching how they each already define their own copy rather than sharing
 * one. Centralised here only so the five-plus panels this page adds do not
 * each redefine it a fifth time.
 */

export const COLOR = {
  ink: "#0a0e1a",
  muted: "#6b7280",
  faint: "#9aa3b2",
  rule: "#e5e7eb",
  accent: "#4f46e5",
  examined: "#4f46e5",
  clean: "#059669",
  unexamined: "#d97706",
  failed: "#dc2626",
};

/** One colour per Q-Day scenario, urgency-ordered — matches `PostureTimeline`'s `SCENARIO_COLOR` exactly, so a reader sees one colour per scenario across the whole page. */
export const SCENARIO_COLOR: Record<string, string> = {
  conservative: "#dc2626",
  central: "#d97706",
  aggressive: "#0d9488",
};

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="text-[9px] font-mono text-[#4f46e5] uppercase tracking-widest">{children}</p>;
}

export function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-[#e5e7eb] bg-white p-5 ${className}`} style={{ boxShadow: "0 8px 24px rgba(15,23,42,0.06)" }}>
      {children}
    </div>
  );
}

/**
 * A failed request renders this, never zeros or an empty state — the same
 * rule `CoverageMeter` and `PostureTimeline` hold. A guessed reading here is
 * worse than admitting the panel could not be read.
 */
export function ErrorNotice({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border p-4" style={{ borderColor: `${COLOR.failed}33`, background: `${COLOR.failed}08` }}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: COLOR.failed }} />
      <div>
        <p className="text-xs font-semibold text-[#0a0e1a]">{title}</p>
        <p className="mt-1 font-mono text-[10px] text-[#6b7280]">{detail}</p>
      </div>
    </div>
  );
}
