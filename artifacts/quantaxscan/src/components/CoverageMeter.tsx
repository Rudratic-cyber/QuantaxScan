import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ScanSearch, AlertTriangle, Check, Minus, Gauge } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { apiUrl } from "@/lib/api";
import { COLLECTOR_SURFACE_LIST, TOTAL_SURFACE_COUNT } from "@/lib/collector-surfaces";
import { StatusPill } from "@/components/marketing/primitives";

/**
 * D3 — the coverage and confidence meter. docs/Claude/03-features.md §D3.
 *
 * "Most security dashboards only show what they found, which silently implies
 * complete coverage. For an inventory product that is a credibility-destroying
 * omission." Everything visually loud in this panel is therefore about the
 * surfaces nobody has looked at, not the one that has been.
 *
 * Three rules this component is written to obey:
 *
 *  - **The denominator is surfaces, not assets.** How much cryptography sits in
 *    the nine unexamined surfaces is unknowable from our data, so this panel
 *    never estimates it and says as much on the page. `1 / 10` is a count of
 *    collectors, and the caption forbids reading it as a percentage of the estate.
 *  - **A failed run is not coverage,** and an examined-but-empty surface is not
 *    the same as an unexamined one. Both distinctions come from the API.
 *  - **A failed request renders an error, never zeros.** A panel whose entire
 *    job is to state what is missing must not invent a reading when it has none.
 */

const COLOR = {
  examined: "#4f46e5",
  clean: "#059669",
  unexamined: "#d97706",
  failed: "#dc2626",
  muted: "#9aa3b2",
};

type SurfaceState = "examined" | "examined-nothing-found" | "never-examined";

interface SurfaceCoverage {
  surface: string;
  surfaceId: string | null;
  state: SurfaceState;
  completedRuns: number;
  failedRuns: number;
  lastExaminedAt: string | null;
  assets: number;
  activeAssets: number;
}

interface ConfidenceBucket { label: string; lower: number; upper: number; count: number }

interface CoverageResponse {
  projectId: number;
  generatedAt: string;
  examinedSurfaces: number;
  totalSurfaces: number;
  surfaces: SurfaceCoverage[];
  confidence: {
    basis: string;
    scored: number;
    unscored: number;
    excludedByAssetStatus: Record<string, number>;
    distinctValues: number;
    min: number | null;
    max: number | null;
    mean: number | null;
    buckets: ConfidenceBucket[];
  };
}

