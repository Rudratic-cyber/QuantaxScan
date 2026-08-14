import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, CalendarClock, History, Info, Layers } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { apiUrl } from "@/lib/api";

/**
 * D7 — the estate posture timeline. docs/Claude/03-features.md §D7,
 * docs/Claude/06-cisa-dashboard.md §"Row 5 — Time pressure".
 *
 * Scrub through time and watch assets appear and Mosca verdicts turn over as
 * the runway shortens. Four rules this component is written to obey, each one
 * the mirror of a way this panel could quietly lie:
 *
 *  - **Measured and projected must never read as one line.** Everything left of
 *    the `now` rule is a reading taken at a real collection instant, drawn as a
 *    dot. Everything right of it is this same arithmetic run forward over a
 *    frozen inventory, drawn dashed, over a hatched ground, labelled on the
 *    axis and again on the scrub readout.
 *  - **With one scan there is no trend, and the panel says so in words.** The
 *    server decides (`observed.sufficientForTrend`) and supplies the sentence;
 *    this renders it verbatim rather than paraphrasing, and draws no connecting
 *    line at all. A flat line through one point is a fabricated measurement.
 *  - **Nothing is interpolated.** The scrub handle lands on real frames only —
 *    arrow keys step measurement to measurement — and between two measurements
 *    the line is held flat and faint, because nothing was observed there.
 *  - **Every deadline is resolved, not written here.** The years, labels,
 *    frameworks and citations all arrive from the C1 mapping engine via the
 *    API. There is not a date in this file.
 */

const COLOR = {
  ink: "#0a0e1a",
  muted: "#6b7280",
  faint: "#9aa3b2",
  rule: "#e5e7eb",
  accent: "#4f46e5",
  failed: "#dc2626",
  deadline: "#4f46e5",
  projected: "#9aa3b2",
};

/** One colour per Q-Day scenario, urgency-ordered. Never blended into one number. */
const SCENARIO_COLOR: Record<string, string> = {
  conservative: "#dc2626",
  central: "#d97706",
  aggressive: "#0d9488",
};

// ── payload ──────────────────────────────────────────────────────────────────

type ScenarioCounts = Record<string, number>;

interface TimelinePoint {
  at: string;
  assetsKnown: number;
  assetsPresent: number;
  pqcAssets: number;
  hygieneAssets: number;
  unmappedAssets: number;
  breachedByScenario: ScenarioCounts;
}

interface ObservedPoint extends TimelinePoint {
  kind: "observed";
  collectionRunIds: number[];
  surfaces: string[];
  assetsAdded: number;
}

interface ProjectedPoint extends TimelinePoint {
  kind: "projected";
  year: number;
}

interface DeadlineMarker {
  id: string;
  type: string;
  label: string;
  effect: string;
  effectiveFrom: string;
  year: number;
  inEffect: boolean;
  appliesTo: string | null;
  securityStrength: string | null;
  framework: string;
  frameworkName: string | null;
  requirement: string;
  citation: { document: string; section?: string; url: string; retrievedAt?: string };
  confidence: string;
  draftStatus: string | null;
  algorithms: string[];
  assets: number;
  caveats: string[];
}

interface TimelineResponse {
  generatedAt: string;
  now: string;
  framing: string;
  scenarios: Array<{ name: string; qDayYear: number; rationale: string; confidence: string }>;
  estate: {
    projects: Array<{ id: number; name: string; assets: number; presentAssets: number }>;
    unassociatedAssets: number;
    totalAssets: number;
    presentAssets: number;
  };
  observed: {
    sufficientForTrend: boolean;
    reason: string;
    distinctCollectionInstants: number;
    observedSpanDays: number | null;
    firstObservedAt: string | null;
    lastObservedAt: string | null;
    completedRuns: number;
    failedRuns: number;
    points: ObservedPoint[];
  };
  projected: { assumption: string; basisAt: string; points: ProjectedPoint[] };
  deadlines: DeadlineMarker[];
  inputs: {
    secrecyLifetime: { bySource: Record<string, number>; assumedForAssets: number; bases: string[] };
    migrationYears: { defaultValue: number; assetsWithRecordedEffort: number; basis: string };
  };
  notCollected: Array<{ id: string; label: string; reason: string }>;
}

