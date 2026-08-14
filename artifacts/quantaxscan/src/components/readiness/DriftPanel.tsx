import { GitCompareArrows } from "lucide-react";
import { Panel, Eyebrow, ErrorNotice, COLOR } from "./chrome";

/**
 * D1 Row 6 — drift.
 * docs/Claude/06-cisa-dashboard.md §"Row 6": "An inventory that does not
 * detect newly introduced RSA is a report, not an inventory."
 *
 * Reads `statusCounts` from `/api/inventory/assets`, which — unlike
 * `assets` itself — covers every status in the organisation including
 * `gone`, so a removed asset can be reported here without ever appearing in
 * the inventory table as if still present. "New since last collection" is
 * the estate posture panel's own `assetsAdded` field, on the timeline
 * below this row; this panel does not restate it with a second fetch, and
 * says so rather than leaving the reader to wonder where "new" went.
 */

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  remediated: "Remediated",
  waived: "Waived",
  gone: "Removed (gone)",
};

const STATUS_COLOR: Record<string, string> = {
  active: COLOR.accent,
  remediated: COLOR.clean,
  waived: COLOR.unexamined,
  gone: COLOR.muted,
};

export function DriftPanel({
  statusCounts,
  error,
  loading,
}: {
  statusCounts: Record<string, number> | null;
  error: string | null;
  loading: boolean;
}) {
  const entries = Object.entries(statusCounts ?? {}).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);

  return (
    <Panel>
      <div className="mb-3 flex items-center gap-2">
        <GitCompareArrows className="h-3.5 w-3.5 text-[#4f46e5]" />
        <Eyebrow>Drift — every status this estate's assets have ever held</Eyebrow>
      </div>

      {loading && statusCounts === null && (
        <p className="py-6 text-center font-mono text-xs text-[#9aa3b2]">Loading…</p>
      )}
      {error !== null && <ErrorNotice title="Could not be read." detail={error} />}

      {statusCounts !== null && error === null && (
        <>
          {total === 0 ? (
            <p className="py-6 text-center font-mono text-xs text-[#9aa3b2]">No assets recorded yet — nothing to compare against.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {entries.map(([status, count]) => (
                <div key={status} className="rounded-xl border border-[#eceef2] bg-[#f7f8fa] p-3 text-center">
                  <p className="font-mono text-2xl font-bold" style={{ color: STATUS_COLOR[status] ?? COLOR.muted }}>{count}</p>
                  <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-[#6b7280]">{STATUS_LABEL[status] ?? status}</p>
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 font-mono text-[9px] leading-relaxed text-[#9aa3b2]">
            "New / changed since last collection" is the estate posture panel's own measured history, below — its
            most recent point states how many assets entered the inventory at that instant. This panel is the
            lifecycle counts, not a second copy of that series.
          </p>
        </>
      )}
    </Panel>
  );
}
