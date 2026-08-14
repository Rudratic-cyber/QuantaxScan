import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { PostureTimeline } from "@/components/PostureTimeline";
import { ReadinessPostureTracker } from "@/components/readiness/ReadinessPostureTracker";
import { EstateCoveragePanel } from "@/components/readiness/EstateCoveragePanel";
import { MoscaScenarioSelector } from "@/components/readiness/MoscaScenarioSelector";
import { InventoryTable } from "@/components/readiness/InventoryTable";
import { TimePressurePanel } from "@/components/readiness/TimePressurePanel";
import { DriftPanel } from "@/components/readiness/DriftPanel";
import { useReadiness, useInventoryAssets } from "@/components/readiness/hooks";

/**
 * D1 — the CISA quantum-readiness dashboard.
 * docs/Claude/06-cisa-dashboard.md, docs/Claude/02-roadmap.md (Phase 2 / M2).
 *
 * Structured around the buyer's own reference document — the joint
 * CISA/NSA/NIST "Quantum-Readiness: Migration to Post-Quantum Cryptography"
 * factsheet (August 2023) — rather than around this product's data model, so
 * a CISO can point at the factsheet in a board meeting and say "here is
 * where we are against it." §"Design notes" in the doc: this page is the
 * calmer CISO register, not the marketing/demo one — no animated
 * background, no intro splash, restrained motion (the same amount D3's and
 * D7's panels already use, not more), legible at 50% zoom on a projector.
 *
 * Six rows, in the doc's own order:
 *  1. Readiness posture — five factsheet sections, honestly gapped (Row 1)
 *  2. Mosca exposure — all three Q-Day scenarios, a filter not a pick (Row 2)
 *  3. Coverage & confidence, estate-wide — "the most important panel" (Row 3)
 *  4. Inventory breakdown, PQC vs. classical hygiene, never blended (Row 4)
 *  5. Time pressure — cert expiry, deprecation runway (Row 5)
 *  6. Drift — lifecycle counts since collection began (Row 6)
 *
 * The estate posture timeline (D7, `PostureTimeline`) is reused wholesale
 * for the scenario breakdown and the obligation-deadline list rather than
 * re-implemented: it already holds every honesty rule Row 2 and half of Row
 * 5 need (measured vs. projected, no trend from one point, nothing
 * interpolated), and a second implementation of the same Mosca arithmetic
 * is exactly the kind of drift that could make the two panels disagree.
 *
 * Explicitly NOT this page: the board/executive PDF pack (E1, a separate
 * feature — docs/Claude/07-reports.md) and any new collector. Both stay out
 * of scope here.
 */
export function Readiness() {
  const { data: readiness, error: readinessError, loading: readinessLoading } = useReadiness();
  const { data: inventory, error: inventoryError, loading: inventoryLoading } = useInventoryAssets();
  const [selectedScenario, setSelectedScenario] = useState<string | null>(null);

  return (
    <div className="flex-1 overflow-y-auto bg-[#f7f8fa]">
      <div className="container relative z-10 mx-auto max-w-7xl px-4 py-8">
        <div className="mb-6">
          <div className="mb-1 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-[#4f46e5]" />
            <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-[#4f46e5]/80">CISA Quantum-Readiness Dashboard</p>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[#0a0e1a]">Readiness</h1>
          <p className="mt-1 text-xs text-[#6b7280]">
            Aligned to the joint CISA/NSA/NIST quantum-readiness guidance (August 2023) — organised into its named
            sections, not a numbered stage sequence.
          </p>
        </div>

        <div className="space-y-5">
          <ReadinessPostureTracker
            sections={readiness?.sections ?? null}
            framing={readiness?.framing ?? null}
            error={readinessError}
            loading={readinessLoading}
          />

          <MoscaScenarioSelector selected={selectedScenario} onSelect={setSelectedScenario} />
          <PostureTimeline />

          <EstateCoveragePanel coverage={readiness?.coverage ?? null} error={readinessError} loading={readinessLoading} />

          <InventoryTable
            assets={inventory?.assets ?? null}
            error={inventoryError}
            loading={inventoryLoading}
            selectedScenario={selectedScenario}
          />

          <TimePressurePanel assets={inventory?.assets ?? null} error={inventoryError} loading={inventoryLoading} />

          <DriftPanel statusCounts={inventory?.statusCounts ?? null} error={inventoryError} loading={inventoryLoading} />
        </div>
      </div>
    </div>
  );
}
