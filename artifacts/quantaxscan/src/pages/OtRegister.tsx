import { useState } from "react";
import { useListOtFleets, useCreateOtFleet, useDeleteOtFleet } from "@workspace/api-client-react";
import type { OtFleet, OtExposureState } from "@workspace/api-client-react";
import { motion } from "framer-motion";
import { AlertCircle, AlertTriangle, CheckCircle2, HelpCircle, Radio, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

/**
 * B8 — the manual OT/embedded register. docs/Claude/03-features.md §B8,
 * docs/Claude/02-roadmap.md "Phase 5 — Long-lead surfaces".
 *
 * A form, not a scanner: everything on this page is typed in by hand and
 * edited as facts change. The one thing worth getting right visually is that
 * "we don't know the next procurement date" must never *read* as safe — see
 * `EXPOSURE_STYLE.unknown`, which is deliberately the same amber used for
 * findings elsewhere in the app, not the green reserved for `clear`.
 */

const EXPOSURE_STYLE: Record<OtExposureState, { label: string; color: string; bg: string; Icon: typeof CheckCircle2 }> = {
  exposed: { label: "Exposed", color: "#dc2626", bg: "#fef2f2", Icon: AlertCircle },
  clear: { label: "Clear", color: "#059669", bg: "#ecfdf5", Icon: CheckCircle2 },
  unknown: { label: "Unknown", color: "#d97706", bg: "#fffbeb", Icon: HelpCircle },
};

const inputClass =
  "w-full rounded-xl border border-[#e5e7eb] bg-[#f7f8fa] px-4 py-2.5 text-sm text-[#0a0e1a] placeholder-[#9aa3b2] focus:outline-none focus:border-[#4f46e5] transition-colors";
const labelClass = "block text-xs font-semibold text-[#0a0e1a] mb-1.5";

type FormState = {
  name: string;
  vendor: string;
  model: string;
  deviceCount: string;
  site: string;
  owner: string;
  cryptoInUse: string;
  refreshCycleYears: string;
  nextProcurementDate: string;
};

const EMPTY_FORM: FormState = {
  name: "",
  vendor: "",
  model: "",
  deviceCount: "",
  site: "",
  owner: "",
  cryptoInUse: "",
  refreshCycleYears: "",
  nextProcurementDate: "",
};

function ExposureBadge({ fleet }: { fleet: OtFleet }) {
  const worst: OtExposureState = fleet.exposure.verdicts.some((v) => v.state === "exposed")
    ? "exposed"
    : fleet.exposure.verdicts.some((v) => v.state === "unknown")
      ? "unknown"
      : "clear";
  const style = EXPOSURE_STYLE[worst];

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="ot-fleet-exposure" data-state={worst}>
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
        style={{ color: style.color, backgroundColor: style.bg }}
      >
        <style.Icon className="h-3 w-3" />
        {style.label}
      </span>
      {fleet.exposure.verdicts.map((v) => (
        <span
          key={v.scenario}
          title={v.narrative}
          className="inline-flex items-center rounded-full border border-[#e5e7eb] px-2 py-0.5 text-[10px] font-medium text-[#6b7280]"
        >
          {v.scenario} ({v.qDayYear}): {EXPOSURE_STYLE[v.state].label}
        </span>
      ))}
    </div>
  );
}

