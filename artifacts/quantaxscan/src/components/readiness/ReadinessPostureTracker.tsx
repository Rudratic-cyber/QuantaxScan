import { ClipboardList, Minus } from "lucide-react";
import { motion } from "framer-motion";
import { Panel, Eyebrow, ErrorNotice, COLOR } from "./chrome";
import { StatusPill } from "@/components/marketing/primitives";
import type { ReadinessSection } from "./types";

/**
 * D1 Row 1 — the readiness posture tracker.
 * docs/Claude/06-cisa-dashboard.md §"Row 1".
 *
 * Five sections, each labelled against the joint CISA/NSA/NIST factsheet
 * (August 2023) and never presented as a numbered stage sequence — the doc
 * is explicit that an earlier draft invented one and that mistake must not
 * repeat. A `not-tracked` section renders as a dash and a reason, the same
 * "never-examined" vocabulary `CoverageMeter` uses for a surface nobody has
 * looked at — never as 0%, which would claim a measurement nobody took.
 * There is deliberately no combined score across the five: averaging a
 * measured section with an untracked one would invent a denominator.
 */

function SectionBar({ section }: { section: ReadinessSection }) {
  const tracked = section.state === "tracked" && section.percentComplete !== null;
  const pct = section.percentComplete ?? 0;
  const barColor = pct >= 80 ? COLOR.clean : pct >= 40 ? COLOR.unexamined : COLOR.failed;

  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold text-[#0a0e1a]">{section.label}</p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-[#6b7280]">{section.definition}</p>
        </div>
        <div className="shrink-0 text-right">
          {tracked ? (
            <span className="font-mono text-lg font-bold" style={{ color: barColor }}>{pct}%</span>
          ) : (
            <StatusPill status="never-examined" />
          )}
        </div>
      </div>

      {tracked ? (
        <div className="mt-2 h-2 w-full rounded-full bg-[#f1f3f7]">
          <motion.div
            className="h-full rounded-full"
            style={{ background: barColor }}
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>
      ) : (
        <div
          className="mt-2 h-2 w-full rounded-full"
          style={{
            backgroundImage: `repeating-linear-gradient(45deg, ${COLOR.unexamined}22 0 5px, ${COLOR.unexamined}0d 5px 10px)`,
            border: `1px solid ${COLOR.unexamined}55`,
          }}
        />
      )}

      <p className="mt-1.5 flex items-start gap-1.5 text-[10px] leading-relaxed text-[#9aa3b2]">
        {!tracked && <Minus className="mt-0.5 h-3 w-3 shrink-0" style={{ color: COLOR.unexamined }} />}
        {section.reason}
        {tracked && section.numerator !== null && section.denominator !== null && (
          <span className="font-mono text-[#6b7280]"> ({section.numerator} of {section.denominator})</span>
        )}
      </p>
    </div>
  );
}

export function ReadinessPostureTracker({
  sections,
  framing,
  error,
  loading,
}: {
  sections: ReadinessSection[] | null;
  framing: string | null;
  error: string | null;
  loading: boolean;
}) {
  return (
    <Panel>
      <div className="mb-1 flex items-center gap-2">
        <ClipboardList className="h-3.5 w-3.5 text-[#4f46e5]" />
        <Eyebrow>Readiness posture</Eyebrow>
      </div>
      {framing && <p className="mb-4 text-[10px] leading-relaxed text-[#9aa3b2]">{framing}</p>}

      {loading && sections === null && (
        <p className="py-8 text-center font-mono text-xs text-[#9aa3b2]">Loading readiness posture…</p>
      )}

      {error !== null && (
        <ErrorNotice
          title="Readiness posture could not be read."
          detail={`${error} No section is shown as complete or incomplete rather than guessed.`}
        />
      )}

      {sections !== null && error === null && (
        <div className="divide-y divide-[#f1f3f7]">
          {sections.map((section) => (
            <SectionBar key={section.id} section={section} />
          ))}
        </div>
      )}

      <p className="mt-4 font-mono text-[9px] leading-relaxed text-[#9aa3b2]">
        No combined score is shown across these five — averaging a measured section against one this product
        cannot track yet would invent a denominator nobody could defend.
      </p>
    </Panel>
  );
}