function useEstateTimeline() {
  const [data, setData] = useState<TimelineResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(apiUrl("/api/inventory/timeline"))
      .then(async (r) => {
        if (!r.ok) throw new Error(`Timeline request failed (HTTP ${r.status})`);
        return (await r.json()) as TimelineResponse;
      })
      .then((payload) => { if (!cancelled) { setData(payload); setLoading(false); } })
      .catch((err: Error) => { if (!cancelled) { setError(err.message); setData(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  return { data, error, loading };
}

// ── chrome, matched to the coverage meter ────────────────────────────────────

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

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const formatDate = (iso: string) => DATE.format(new Date(iso));

// ── the chart ────────────────────────────────────────────────────────────────

const VIEW = { width: 900, height: 220, padLeft: 44, padRight: 16, padTop: 14, padBottom: 46 };

/**
 * How much of the plot the observed half gets, regardless of how short it is.
 *
 * A single linear axis from the first scan to the last deadline gives months of
 * real history about three percent of the width and fifteen years of projection
 * the rest — the measured half, the only part of this panel that is evidence,
 * becomes unreadable. So the axis breaks at `now` and each half is scaled
 * independently. That is a distortion, and the caption under the chart says so
 * in as many words; hiding a break would be the dishonest version.
 */
const OBSERVED_FRACTION = 0.42;

interface ChartGeometry {
  startMs: number;
  endMs: number;
  nowMs: number;
  maxY: number;
  /** True when the two halves of the axis are on different scales. */
  axisBroken: boolean;
  x: (ms: number) => number;
  y: (value: number) => number;
}

/**
 * Step-after, held flat between measurements.
 *
 * A diagonal between two readings asserts a rate of change nobody measured; a
 * step asserts only "this was the last thing we saw". The caller draws the
 * connecting segments faintly and the measured instants as solid dots, so the
 * eye lands on the readings rather than on the joins.
 */
function stepPath(points: Array<{ ms: number; value: number }>, g: ChartGeometry): string {
  if (points.length === 0) return "";
  const parts: string[] = [`M ${g.x(points[0].ms)} ${g.y(points[0].value)}`];
  for (let i = 1; i < points.length; i += 1) {
    parts.push(`L ${g.x(points[i].ms)} ${g.y(points[i - 1].value)}`);
    parts.push(`L ${g.x(points[i].ms)} ${g.y(points[i].value)}`);
  }
  return parts.join(" ");
}

function chartLabel(data: TimelineResponse): string {
  const { observed, projected, estate } = data;
  const measured = observed.sufficientForTrend
    ? `${observed.points.length} measurements between ${formatDate(observed.firstObservedAt!)} and ${formatDate(observed.lastObservedAt!)}`
    : observed.distinctCollectionInstants === 1
      ? `a single measurement on ${formatDate(observed.firstObservedAt!)}, which is not a trend`
      : "no measurements at all";
  const last = projected.points[projected.points.length - 1];
  const ending = last
    ? `, then a projection over today's ${estate.presentAssets} assets out to ${last.year}`
    : "";
  return `Assets breaching Mosca's inequality per Q-Day scenario: ${measured}${ending}. Deadline markers are drawn as vertical rules.`;
}

// ── the panel ────────────────────────────────────────────────────────────────

export function PostureTimeline() {
  const { data, error, loading } = useEstateTimeline();
  const reduceMotion = useReducedMotion();
  const [frame, setFrame] = useState(0);

  /**
   * Every scrubbable position, in order. Observed frames are readings;
   * projected frames are evaluations of the same arithmetic over a frozen
   * inventory. There is deliberately nothing in between — a handle that could
   * land between two readings would have to invent a value for that instant.
   */
  const frames = useMemo(
    () => [...(data?.observed.points ?? []), ...(data?.projected.points ?? [])],
    [data],
  );

  // Open on today: the last observed reading, which is the state of the estate
  // as it actually stands rather than a forecast.
  useEffect(() => {
    if (data === null) return;
    setFrame(Math.max(0, (data.observed.points.length || 1) - 1));
  }, [data]);

  const geometry = useMemo<ChartGeometry | null>(() => {
    if (data === null || frames.length === 0) return null;
    const nowMs = new Date(data.now).getTime();
    const startMs = Math.min(nowMs, ...frames.map((f) => new Date(f.at).getTime()));
    const endMs = Math.max(
      nowMs,
      ...frames.map((f) => new Date(f.at).getTime()),
      ...data.deadlines.map((d) => new Date(d.effectiveFrom).getTime()),
    );
    const maxY = Math.max(1, data.estate.presentAssets, ...frames.map((f) => Math.max(...Object.values(f.breachedByScenario))));
    const plotWidth = VIEW.width - VIEW.padLeft - VIEW.padRight;
    const plotHeight = VIEW.height - VIEW.padTop - VIEW.padBottom;

    const observedSpan = nowMs - startMs;
    // With no history at all the break sits near the left edge, so the `now`
    // rule and its labels still have somewhere to live.
    const observedFraction = observedSpan <= 0 ? 0.04 : OBSERVED_FRACTION;
    const breakX = VIEW.padLeft + plotWidth * observedFraction;
    const projectedSpan = Math.max(1, endMs - nowMs);

    return {
      startMs,
      endMs,
      nowMs,
      maxY,
      axisBroken: observedSpan > 0,
      x: (ms: number) =>
        ms <= nowMs
          ? observedSpan <= 0
            ? breakX
            : VIEW.padLeft + ((ms - startMs) / observedSpan) * (breakX - VIEW.padLeft)
          : breakX + ((ms - nowMs) / projectedSpan) * (VIEW.width - VIEW.padRight - breakX),
      y: (value: number) => VIEW.padTop + plotHeight - (value / maxY) * plotHeight,
    };
  }, [data, frames]);

  if (loading && data === null) {
    return (
      <Panel>
        <Eyebrow>Estate posture over time</Eyebrow>
        <p className="py-10 text-center font-mono text-xs text-[#9aa3b2]">Loading timeline…</p>
      </Panel>
    );
  }

  // A failed read renders a refusal, never an empty axis. A timeline whose job
  // is to say how much history exists must not draw "none" when it does not know.
  if (error !== null || data === null) {
    return (
      <Panel>
        <Eyebrow>Estate posture over time</Eyebrow>
        <div className="mt-3 flex items-start gap-2 rounded-xl border p-4" style={{ borderColor: `${COLOR.failed}33`, background: `${COLOR.failed}08` }}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: COLOR.failed }} />
          <div>
            <p className="text-xs font-semibold text-[#0a0e1a]">Timeline could not be read.</p>
            <p className="mt-1 font-mono text-[10px] text-[#6b7280]">{error ?? "No response"}</p>
            <p className="mt-1 text-[11px] text-[#6b7280]">
              No history is drawn rather than an empty one — "we could not ask" and "there is nothing there" are
              different answers, and only one of them is true here.
            </p>
          </div>
        </div>
      </Panel>
    );
  }

  const { observed, projected, estate, deadlines, inputs, scenarios } = data;
  const current = frames[Math.min(frame, frames.length - 1)];
  const nowMs = new Date(data.now).getTime();

  // Nothing collected at all: a configuration state, not a chart. Doc 06 —
  // "empty states are a feature".
  if (estate.totalAssets === 0) {
    return (
      <Panel>
        <div className="mb-4 flex items-center gap-2">
          <History className="h-3.5 w-3.5 text-[#4f46e5]" />
          <Eyebrow>Estate posture over time — observed history and scheduled deadlines</Eyebrow>
        </div>
        <div
          className="rounded-xl border p-5"
          style={{ borderColor: "#d9770633", background: "#d9770608" }}
          data-testid="timeline-no-history"
        >
          <p className="text-sm font-semibold text-[#0a0e1a]">No history to draw.</p>
          <p className="mt-2 text-[12px] leading-relaxed text-[#475569]">{observed.reason}</p>
          <p className="mt-2 text-[11px] leading-relaxed text-[#6b7280]">
            The axis below is not drawn empty, and no zero is plotted. A flat line at zero would read as "your
            estate is clean", which is a measurement nobody has taken.
          </p>
          {observed.failedRuns > 0 && (
            <p className="mt-2 font-mono text-[10px]" style={{ color: COLOR.failed }}>
              {observed.failedRuns} collection {observed.failedRuns === 1 ? "attempt" : "attempts"} failed, and a failed
              attempt is not an examination.
            </p>
          )}
        </div>
        <p className="mt-3 font-mono text-[9px] leading-relaxed text-[#9aa3b2]">{data.framing}</p>
      </Panel>
    );
  }

  return (
    <Panel>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <History className="h-3.5 w-3.5 text-[#4f46e5]" />
          <Eyebrow>Estate posture over time — observed history and scheduled deadlines</Eyebrow>
        </div>
        <span className="font-mono text-[9px] text-[#9aa3b2]">
          as of {formatDistanceToNow(new Date(data.generatedAt))} ago · {estate.presentAssets} assets across{" "}
          {estate.projects.length} {estate.projects.length === 1 ? "project" : "projects"}
        </span>
      </div>

      {/* The honest-empty gate. Rendered above the chart, not below it, because
          it changes how everything under it must be read. */}
      {!observed.sufficientForTrend && (
        <div
          className="mb-4 rounded-xl border p-4"
          style={{ borderColor: "#d9770633", background: "#d9770608" }}
          data-testid="timeline-no-trend"
        >
          <p className="text-[12px] font-semibold text-[#0a0e1a]">No trend — there is not enough history yet.</p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-[#475569]">{observed.reason}</p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-[#6b7280]">
            The measurement that does exist is plotted as a single point. Nothing joins it to anything, because
            nothing else has been measured.
          </p>
        </div>
      )}

      {/* ── chart ── */}
      {geometry && (
        <figure className="m-0">
          <svg
            viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
            className="w-full"
            style={{ height: "auto" }}
            role="img"
            aria-label={chartLabel(data)}
          >
            <defs>
              {/* Hatching, not a solid tint: the future is an open question, and
                  a filled block reads as measured ground. Same reasoning as the
                  coverage meter's unexamined surfaces. */}
              <pattern id="qx-projected-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="8" height="8" fill="#f7f8fa" />
                <line x1="0" y1="0" x2="0" y2="8" stroke={COLOR.projected} strokeOpacity="0.28" strokeWidth="1.5" />
              </pattern>
            </defs>

            {/* projected ground */}
            <rect
              x={geometry.x(nowMs)}
              y={VIEW.padTop}
              width={Math.max(0, VIEW.width - VIEW.padRight - geometry.x(nowMs))}
              height={VIEW.height - VIEW.padTop - VIEW.padBottom}
              fill="url(#qx-projected-hatch)"
            />

            {/* y grid */}
            {[0, 0.5, 1].map((fraction) => {
              const value = Math.round(geometry.maxY * fraction);
              return (
                <g key={fraction}>
                  <line
                    x1={VIEW.padLeft} x2={VIEW.width - VIEW.padRight}
                    y1={geometry.y(value)} y2={geometry.y(value)}
                    stroke={COLOR.rule} strokeWidth="1"
                  />
                  <text x={VIEW.padLeft - 8} y={geometry.y(value) + 3} textAnchor="end" fontSize="9" fontFamily="monospace" fill={COLOR.faint}>
                    {value}
                  </text>
                </g>
              );
            })}

            {/* deadline rules, every year read from the mapping engine */}
            {deadlines.map((deadline) => {
              const dx = geometry.x(new Date(deadline.effectiveFrom).getTime());
              return (
                <g key={deadline.id}>
                  <line
                    x1={dx} x2={dx} y1={VIEW.padTop} y2={VIEW.height - VIEW.padBottom}
                    stroke={COLOR.deadline} strokeWidth="1" strokeDasharray="2 3" strokeOpacity="0.55"
                  />
                  <text x={dx} y={VIEW.height - VIEW.padBottom + 12} textAnchor="middle" fontSize="9" fontFamily="monospace" fill={COLOR.deadline}>
                    {deadline.year}
                  </text>
                </g>
              );
            })}

            {/* Q-Day scenario rules */}
            {scenarios.map((scenario) => {
              const dx = geometry.x(Date.UTC(scenario.qDayYear, 0, 1));
              if (dx > VIEW.width - VIEW.padRight || dx < VIEW.padLeft) return null;
              return (
                <line
                  key={scenario.name}
                  x1={dx} x2={dx} y1={VIEW.padTop} y2={VIEW.height - VIEW.padBottom}
                  stroke={SCENARIO_COLOR[scenario.name] ?? COLOR.accent}
                  strokeWidth="1" strokeDasharray="5 4" strokeOpacity="0.5"
                />
              );
            })}

            {/* the `now` rule — the boundary between measurement and projection */}
            <line
              x1={geometry.x(nowMs)} x2={geometry.x(nowMs)}
              y1={VIEW.padTop - 6} y2={VIEW.height - VIEW.padBottom}
              stroke={COLOR.ink} strokeWidth="1.5"
            />
            <text x={geometry.x(nowMs) - 5} y={VIEW.height - VIEW.padBottom + 24} textAnchor="end" fontSize="9" fontFamily="monospace" fill={COLOR.ink}>
              observed ◀
            </text>
            <text x={geometry.x(nowMs) + 5} y={VIEW.height - VIEW.padBottom + 24} textAnchor="start" fontSize="9" fontFamily="monospace" fill={COLOR.projected}>
              ▶ projected
            </text>
            {/* The observed half's extent, so the reader can see how little (or
                how much) history the left of the break actually covers. */}
            {observed.firstObservedAt && (
              <text x={VIEW.padLeft} y={VIEW.height - VIEW.padBottom + 12} textAnchor="start" fontSize="9" fontFamily="monospace" fill={COLOR.faint}>
                {formatDate(observed.firstObservedAt)}
              </text>
            )}
            <text x={geometry.x(nowMs)} y={VIEW.height - VIEW.padBottom + 12} textAnchor="middle" fontSize="9" fontFamily="monospace" fill={COLOR.ink}>
              today
            </text>

            {/* one series per scenario */}
            {scenarios.map((scenario) => {
              const colour = SCENARIO_COLOR[scenario.name] ?? COLOR.accent;
              const observedSeries = observed.points.map((p) => ({ ms: new Date(p.at).getTime(), value: p.breachedByScenario[scenario.name] ?? 0 }));
              const lastObserved = observedSeries[observedSeries.length - 1];
              const projectedSeries = [
                ...(lastObserved ? [lastObserved] : []),
                ...projected.points.map((p) => ({ ms: new Date(p.at).getTime(), value: p.breachedByScenario[scenario.name] ?? 0 })),
              ];

              return (
                <g key={scenario.name}>
                  {/* Dashed and paler: this is arithmetic, not evidence. */}
                  <path d={stepPath(projectedSeries, geometry)} fill="none" stroke={colour} strokeWidth="1.5" strokeDasharray="4 4" strokeOpacity="0.55" />

                  {/* Joins between readings are faint; the readings themselves
                      are solid. With one reading no join is drawn at all. */}
                  {observed.sufficientForTrend && (
                    <path
                      data-testid="observed-series"
                      d={stepPath(observedSeries, geometry)}
                      fill="none" stroke={colour} strokeWidth="2" strokeOpacity="0.35"
                    />
                  )}
                  {observedSeries.map((point) => (
                    <circle
                      key={`${scenario.name}-${point.ms}`}
                      cx={geometry.x(point.ms)} cy={geometry.y(point.value)} r="3.5"
                      fill={colour} stroke="#ffffff" strokeWidth="1.5"
                    />
                  ))}
                </g>
              );
            })}

            {/* scrub handle */}
            {current && (
              <motion.line
                x1={geometry.x(new Date(current.at).getTime())} x2={geometry.x(new Date(current.at).getTime())}
                y1={VIEW.padTop - 6} y2={VIEW.height - VIEW.padBottom}
                stroke={COLOR.accent} strokeWidth="2"
                initial={false}
                animate={{ opacity: 1 }}
                transition={reduceMotion ? { duration: 0 } : { duration: 0.18 }}
              />
            )}
          </svg>
          <figcaption className="mt-1 font-mono text-[9px] leading-relaxed text-[#9aa3b2]">
            Assets breaching Mosca&apos;s inequality, one line per Q-Day scenario. Solid dots are measurements; the
            faint step between them is held flat because nothing was measured there. Everything right of{" "}
            <span className="text-[#0a0e1a]">today</span> is hatched and dashed — arithmetic over a frozen
            inventory, not evidence.
            {geometry.axisBroken && (
              <>
                {" "}
                <span className="text-[#b45309]">
                  The axis breaks at today: the observed span is expanded so it can be read, so the two halves are
                  not to the same scale.
                </span>
              </>
            )}
          </figcaption>
        </figure>
      )}

      {/* ── scrubber ── */}
      {frames.length > 1 && current && (
        <div className="mt-3">
          <label htmlFor="qx-timeline-scrub" className="sr-only">
            Scrub through the estate's cryptographic posture
          </label>
          <input
            id="qx-timeline-scrub"
            type="range"
            min={0}
            max={frames.length - 1}
            step={1}
            value={Math.min(frame, frames.length - 1)}
            onChange={(event) => setFrame(Number(event.target.value))}
            className="w-full accent-[#4f46e5]"
            aria-valuetext={`${current.kind === "observed" ? "Observed" : "Projected"} ${formatDate(current.at)}: ${current.assetsPresent} assets, ${scenarios
              .map((s) => `${current.breachedByScenario[s.name] ?? 0} breaching under ${s.name}`)
              .join(", ")}`}
          />
          <p className="mt-1 font-mono text-[9px] text-[#9aa3b2]">
            {frames.length} positions — every one a real collection instant or a whole projected year. The handle
            cannot land between them, because there is no reading there to show.
          </p>
        </div>
      )}

      {/* ── the scrubbed frame ── */}
      {current && (
        <div className="mt-4 rounded-xl border border-[#eceef2] bg-[#f7f8fa] p-4" data-testid="timeline-frame">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold"
                style={
                  current.kind === "observed"
                    ? { background: "#4f46e514", color: COLOR.accent }
                    : { background: "#9aa3b21f", color: "#475569" }
                }
              >
                {current.kind === "observed" ? "Observed" : "Projected"}
              </span>
              <span className="font-mono text-[12px] font-semibold text-[#0a0e1a]">{formatDate(current.at)}</span>
            </div>
            <span className="font-mono text-[10px] text-[#6b7280]">
              {current.assetsPresent} assets in inventory · {current.pqcAssets} quantum-vulnerable ·{" "}
              {current.hygieneAssets} classical hygiene
              {current.unmappedAssets > 0 && ` · ${current.unmappedAssets} unmapped`}
            </span>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {scenarios.map((scenario) => {
              const colour = SCENARIO_COLOR[scenario.name] ?? COLOR.accent;
              const breached = current.breachedByScenario[scenario.name] ?? 0;
              const share = current.assetsPresent === 0 ? 0 : (breached / current.assetsPresent) * 100;
              return (
                <div key={scenario.name} className="rounded-lg border border-[#e5e7eb] bg-white p-3">
                  <p className="font-mono text-[9px] uppercase tracking-widest" style={{ color: colour }}>
                    {scenario.name} · Q-Day {scenario.qDayYear}
                  </p>
                  <p className="mt-1 font-mono text-2xl font-bold" style={{ color: colour }}>{breached}</p>
                  <p className="font-mono text-[10px] text-[#6b7280]">
                    of {current.assetsPresent} assets breach
                  </p>
                  <div className="mt-2 h-1.5 w-full rounded-full bg-[#f1f3f7]">
                    <motion.div
                      className="h-full rounded-full"
                      style={{ background: colour }}
                      initial={false}
                      animate={{ width: `${share}%` }}
                      transition={reduceMotion ? { duration: 0 } : { duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                    />
                  </div>
                  <p className="mt-2 text-[10px] leading-relaxed text-[#6b7280]">{scenario.rationale}</p>
                </div>
              );
            })}
          </div>

          {current.kind === "observed" ? (
            <p className="mt-3 font-mono text-[10px] leading-relaxed text-[#6b7280]">
              Measured. {current.collectionRunIds.length} collection{" "}
              {current.collectionRunIds.length === 1 ? "run" : "runs"} on {current.surfaces.join(", ")}
              {current.assetsAdded > 0 && ` · ${current.assetsAdded} asset${current.assetsAdded === 1 ? "" : "s"} entered the inventory here`}.
            </p>
          ) : (
            <p className="mt-3 text-[10px] leading-relaxed" style={{ color: "#7c4a03" }}>
              {projected.assumption}
            </p>
          )}
        </div>
      )}

      {/* ── deadlines, straight from the mapping engine ── */}
      <div className="mt-5">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-3.5 w-3.5 text-[#4f46e5]" />
          <Eyebrow>Obligations dated against this estate</Eyebrow>
        </div>
        {deadlines.length === 0 ? (
          <p className="mt-2 font-mono text-[10px] text-[#9aa3b2]">
            No dated obligation covers any algorithm in this inventory. That is a statement about what was found,
            not a clean bill of health for what was never examined.
          </p>
        ) : (
          <div className="mt-2 divide-y divide-[#f1f3f7]">
            {deadlines.map((deadline) => (
              <div key={deadline.id} data-testid="deadline-row" className="flex flex-wrap items-start justify-between gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[12px] font-bold text-[#0a0e1a]">{deadline.year}</span>
                    <span
                      className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
                      style={{ background: deadline.inEffect ? "#dc262614" : "#4f46e514", color: deadline.inEffect ? COLOR.failed : COLOR.accent }}
                    >
                      {deadline.label}
                    </span>
                    <span className="font-mono text-[10px] text-[#6b7280]">{deadline.framework}</span>
                    {deadline.draftStatus && (
                      <span className="inline-flex items-center rounded-full bg-[#fffbeb] px-2 py-0.5 text-[10px] font-semibold text-[#b45309]">
                        {deadline.draftStatus}
                      </span>
                    )}
                    {deadline.confidence !== "verified" && (
                      <span className="font-mono text-[10px] text-[#b45309]">{deadline.confidence}</span>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-[#475569]">{deadline.requirement}</p>
                  {/* Two rules can share a year and differ only in the key
                      strength or the use they cover. Printing that is what stops
                      them reading as one duplicated row. */}
                  {(deadline.securityStrength || deadline.appliesTo) && (
                    <p className="mt-0.5 font-mono text-[10px] text-[#6b7280]">
                      {[deadline.securityStrength && `keyed on ${deadline.securityStrength}`, deadline.appliesTo && `applies to ${deadline.appliesTo}`]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                  <p className="mt-1 font-mono text-[9px] text-[#9aa3b2]">
                    {deadline.citation.section ?? deadline.citation.document} ·{" "}
                    <a href={deadline.citation.url} target="_blank" rel="noreferrer" className="underline hover:text-[#4f46e5]">
                      source
                    </a>
                    {deadline.caveats.map((caveat) => ` · ${caveat}`).join("")}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-mono text-[13px] font-bold text-[#0a0e1a]">{deadline.assets}</p>
                  <p className="font-mono text-[9px] text-[#6b7280]">
                    {deadline.assets === 1 ? "asset" : "assets"} · {deadline.algorithms.join(", ")}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── the inputs behind every verdict above ── */}
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div>
          <div className="flex items-center gap-2">
            <Info className="h-3.5 w-3.5 text-[#4f46e5]" />
            <Eyebrow>The inputs, not just the output</Eyebrow>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-[#475569]">
            X is the secrecy lifetime, Y the migration time, Z the runway to a scenario's Q-Day. A verdict without
            its inputs is a number nobody can defend.
          </p>
          <p className="mt-2 font-mono text-[10px] leading-relaxed text-[#6b7280]">
            X assumed rather than supplied for{" "}
            <span className="font-bold text-[#b45309]">{inputs.secrecyLifetime.assumedForAssets}</span> of{" "}
            {estate.presentAssets} assets
            {Object.entries(inputs.secrecyLifetime.bySource).length > 0 &&
              ` (${Object.entries(inputs.secrecyLifetime.bySource).map(([source, n]) => `${n} from ${source}`).join(", ")})`}
            .
          </p>
          <ul className="mt-1.5 space-y-1">
            {inputs.secrecyLifetime.bases.map((basis) => (
              <li key={basis} className="font-mono text-[9px] leading-relaxed text-[#9aa3b2]">— {basis}</li>
            ))}
          </ul>
          <p className="mt-2 font-mono text-[9px] leading-relaxed text-[#9aa3b2]">{inputs.migrationYears.basis}</p>
        </div>

        <div>
          <div className="flex items-center gap-2">
            <Layers className="h-3.5 w-3.5 text-[#4f46e5]" />
            <Eyebrow>Estate roll-up</Eyebrow>
          </div>
          <div className="mt-2 divide-y divide-[#f1f3f7]">
            {estate.projects.map((project) => (
              <div key={project.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="truncate text-[12px] text-[#0a0e1a]">{project.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-[#6b7280]">
                  {project.presentAssets} present
                  {project.assets !== project.presentAssets && ` · ${project.assets - project.presentAssets} historical`}
                </span>
              </div>
            ))}
            {estate.unassociatedAssets > 0 && (
              <div className="flex items-center justify-between gap-3 py-1.5">
                <span className="truncate text-[12px] text-[#6b7280]">Not associated with a project</span>
                <span className="shrink-0 font-mono text-[10px] text-[#6b7280]">{estate.unassociatedAssets}</span>
              </div>
            )}
          </div>
          <p className="mt-2 font-mono text-[9px] leading-relaxed text-[#9aa3b2]">
            Assets are attributed to a project by their location prefix; TLS endpoints, certificates and key stores
            have no project and are counted separately rather than dropped.
          </p>
        </div>
      </div>

      {/* ── what this panel cannot compute ── */}
      <div className="mt-5 rounded-xl border border-[#eceef2] bg-[#f7f8fa] p-4">
        <Eyebrow>Not collected</Eyebrow>
        <ul className="mt-2 space-y-2">
          {data.notCollected.map((item) => (
            <li key={item.id}>
              <p className="text-[11px] font-semibold text-[#0a0e1a]">{item.label}</p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-[#6b7280]">{item.reason}</p>
            </li>
          ))}
        </ul>
      </div>

      {/* Mandatory wherever a scenario year appears — kept on the page, not in a tooltip. */}
      <p className="mt-3 font-mono text-[9px] leading-relaxed text-[#9aa3b2]">{data.framing}</p>
    </Panel>
  );
}
