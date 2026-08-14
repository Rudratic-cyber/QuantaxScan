import { Zap } from "lucide-react";
import { Panel, Eyebrow, SCENARIO_COLOR } from "./chrome";

/**
 * D1 Row 2 — the Mosca exposure headline's scenario filter.
 * docs/Claude/06-cisa-dashboard.md §"Row 2".
 *
 * "Clicking a scenario re-scores the whole page… do not pick one scenario
 * for the customer." All three scenarios stay visible below (the estate
 * posture timeline plots every one, always); this selector is a *filter*
 * layered on top for Row 4's inventory table, not a replacement of the
 * three-scenario view — `null` ("all scenarios") is the default and the
 * loudest chip, matching the rule that no single Q-Day date is asserted.
 */

const SCENARIOS: Array<{ name: string; label: string }> = [
  { name: "conservative", label: "Conservative · 2030" },
  { name: "central", label: "Central · 2035" },
  { name: "aggressive", label: "Aggressive · 2040" },
];

export function MoscaScenarioSelector({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (scenario: string | null) => void;
}) {
  return (
    <Panel>
      <div className="mb-3 flex items-center gap-2">
        <Zap className="h-3.5 w-3.5 text-[#4f46e5]" />
        <Eyebrow>Mosca exposure — filter the inventory table below</Eyebrow>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-[#475569]">
        These are regulatory-deadline scenarios, not physics predictions, and no single one is picked for you — a
        CISO who can say "we are exposed under all three" has a stronger case than one quoting a vendor's number.
        The full breakdown, with the inputs behind every verdict, is in the estate posture panel below.
      </p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter the inventory table by Q-Day scenario">
        <button
          onClick={() => onSelect(null)}
          className="rounded-full border px-3 py-1.5 text-[11px] font-mono font-semibold transition-colors"
          style={
            selected === null
              ? { borderColor: "#4f46e5", background: "#4f46e514", color: "#4f46e5" }
              : { borderColor: "#e5e7eb", color: "#6b7280" }
          }
        >
          All scenarios
        </button>
        {SCENARIOS.map((scenario) => {
          const colour = SCENARIO_COLOR[scenario.name];
          const active = selected === scenario.name;
          return (
            <button
              key={scenario.name}
              onClick={() => onSelect(active ? null : scenario.name)}
              className="rounded-full border px-3 py-1.5 text-[11px] font-mono font-semibold transition-colors"
              style={active ? { borderColor: colour, background: `${colour}14`, color: colour } : { borderColor: "#e5e7eb", color: "#6b7280" }}
            >
              {scenario.label}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}