export function OtRegister() {
  const { data: fleets, refetch, isPending, isError } = useListOtFleets();
  const createFleet = useCreateOtFleet();
  const deleteFleet = useDeleteOtFleet();
  const { toast } = useToast();

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState("");

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setFormError("Fleet name is required");
      return;
    }
    setFormError("");

    // Every optional field is omitted rather than sent as an empty string —
    // an empty string is not "not supplied", and the server stores whatever
    // it receives as the customer's answer. Omitting is what keeps the field
    // null, i.e. honestly "nobody told us".
    createFleet.mutate(
      {
        data: {
          name: form.name.trim(),
          ...(form.vendor.trim() && { vendor: form.vendor.trim() }),
          ...(form.model.trim() && { model: form.model.trim() }),
          ...(form.deviceCount.trim() && { deviceCount: Number(form.deviceCount) }),
          ...(form.site.trim() && { site: form.site.trim() }),
          ...(form.owner.trim() && { owner: form.owner.trim() }),
          ...(form.cryptoInUse.trim() && { cryptoInUse: form.cryptoInUse.trim() }),
          ...(form.refreshCycleYears.trim() && { refreshCycleYears: Number(form.refreshCycleYears) }),
          ...(form.nextProcurementDate && { nextProcurementDate: form.nextProcurementDate }),
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Fleet recorded" });
          setForm(EMPTY_FORM);
          void refetch();
        },
        onError: (error) => {
          toast({ title: "Could not record fleet", description: (error as Error).message, variant: "destructive" });
        },
      },
    );
  };

  const handleDelete = (id: number) => {
    deleteFleet.mutate(
      { id },
      {
        onSuccess: () => void refetch(),
        onError: (error) => toast({ title: "Could not remove fleet", description: (error as Error).message, variant: "destructive" }),
      },
    );
  };

  return (
    <div className="flex-1 bg-white overflow-y-auto">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <motion.div initial={{ opacity: 0, y: -16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="mb-8">
          <p className="text-[11px] font-semibold text-[#4f46e5] tracking-widest mb-2 uppercase flex items-center gap-1.5">
            <Radio className="h-3.5 w-3.5" /> OT / Embedded
          </p>
          <h1 className="text-4xl font-bold text-[#0a0e1a] mb-2">OT &amp; Embedded Register</h1>
          <p className="text-[#475569] text-sm max-w-2xl">
            OT and embedded devices have the longest replacement lead time in the estate — 7 to 15 years for a
            hardware refresh cycle. There is no automated collector for this yet, so record fleets by hand: what a
            fleet's next procurement date does or doesn't leave time for is the whole point of this register.
          </p>
        </motion.div>

        {/* Form */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="rounded-2xl border border-[#e5e7eb] bg-white p-6 mb-10"
          style={{ boxShadow: "0 8px 24px rgba(15,23,42,0.06)" }}
        >
          <h2 className="text-base font-semibold text-[#0a0e1a] mb-4">Record a fleet</h2>
          <form onSubmit={handleSubmit} data-testid="ot-fleet-form" className="space-y-4">
            <div>
              <label className={labelClass}>
                Fleet name <span className="text-[#dc2626]">*</span>
              </label>
              <input
                data-testid="ot-fleet-name-input"
                placeholder="e.g. Substation PLCs — West region"
                value={form.name}
                onChange={(e) => { set("name", e.target.value); if (formError) setFormError(""); }}
                className={`${inputClass} ${formError ? "border-[#dc2626]/40 bg-[#fef2f2]" : ""}`}
              />
              {formError && (
                <div className="flex items-center gap-1.5 text-xs text-[#dc2626] mt-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {formError}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Vendor</label>
                <input data-testid="ot-fleet-vendor-input" placeholder="e.g. Siemens" value={form.vendor} onChange={(e) => set("vendor", e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Model</label>
                <input data-testid="ot-fleet-model-input" placeholder="e.g. S7-1500" value={form.model} onChange={(e) => set("model", e.target.value)} className={inputClass} />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className={labelClass}>Device count</label>
                <input data-testid="ot-fleet-device-count-input" type="number" min={0} placeholder="Unknown" value={form.deviceCount} onChange={(e) => set("deviceCount", e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Site</label>
                <input data-testid="ot-fleet-site-input" placeholder="e.g. Plant 4" value={form.site} onChange={(e) => set("site", e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Owner</label>
                <input data-testid="ot-fleet-owner-input" placeholder="Team or contact" value={form.owner} onChange={(e) => set("owner", e.target.value)} className={inputClass} />
              </div>
            </div>

            <div>
              <label className={labelClass}>Cryptography in use</label>
              <input
                data-testid="ot-fleet-crypto-input"
                placeholder="e.g. RSA-2048 firmware signing, no TLS — best known"
                value={form.cryptoInUse}
                onChange={(e) => set("cryptoInUse", e.target.value)}
                className={inputClass}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Refresh cycle (years)</label>
                <input
                  data-testid="ot-fleet-refresh-cycle-input"
                  type="number"
                  min={0}
                  placeholder="Unknown"
                  value={form.refreshCycleYears}
                  onChange={(e) => set("refreshCycleYears", e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Next procurement date</label>
                <input
                  data-testid="ot-fleet-procurement-date-input"
                  type="date"
                  value={form.nextProcurementDate}
                  onChange={(e) => set("nextProcurementDate", e.target.value)}
                  className={inputClass}
                />
                <p className="text-[11px] text-[#9aa3b2] mt-1">
                  Leave blank if nobody has scheduled one yet — that reads as "unknown", not "safe".
                </p>
              </div>
            </div>

            <button
              type="submit"
              data-testid="ot-fleet-submit"
              disabled={createFleet.isPending}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-[#4f46e5] px-6 py-3 text-sm font-semibold text-white shadow-sm hover:bg-[#4338ca] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {createFleet.isPending ? (
                <>
                  <span className="h-3.5 w-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Saving…
                </>
              ) : (
                "Add fleet"
              )}
            </button>
          </form>
        </motion.div>

        {/* List */}
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
          <h2 className="text-base font-semibold text-[#0a0e1a] mb-4">Recorded fleets</h2>

          {isPending && <p className="text-sm text-[#6b7280]">Loading fleets…</p>}
          {isError && <h3 className="text-sm font-semibold text-[#dc2626]">Fleets could not be loaded</h3>}
          {!isPending && !isError && (fleets ?? []).length === 0 && (
            <div data-testid="ot-fleet-empty" className="rounded-2xl border border-dashed border-[#e5e7eb] p-8 text-center text-sm text-[#6b7280]">
              No fleets recorded yet. Add the first one above.
            </div>
          )}

          {!isPending && !isError && (fleets ?? []).length > 0 && (
            <ul data-testid="ot-fleet-list" className="space-y-3">
              {(fleets ?? []).map((fleet) => (
                <li
                  key={fleet.id}
                  data-testid="ot-fleet-row"
                  data-fleet-name={fleet.name}
                  className="rounded-2xl border border-[#e5e7eb] bg-white p-5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-[#0a0e1a]">{fleet.name}</h3>
                      <p className="mt-0.5 text-xs text-[#6b7280]">
                        {[fleet.vendor, fleet.model].filter(Boolean).join(" ") || "Vendor/model not recorded"}
                        {" · "}
                        {fleet.deviceCount !== null ? `${fleet.deviceCount} device${fleet.deviceCount === 1 ? "" : "s"}` : "count unknown"}
                        {fleet.site ? ` · ${fleet.site}` : ""}
                        {fleet.owner ? ` · owner: ${fleet.owner}` : ""}
                      </p>
                      {fleet.cryptoInUse && <p className="mt-1 text-xs text-[#6b7280]">Crypto: {fleet.cryptoInUse}</p>}
                      <p className="mt-1 text-xs text-[#9aa3b2]">
                        Next procurement:{" "}
                        {fleet.nextProcurementDate ? new Date(fleet.nextProcurementDate).toISOString().slice(0, 10) : "not recorded"}
                        {fleet.refreshCycleYears !== null ? ` · refresh cycle ${fleet.refreshCycleYears}y` : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove ${fleet.name}`}
                      onClick={() => handleDelete(fleet.id)}
                      className="shrink-0 rounded-lg p-2 text-[#9aa3b2] hover:bg-[#fef2f2] hover:text-[#dc2626] transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-3">
                    <ExposureBadge fleet={fleet} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </motion.div>
      </div>
    </div>
  );
}