function useProjectCoverage(projectId: number | null) {
  const [data, setData] = useState<CoverageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (projectId === null) { setData(null); setError(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(apiUrl(`/api/projects/${projectId}/coverage`))
      .then(async (r) => {
        if (!r.ok) throw new Error(`Coverage request failed (HTTP ${r.status})`);
        return (await r.json()) as CoverageResponse;
      })
      .then((payload) => { if (!cancelled) { setData(payload); setLoading(false); } })
      .catch((err: Error) => { if (!cancelled) { setError(err.message); setData(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, [projectId]);

  return { data, error, loading };
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="text-[9px] font-mono text-[#4f46e5] uppercase tracking-widest">{children}</p>;
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5" style={{ boxShadow: "0 8px 24px rgba(15,23,42,0.06)" }}>
      {children}
    </div>
  );
}

function stateColor(state: SurfaceState) {
  if (state === "examined") return COLOR.examined;
  if (state === "examined-nothing-found") return COLOR.clean;
  return COLOR.unexamined;
}

/**
 * Ten segments, one per collector surface — deliberately not a continuous
 * progress bar. A continuous bar invites "we are 10% covered"; a row of ten
 * labelled blocks can only be read as "one of these ten things has been done".
 */
function SurfaceBar({ rows }: { rows: Array<{ id: string; name: string; state: SurfaceState }> }) {
  return (
    <div className="flex gap-1" role="img" aria-label={`${rows.filter(r => r.state !== "never-examined").length} of ${rows.length} collector surfaces examined`}>
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
                  // Hatched, not solid grey: an unexamined surface is an open
                  // question, and grey reads as "nothing to see here".
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

function ConfidenceHistogram({ buckets, scored }: { buckets: ConfidenceBucket[]; scored: number }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className="space-y-1.5">
      {buckets.map((bucket, i) => {
        const empty = bucket.count === 0;
        return (
          <div key={bucket.label} className="flex items-center gap-2">
            <span className="w-[52px] shrink-0 text-right font-mono text-[10px] text-[#6b7280]">{bucket.label}</span>
            <div className="h-4 flex-1 rounded-[3px] bg-[#f1f3f7]">
              {!empty && (
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${(bucket.count / max) * 100}%` }}
                  transition={{ duration: 0.7, delay: 0.05 * i, ease: [0.22, 1, 0.36, 1] }}
                  className="h-full rounded-[3px]"
                  style={{ background: COLOR.examined }}
                />
              )}
            </div>
            <span className="w-14 shrink-0 font-mono text-[10px]" style={{ color: empty ? COLOR.muted : "#0a0e1a" }}>
              {bucket.count === 0 ? "none" : `${bucket.count}`}
            </span>
          </div>
        );
      })}
      <p className="pt-1 font-mono text-[9px] text-[#9aa3b2]">
        {scored === 0
          ? "No observation has been recorded for this project."
          : `${scored} inventory ${scored === 1 ? "entry" : "entries"}, one point each — a re-scan does not reweight this.`}
      </p>
    </div>
  );
}

export function CoverageMeter({ projectId }: { projectId: number | null }) {
  const { data, error, loading } = useProjectCoverage(projectId);

  const coverageBySurfaceId = new Map<string, SurfaceCoverage>();
  for (const row of data?.surfaces ?? []) {
    if (row.surfaceId !== null) coverageBySurfaceId.set(row.surfaceId, row);
  }

  const rows = COLLECTOR_SURFACE_LIST.map((entry) => {
    const coverage = coverageBySurfaceId.get(entry.id);
    return {
      ...entry,
      coverage,
      state: (coverage?.state ?? "never-examined") as SurfaceState,
    };
  });

  const examined = data?.examinedSurfaces ?? 0;
  const total = data?.totalSurfaces ?? TOTAL_SURFACE_COUNT;
  const unexamined = total - examined;
  const topBucket = data?.confidence.buckets[data.confidence.buckets.length - 1];

  return (
    <Panel>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ScanSearch className="h-3.5 w-3.5 text-[#4f46e5]" />
          <Eyebrow>Coverage &amp; Confidence — what we have not looked at</Eyebrow>
        </div>
        {data && (
          <span className="font-mono text-[9px] text-[#9aa3b2]">
            as of {formatDistanceToNow(new Date(data.generatedAt))} ago
          </span>
        )}
      </div>

      {projectId === null && (
        <p className="py-8 text-center font-mono text-xs text-[#9aa3b2]">Select a project to see its coverage.</p>
      )}

      {projectId !== null && loading && !data && (
        <p className="py-8 text-center font-mono text-xs text-[#9aa3b2]">Loading coverage…</p>
      )}

      {/* An error must not be rendered as a full bar, an empty bar, or a zero.
          This panel's only job is to state what is missing; a fabricated
          reading here is worse than no panel at all. */}
      {projectId !== null && error && (
        <div className="flex items-start gap-2 rounded-xl border p-4" style={{ borderColor: `${COLOR.failed}33`, background: `${COLOR.failed}08` }}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: COLOR.failed }} />
          <div>
            <p className="text-xs font-semibold text-[#0a0e1a]">Coverage could not be read.</p>
            <p className="mt-1 font-mono text-[10px] text-[#6b7280]">{error}</p>
            <p className="mt-1 text-[11px] text-[#6b7280]">
              No figure is shown rather than a default one — this panel reports what has not been examined, and a
              guessed value would be the exact claim it exists to prevent.
            </p>
          </div>
        </div>
      )}

      {projectId !== null && data && (
        <>
          {/* headline */}
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-3xl font-bold text-[#0a0e1a]">{examined}</span>
                <span className="font-mono text-lg text-[#9aa3b2]">/ {total}</span>
                <span className="text-sm font-semibold text-[#0a0e1a]">collector surfaces examined</span>
              </div>
              <p className="mt-1 text-[11px]" style={{ color: COLOR.unexamined }}>
                <span className="font-semibold">{unexamined} of {total} have never been examined.</span>{" "}
                Nothing has been collected from them, so this inventory contains no finding from them — and cannot
                rule one out.
              </p>
            </div>
          </div>

          <SurfaceBar rows={rows.map((r) => ({ id: r.id, name: r.name, state: r.state }))} />

          <p className="mt-2 font-mono text-[9px] leading-relaxed text-[#9aa3b2]">
            One block per collector surface — not a percentage of your estate. How many assets sit inside the
            unexamined surfaces is not estimable from anything we hold, and this panel will not guess.
          </p>

          <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
            {/* per-surface list */}
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
                            {row.coverage.lastExaminedAt && ` · last examined ${formatDistanceToNow(new Date(row.coverage.lastExaminedAt))} ago`}
                          </>
                        )}
                        {row.state === "examined-nothing-found" && row.coverage && (
                          <>
                            examined, nothing found
                            {row.coverage.lastExaminedAt && ` · ${formatDistanceToNow(new Date(row.coverage.lastExaminedAt))} ago`}
                          </>
                        )}
                        {row.state === "never-examined" && (
                          <>
                            {row.status === "planned" ? "no collector has shipped for this surface" : "no collection run against this project"}
                            {row.surface === null && " · the inventory model has no place to record it yet"}
                          </>
                        )}
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

            {/* confidence */}
            <div>
              <div className="flex items-center gap-2">
                <Gauge className="h-3.5 w-3.5 text-[#4f46e5]" />
                <Eyebrow>Confidence of what was found</Eyebrow>
              </div>

              <div className="mt-2 mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-[10px] text-[#6b7280]">
                <span>
                  highest <span className="text-[#0a0e1a]">{data.confidence.max === null ? "—" : data.confidence.max.toFixed(2)}</span>
                </span>
                <span>
                  lowest <span className="text-[#0a0e1a]">{data.confidence.min === null ? "—" : data.confidence.min.toFixed(2)}</span>
                </span>
                <span>
                  distinct values <span className="text-[#0a0e1a]">{data.confidence.distinctValues}</span>
                </span>
              </div>

              <ConfidenceHistogram buckets={data.confidence.buckets} scored={data.confidence.scored} />

              {topBucket && topBucket.count === 0 && data.confidence.scored > 0 && (
                <p className="mt-3 rounded-lg px-3 py-2 text-[11px] leading-relaxed" style={{ background: `${COLOR.unexamined}0f`, color: "#7c4a03" }}>
                  Nothing in this inventory is high-confidence evidence. Every entry is a source pattern match, which
                  matches prose, comments and variable names as readily as real cryptography. A negotiated TLS
                  handshake or a parsed certificate would land in the top band; no collector produces one yet.
                </p>
              )}

              <p className="mt-3 font-mono text-[9px] leading-relaxed text-[#9aa3b2]">
                Basis: {data.confidence.basis}.
                {data.confidence.unscored > 0 && ` ${data.confidence.unscored} inventory entries carry no observation at all.`}
                {Object.entries(data.confidence.excludedByAssetStatus).length > 0 &&
                  ` Excluded: ${Object.entries(data.confidence.excludedByAssetStatus)
                    .map(([status, n]) => `${n} ${status}`)
                    .join(", ")}.`}
                {" "}Filtering the findings list by confidence is not available yet — findings and observations are
                still separate tables, and that read cut-over is deliberately a later change.
              </p>
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}
