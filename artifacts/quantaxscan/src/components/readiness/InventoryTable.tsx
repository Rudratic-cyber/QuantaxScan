import { useMemo, useState } from "react";
import { Table2, ShieldAlert, ShieldQuestion, Filter } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Panel, Eyebrow, ErrorNotice, COLOR, SCENARIO_COLOR } from "./chrome";
import type { EnrichedInventoryAsset } from "./types";

/**
 * D1 Row 4 — the filterable inventory breakdown.
 * docs/Claude/06-cisa-dashboard.md §"Row 4".
 *
 * Sourced from `assets` (via `/api/inventory/assets`), not per-scan findings
 * — the doc's explicit requirement — and split into two tables that are
 * never merged: post-quantum risk and classical hygiene. MD5/SHA-1/AES-ECB
 * are 3 of 7 detection patterns and are not quantum vulnerabilities;
 * counting them toward PQC risk inflates the number and a knowledgeable
 * buyer notices immediately (G-10). A third bucket — "not mapped" — is its
 * own thing rather than silently folded into either table: it is neither a
 * PQC finding nor a hygiene one, it is a gap in the standards data.
 *
 * Wide table, `overflow-x-auto` on its own wrapper — never `ScrollArea`,
 * which clips horizontally with no way to reach the rest of the row.
 */

const SURFACE_OPTIONS = ["all", "source", "dependency", "tls", "certificate", "kms", "config", "data-at-rest", "ot", "vendor", "binary"];

function ClassificationBadge({ asset }: { asset: EnrichedInventoryAsset }) {
  if (asset.classificationSource === "default") {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-mono" style={{ background: `${COLOR.unexamined}14`, color: COLOR.unexamined }}>
        assumed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-mono" style={{ background: `${COLOR.clean}14`, color: COLOR.clean }}>
      {asset.classificationSource}
    </span>
  );
}

function BreachBadges({ asset }: { asset: EnrichedInventoryAsset }) {
  if (!asset.mosca.applicable) return <span className="font-mono text-[10px] text-[#9aa3b2]">n/a</span>;
  if (asset.mosca.breachedScenarios.length === 0) return <span className="font-mono text-[10px] text-[#9aa3b2]">none</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {asset.mosca.breachedScenarios.map((scenario) => (
        <span key={scenario} className="rounded-full px-1.5 py-0.5 text-[9px] font-mono font-semibold" style={{ background: `${SCENARIO_COLOR[scenario] ?? COLOR.accent}14`, color: SCENARIO_COLOR[scenario] ?? COLOR.accent }}>
          {scenario}
        </span>
      ))}
    </div>
  );
}

function AssetRow({ asset }: { asset: EnrichedInventoryAsset }) {
  return (
    <tr className="border-b border-[#f1f3f7] last:border-0 hover:bg-[#f7f8fa]">
      <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] font-semibold text-[#0a0e1a]">{asset.algorithm}</td>
      <td className="whitespace-nowrap px-3 py-2 font-mono text-[10px] text-[#6b7280]">{asset.surface}</td>
      <td className="whitespace-nowrap px-3 py-2 font-mono text-[10px] text-[#6b7280]">{asset.status}</td>
      <td className="max-w-[280px] truncate px-3 py-2 font-mono text-[10px] text-[#6b7280]" title={asset.location}>{asset.location}</td>
      <td className="whitespace-nowrap px-3 py-2"><ClassificationBadge asset={asset} /></td>
      <td className="whitespace-nowrap px-3 py-2 font-mono text-[10px] text-[#6b7280]">
        {asset.latestConfidence === null ? "—" : asset.latestConfidence.toFixed(2)}
      </td>
      <td className="whitespace-nowrap px-3 py-2"><BreachBadges asset={asset} /></td>
      <td className="whitespace-nowrap px-3 py-2 font-mono text-[10px] text-[#9aa3b2]">
        {formatDistanceToNow(new Date(asset.lastSeen))} ago
      </td>
    </tr>
  );
}

