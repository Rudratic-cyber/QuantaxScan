import { CalendarClock } from "lucide-react";
import { Panel, Eyebrow, ErrorNotice, COLOR } from "./chrome";
import { StatusPill } from "@/components/marketing/primitives";
import type { EnrichedInventoryAsset } from "./types";

/**
 * D1 Row 5 — time pressure.
 * docs/Claude/06-cisa-dashboard.md §"Row 5 — Time pressure".
 *
 * Two charts the spec asks for: certificate expiry vs. Q-Day, and a
 * deprecation runway bucketed by refresh cycle. Neither has real data
 * behind it today, and the honest choice — per the doc's own "empty states
 * are a feature" note — is to render both as real, present panels in their
 * never-examined state rather than omit them. Omitting this row is the
 * dishonest option: "does this include the certificates?" has to be
 * answerable from the page, not from its absence.
 *
 *  - **Certificate expiry**: `certificate` is a `planned`, not `live`,
 *    collector surface (`surface-catalogue.ts`) — nothing has ever examined
 *    a certificate, so this can only ever be empty until that collector
 *    ships. Filters the shared asset list for `surface === "certificate"`
 *    rather than a second fetch.
 *  - **Deprecation runway**: needs a refresh-cycle field this product does
 *    not have on any asset (deployment/hardware refresh cadence is not
 *    collected at all, OT least of all). The obligation *deadlines* it
 *    would bucket by do exist — via the C1 mapping engine, in the estate
 *    posture panel elsewhere on this page — but "years until the next
 *    refresh cycle" cannot be computed from anything held here, so this
 *    stays a stated gap rather than a chart with an invented axis.
 */

export function TimePressurePanel({
  assets,
  error,
  loading,
}: {
  assets: EnrichedInventoryAsset[] | null;
  error: string | null;
  loading: boolean;
}) {
  const certificates = assets?.filter((a) => a.surface === "certificate") ?? [];

  return (
    <Panel>
      <div className="mb-4 flex items-center gap-2">
        <CalendarClock className="h-3.5 w-3.5 text-[#4f46e5]" />
        <Eyebrow>Time pressure</Eyebrow>
      </div>

      {loading && assets === null && (
        <p className="py-6 text-center font-mono text-xs text-[#9aa3b2]">Loading…</p>
      )}
      {error !== null && (
        <ErrorNotice title="Could not be read." detail={error} />
      )}

      {assets !== null && error === null && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div>
            <p className="mb-1 text-[11px] font-semibold text-[#0a0e1a]">Certificate expiry vs. Q-Day</p>
            {certificates.length === 0 ? (
              <div className="rounded-xl border p-4" style={{ borderColor: `${COLOR.unexamined}33`, background: `${COLOR.unexamined}08` }}>
                <div className="mb-2"><StatusPill status="never-examined" /></div>
                <p className="text-[11px] leading-relaxed text-[#475569]">
                  No certificate has ever been examined — the certificate collector has not shipped (see the coverage
                  panel above). This is a stated blind spot, not a chart showing zero certs at risk.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-[#f1f3f7]">
                {certificates.map((cert) => (
                  <div key={cert.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="truncate font-mono text-[11px] text-[#0a0e1a]">{cert.location}</span>
                    <span className="shrink-0 font-mono text-[10px] text-[#6b7280]">{cert.algorithm}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <p className="mb-1 text-[11px] font-semibold text-[#0a0e1a]">Deprecation runway</p>
            <div className="rounded-xl border p-4" style={{ borderColor: `${COLOR.unexamined}33`, background: `${COLOR.unexamined}08` }}>
              <div className="mb-2"><StatusPill status="never-examined" /></div>
              <p className="text-[11px] leading-relaxed text-[#475569]">
                Bucketing assets by how many hardware or renewal refresh cycles remain before a dated obligation
                takes effect needs a refresh-cadence field this product does not collect for any asset — OT least of
                all, where that cycle is often 7&ndash;15 years. The obligation deadlines themselves are real and are
                plotted against the estate below; the refresh-cycle axis is the part that is not collected yet.
              </p>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}
