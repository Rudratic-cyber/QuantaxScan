import { motion } from "framer-motion";
import { ScanSearch, Check, Minus, Gauge } from "lucide-react";
import { Panel, Eyebrow, ErrorNotice, COLOR } from "./chrome";
import { StatusPill } from "@/components/marketing/primitives";
import { COLLECTOR_SURFACE_LIST } from "@/lib/collector-surfaces";
import type { EstateCoverage, SurfaceState } from "./types";

/**
 * D1 Row 3 — coverage and confidence, estate-wide.
 * docs/Claude/06-cisa-dashboard.md §"Row 3 — the most important panel".
 *
 * The estate equivalent of `CoverageMeter` (D3, per-project): same ten
 * catalogue surfaces, same three states, same refusal to turn
 * `examinedSurfaces / totalSurfaces` into a percentage of the estate — how
 * much cryptography sits inside the surfaces nobody has looked at is
 * unknowable from this data. Reads `/api/inventory/readiness`'s `coverage`
 * block, which is computed over every project in the organisation at once,
 * including assets no project can claim (TLS, certificates, KMS).
 */

function stateColor(state: SurfaceState) {
  if (state === "examined") return COLOR.examined;
  if (state === "examined-nothing-found") return COLOR.clean;
  return COLOR.unexamined;
}

function SurfaceBar({ rows }: { rows: Array<{ id: string; name: string; state: SurfaceState }> }) {
  return (
    <div className="flex gap-1" role="img" aria-label={`${rows.filter((r) => r.state !== "never-examined").length} of ${rows.length} collector surfaces examined, estate-wide`}>
      {rows.map((row, i) => (
        <motion.div
          key={row.id}
          title={`${row.name} — ${row.state === "never-examined" ? "never examined" : row.state === "examined" ? "examined" : "examined, nothing found"}`}
          initial={{ opacity: 0, scaleY: 0.4 }}
          animate={{ opacity: 1, scaleY: 1 }}
          transition={{ duration: 0.4, delay: 0.03 * i, ease: [0.22, 1, 0.36, 1] }}
          className="h-8 flex-1 rounded-[3px]"
          style={
            row.state === "never-examined"
              ? {
                  backgroundImage: `repeating-linear-gradient(45deg, ${COLOR.unexamined}22 0 5px, ${COLOR.unexamined}0d 5px 10px)`,
                  border: `1px solid ${COLOR.unexamined}55`,
                }
              : { background: stateColor(row.state) }
          }
        />
      ))}
    </div>
  );
}

export function EstateCoveragePanel({
  coverage,
  error,
  loading,
}: {
  coverage: EstateCoverage | null;
  error: string | null;
  loading: boolean;
}) {
  const coverageBySurfaceId = new Map(coverage?.surfaces.filter((s) => s.surfaceId !== null).map((s) => [s.surfaceId as string, s]) ?? []);
  const rows = COLLECTOR_SURFACE_LIST.map((entry) => {
    const row = coverageBySurfaceId.get(entry.id);
    return { ...entry, coverage: row, state: (row?.state ?? "never-examined") as SurfaceState };
  });

  const examined = coverage?.examinedSurfaces ?? 0;
  const total = coverage?.totalSurfaces ?? COLLECTOR_SURFACE_LIST.length;
  const unexamined = total - examined;

  return (
    <Panel>
      <div className="mb-4 flex items-center gap-2">
        <ScanSearch className="h-3.5 w-3.5 text-[#4f46e5]" />
        <Eyebrow>Estate coverage — what we have not looked at, across every project</Eyebrow>
      </div>

      {loading && coverage === null && (
        <p className="py-8 text-center font-mono text-xs text-[#9aa3b2]">Loading coverage…</p>
      )}

      {error !== null && (
        <ErrorNotice
          title="Coverage could not be read."
          detail={`${error} No figure is shown rather than a default one.`}
        />
      )}

      {coverage !== null && error === null && (
        <>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-3xl font-bold text-[#0a0e1a]">{examined}</span>
                <span className="font-mono text-lg text-[#9aa3b2]">/ {total}</span>
                <span className="text-sm font-semibold text-[#0a0e1a]">collector surfaces examined</span>
              </div>
              <p className="mt-1 text-[11px]" style={{ color: COLOR.unexamined }}>
                <span className="font-semibold">{unexamined} of {total} have never been examined, anywhere in this estate.</span>{" "}
                Nothing has been collected from them, so this inventory contains no finding from them — and cannot rule
                one out.
              </p>
            </div>
          </div>

          <SurfaceBar rows={rows.map((r) => ({ id: r.id, name: r.name, state: r.state }))} />

          <p className="mt-2 font-mono text-[9px] leading-relaxed text-[#9aa3b2]">
            One block per collector surface — not a percentage of your estate. How much cryptography sits inside the
            unexamined surfaces is not estimable from anything we hold, and this panel will not guess.
          </p>

          <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div>
              <Eyebrow>Surface by surface</Eyebrow>
              <div className="mt-2 divide-y divide-[#f1f3f7]">
                {rows.map((row) => (
                  <div key={row.id} className="flex items-start justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-block h-2 w-2 shrink-0 rounded-full"
                          style={{ background: stateColor(row.state), opacity: row.state === "never-examined" ? 0.6 : 1 }}
                        />
                        <span className="truncate text-[12px] font-semibold text-[#0a0e1a]">{row.name}</span>
                      </div>
                      <p className="mt-0.5 pl-4 font-mono text-[10px] leading-relaxed text-[#6b7280]">
                        {row.state === "examined" && row.coverage && (
                          <>
                            {row.coverage.activeAssets} in inventory
                            {row.coverage.assets !== row.coverage.activeAssets && ` (+${row.coverage.assets - row.coverage.activeAssets} historical)`}
                          </>
                        )}
                        {row.state === "examined-nothing-found" && "examined, nothing found"}
                        {row.state === "never-examined" && (row.status === "planned" ? "no collector has shipped for this surface" : "no collection run in this estate")}
                        {row.coverage && row.coverage.failedRuns > 0 && (
                          <span style={{ color: COLOR.failed }}>
                            {" · "}{row.coverage.failedRuns} failed {row.coverage.failedRuns === 1 ? "attempt" : "attempts"}, not counted as coverage
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="shrink-0">
                      {row.state === "never-examined" ? (
                        <StatusPill status="never-examined" />
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold"
                          style={{ background: `${stateColor(row.state)}14`, color: stateColor(row.state) }}
                        >
                          {row.state === "examined" ? <Check className="h-3 w-3" /> : <Minus className="h-3 w-3" />}
                          {row.state === "examined" ? "Examined" : "Nothing found"}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center gap-2">
                <Gauge className="h-3.5 w-3.5 text-[#4f46e5]" />
                <Eyebrow>Confidence of what was found</Eyebrow>
              </div>
              <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-[10px] text-[#6b7280]">
                <span>scored <span className="text-[#0a0e1a]">{coverage.confidence.scored}</span></span>
                <span>unscored <span className="text-[#0a0e1a]">{coverage.confidence.unscored}</span></span>
                <span>mean <span className="text-[#0a0e1a]">{coverage.confidence.mean === null ? "—" : coverage.confidence.mean.toFixed(2)}</span></span>
              </div>
              <p className="mt-2 font-mono text-[9px] leading-relaxed text-[#9aa3b2]">
                Basis: {coverage.confidence.basis}. Estate-wide — one point per active asset across every project, not
                per observation.
              </p>
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}