function AssetTable({ assets, emptyLabel }: { assets: EnrichedInventoryAsset[]; emptyLabel: string }) {
  if (assets.length === 0) {
    return <p className="py-6 text-center font-mono text-[11px] text-[#9aa3b2]">{emptyLabel}</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-[#eceef2]">
      <table className="w-full min-w-[820px] border-collapse text-left">
        <thead>
          <tr className="border-b border-[#e5e7eb] bg-[#f7f8fa]">
            {["Algorithm", "Surface", "Status", "Location", "Classification", "Confidence", "Breaches", "Last seen"].map((h) => (
              <th key={h} className="whitespace-nowrap px-3 py-2 font-mono text-[9px] uppercase tracking-widest text-[#6b7280]">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {assets.map((asset) => <AssetRow key={asset.id} asset={asset} />)}
        </tbody>
      </table>
    </div>
  );
}

export function InventoryTable({
  assets,
  error,
  loading,
  selectedScenario,
}: {
  assets: EnrichedInventoryAsset[] | null;
  error: string | null;
  loading: boolean;
  selectedScenario: string | null;
}) {
  const [surfaceFilter, setSurfaceFilter] = useState("all");

  const filtered = useMemo(() => {
    if (assets === null) return [];
    return assets.filter((a) => {
      if (surfaceFilter !== "all" && a.surface !== surfaceFilter) return false;
      if (selectedScenario !== null && !a.mosca.breachedScenarios.includes(selectedScenario)) return false;
      return true;
    });
  }, [assets, surfaceFilter, selectedScenario]);

  const pqc = filtered.filter((a) => a.compliance?.riskTrack === "post-quantum");
  const hygiene = filtered.filter((a) => a.compliance?.riskTrack === "classical-hygiene");
  const unmapped = filtered.filter((a) => a.compliance === null);

  return (
    <Panel>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Table2 className="h-3.5 w-3.5 text-[#4f46e5]" />
          <Eyebrow>Inventory breakdown</Eyebrow>
        </div>
        <div className="flex items-center gap-2">
          <Filter className="h-3 w-3 text-[#9aa3b2]" />
          <select
            value={surfaceFilter}
            onChange={(e) => setSurfaceFilter(e.target.value)}
            className="rounded-lg border border-[#e5e7eb] bg-white px-2 py-1 font-mono text-[10px] text-[#0a0e1a]"
          >
            {SURFACE_OPTIONS.map((s) => <option key={s} value={s}>{s === "all" ? "All surfaces" : s}</option>)}
          </select>
        </div>
      </div>

      {selectedScenario !== null && (
        <p className="mb-3 rounded-lg px-3 py-2 text-[11px]" style={{ background: `${SCENARIO_COLOR[selectedScenario] ?? COLOR.accent}0f`, color: SCENARIO_COLOR[selectedScenario] ?? COLOR.accent }}>
          Showing only assets that breach Mosca's inequality under the <strong>{selectedScenario}</strong> scenario. Clear the
          filter above the Mosca panel to see the full inventory.
        </p>
      )}

      {loading && assets === null && (
        <p className="py-8 text-center font-mono text-xs text-[#9aa3b2]">Loading inventory…</p>
      )}

      {error !== null && (
        <ErrorNotice title="Inventory could not be read." detail={`${error} No rows are shown rather than a partial or fabricated table.`} />
      )}

      {assets !== null && error === null && (
        <>
          {assets.length === 0 ? (
            <p className="py-8 text-center font-mono text-xs text-[#9aa3b2]">
              No assets in the inventory yet. An empty table here means nothing has been collected, not that the
              estate is clean.
            </p>
          ) : (
            <div className="space-y-6">
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <ShieldAlert className="h-3.5 w-3.5" style={{ color: COLOR.failed }} />
                  <p className="text-[11px] font-semibold text-[#0a0e1a]">Post-quantum risk</p>
                  <span className="rounded-full border border-[#e5e7eb] px-2 py-0.5 font-mono text-[9px] text-[#6b7280]">{pqc.length}</span>
                </div>
                <AssetTable assets={pqc} emptyLabel="No quantum-vulnerable assets match this filter." />
              </div>

              <div>
                <div className="mb-2 flex items-center gap-2">
                  <ShieldAlert className="h-3.5 w-3.5" style={{ color: COLOR.unexamined }} />
                  <p className="text-[11px] font-semibold text-[#0a0e1a]">Classical hygiene</p>
                  <span className="rounded-full border border-[#e5e7eb] px-2 py-0.5 font-mono text-[9px] text-[#6b7280]">{hygiene.length}</span>
                </div>
                <p className="mb-2 text-[10px] leading-relaxed text-[#9aa3b2]">
                  MD5, SHA-1 and AES-ECB — not quantum vulnerabilities, and never counted toward the post-quantum risk
                  score above. Still worth fixing; reported here so it does not inflate the PQC number.
                </p>
                <AssetTable assets={hygiene} emptyLabel="No classical-hygiene findings match this filter." />
              </div>

              {unmapped.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <ShieldQuestion className="h-3.5 w-3.5" style={{ color: COLOR.muted }} />
                    <p className="text-[11px] font-semibold text-[#0a0e1a]">Not mapped</p>
                    <span className="rounded-full border border-[#e5e7eb] px-2 py-0.5 font-mono text-[9px] text-[#6b7280]">{unmapped.length}</span>
                  </div>
                  <p className="mb-2 text-[10px] leading-relaxed text-[#9aa3b2]">
                    The standards data has no entry for this algorithm name — neither a PQC obligation nor a hygiene
                    note. A gap in the mapping data, not a clean result.
                  </p>
                  <AssetTable assets={unmapped} emptyLabel="" />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
