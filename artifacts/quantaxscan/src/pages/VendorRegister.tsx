import { useState } from "react";
import {
  useListVendorAssessments,
  useCreateVendorAssessment,
  useDeleteVendorAssessment,
} from "@workspace/api-client-react";
import type {
  VendorAssessment,
  VendorClauseState,
  VendorContractClause,
  VendorPqcRoadmapStatus,
  VendorReadinessState,
  VendorResponseState,
} from "@workspace/api-client-react";
import { motion } from "framer-motion";
import { AlertCircle, AlertTriangle, CheckCircle2, FileWarning, HelpCircle, Handshake, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

/**
 * B9 — the vendor / third-party register. docs/Claude/03-features.md §B9.
 *
 * A form, not a scanner, and the only page in this product whose entire
 * content is somebody else's word. Three things have to survive any redesign
 * of this page, because each of them is a way the register could start lying:
 *
 *   1. **Every reading carries the attestation banner.** A vendor's answer is
 *      rendered next to nothing that looks like collected evidence, and the
 *      confidence shown is the one the API stamps — below every collector's,
 *      and absent entirely when the vendor has said nothing.
 *   2. **A vendor who has not answered reads as unknown, never as compliant.**
 *      `READINESS_STYLE.unknown` is the same amber findings use, not the green
 *      reserved for `clear` — B8's precedent, and the reason its e2e spec
 *      asserts on the colour semantics rather than the layout.
 *   3. **"No PQC clause" and "nobody read the contract" never render the
 *      same.** `absent` is a finding and is coloured like one; `unknown` is an
 *      absence of information and is coloured like one. Collapsing them either
 *      way invents or hides an obligation, and neither error is visible after
 *      the fact.
 */

const READINESS_STYLE: Record<VendorReadinessState, { label: string; color: string; bg: string; Icon: typeof CheckCircle2 }> = {
  exposed: { label: "Exposed", color: "#dc2626", bg: "#fef2f2", Icon: AlertCircle },
  clear: { label: "Claimed in time", color: "#059669", bg: "#ecfdf5", Icon: CheckCircle2 },
  unknown: { label: "Unknown", color: "#d97706", bg: "#fffbeb", Icon: HelpCircle },
};

const RESPONSE_STYLE: Record<VendorResponseState, { label: string; color: string; bg: string }> = {
  awaiting_response: { label: "Awaiting response", color: "#d97706", bg: "#fffbeb" },
  partial: { label: "Partly answered", color: "#d97706", bg: "#fffbeb" },
  answered: { label: "Answered", color: "#4f46e5", bg: "#eef2ff" },
};

/**
 * Four states, four renderings. `absent` is red because it is a finding —
 * somebody read the contract and there is no obligation in it. `unknown` is
 * amber because nobody has looked, which is not the same claim and must not be
 * shown as one.
 */
const CLAUSE_STYLE: Record<VendorClauseState, { label: string; color: string; bg: string }> = {
  present: { label: "PQC clause in contract", color: "#059669", bg: "#ecfdf5" },
  absent: { label: "No PQC clause in contract", color: "#dc2626", bg: "#fef2f2" },
  in_negotiation: { label: "PQC clause in negotiation", color: "#4f46e5", bg: "#eef2ff" },
  unknown: { label: "Contract not checked", color: "#d97706", bg: "#fffbeb" },
};

const ROADMAP_LABEL: Record<string, string> = {
  none: "Vendor states: no PQC plan",
  assessing: "Vendor states: still assessing",
  roadmap_published: "Vendor states: roadmap published",
  migration_underway: "Vendor states: migration underway",
  pqc_available: "Vendor states: PQC already available",
};

const inputClass =
  "w-full rounded-xl border border-[#e5e7eb] bg-[#f7f8fa] px-4 py-2.5 text-sm text-[#0a0e1a] placeholder-[#9aa3b2] focus:outline-none focus:border-[#4f46e5] transition-colors";
const labelClass = "block text-xs font-semibold text-[#0a0e1a] mb-1.5";

type FormState = {
  vendorName: string;
  productOrService: string;
  internalOwner: string;
  questionnaireSentAt: string;
  respondedAt: string;
  /** `""` is "not answered" — the state that must stay distinct from every real value. */
  pqcRoadmapStatus: VendorPqcRoadmapStatus | "";
  statedPqcReadyDate: string;
  cryptoDisclosed: string;
  /** `""` is "not checked", which is emphatically not `"absent"`. See `CLAUSE_STYLE`. */
  contractPqcClause: VendorContractClause | "";
  contractRenewalDate: string;
};

const EMPTY_FORM: FormState = {
  vendorName: "",
  productOrService: "",
  internalOwner: "",
  questionnaireSentAt: "",
  respondedAt: "",
  pqcRoadmapStatus: "",
  statedPqcReadyDate: "",
  cryptoDisclosed: "",
  contractPqcClause: "",
  contractRenewalDate: "",
};

function ReadinessBadge({ assessment }: { assessment: VendorAssessment }) {
  const { verdicts } = assessment.posture;
  const worst: VendorReadinessState = verdicts.some((v) => v.state === "exposed")
    ? "exposed"
    : verdicts.some((v) => v.state === "unknown")
      ? "unknown"
      : "clear";
  const style = READINESS_STYLE[worst];

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="vendor-readiness" data-state={worst}>
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
        style={{ color: style.color, backgroundColor: style.bg }}
      >
        <style.Icon className="h-3 w-3" />
        {style.label}
      </span>
      {verdicts.map((v) => (
        <span
          key={v.scenario}
          title={v.narrative}
          className="inline-flex items-center rounded-full border border-[#e5e7eb] px-2 py-0.5 text-[10px] font-medium text-[#6b7280]"
        >
          {v.scenario} ({v.qDayYear}): {READINESS_STYLE[v.state].label}
        </span>
      ))}
    </div>
  );
}

function AttestationLine({ assessment }: { assessment: VendorAssessment }) {
  const { attestation, responseState, answeredQuestionCount, questionCount } = assessment.posture;
  const response = RESPONSE_STYLE[responseState];

  return (
    <div
      className="mt-3 rounded-xl border border-[#e5e7eb] bg-[#f7f8fa] p-3"
      data-testid="vendor-attestation"
      data-modality={attestation.discoveryModality}
      data-confidence={attestation.confidence === null ? "none" : String(attestation.confidence)}
      data-response-state={responseState}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold"
          style={{ color: response.color, backgroundColor: response.bg }}
        >
          {response.label} ({answeredQuestionCount}/{questionCount})
        </span>
        <span className="text-[11px] font-medium text-[#6b7280]">
          Discovery: manual attestation ·{" "}
          {attestation.confidence === null
            ? "no confidence — nothing was claimed"
            : `confidence ${attestation.confidence} (a collector's evidence is 0.7–1.0)`}
        </span>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-[#6b7280]">{attestation.caveat}</p>
    </div>
  );
}

function ClauseBadge({ assessment }: { assessment: VendorAssessment }) {
  const { clause } = assessment.posture;
  const style = CLAUSE_STYLE[clause.state];

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="vendor-clause" data-state={clause.state}>
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
        style={{ color: style.color, backgroundColor: style.bg }}
        title={clause.narrative}
      >
        {clause.state === "absent" ? <FileWarning className="h-3 w-3" /> : null}
        {style.label}
      </span>
      <span className="text-[11px] text-[#9aa3b2]">
        Renewal:{" "}
        {clause.contractRenewalDate ? new Date(clause.contractRenewalDate).toISOString().slice(0, 10) : "not recorded"}
      </span>
      {clause.noLeverScheduled && (
        <span className="text-[11px] font-medium text-[#dc2626]" data-testid="vendor-no-lever">
          No obligation and no renewal scheduled — no lever
        </span>
      )}
    </div>
  );
}

export function VendorRegister() {
  const { data: assessments, refetch, isPending, isError } = useListVendorAssessments();
  const createAssessment = useCreateVendorAssessment();
  const deleteAssessment = useDeleteVendorAssessment();
  const { toast } = useToast();

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState("");

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.vendorName.trim()) {
      setFormError("Vendor name is required");
      return;
    }
    setFormError("");

    // Every optional field is omitted rather than sent as an empty string — an
    // empty string is not "not supplied", and the server stores whatever it
    // receives. Omitting is what keeps the column null, i.e. honestly "the
    // vendor has not told us" or "nobody has read the contract".
    createAssessment.mutate(
      {
        data: {
          vendorName: form.vendorName.trim(),
          ...(form.productOrService.trim() && { productOrService: form.productOrService.trim() }),
          ...(form.internalOwner.trim() && { internalOwner: form.internalOwner.trim() }),
          ...(form.questionnaireSentAt && { questionnaireSentAt: form.questionnaireSentAt }),
          ...(form.respondedAt && { respondedAt: form.respondedAt }),
          ...(form.pqcRoadmapStatus !== "" && { pqcRoadmapStatus: form.pqcRoadmapStatus }),
          ...(form.statedPqcReadyDate && { statedPqcReadyDate: form.statedPqcReadyDate }),
          ...(form.cryptoDisclosed.trim() && { cryptoDisclosed: form.cryptoDisclosed.trim() }),
          ...(form.contractPqcClause !== "" && { contractPqcClause: form.contractPqcClause }),
          ...(form.contractRenewalDate && { contractRenewalDate: form.contractRenewalDate }),
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Vendor recorded" });
          setForm(EMPTY_FORM);
          void refetch();
        },
        onError: (error) => {
          toast({ title: "Could not record vendor", description: (error as Error).message, variant: "destructive" });
        },
      },
    );
  };

  const handleDelete = (id: number) => {
    deleteAssessment.mutate(
      { id },
      {
        onSuccess: () => void refetch(),
        onError: (error) =>
          toast({ title: "Could not remove vendor", description: (error as Error).message, variant: "destructive" }),
      },
    );
  };

  return (
    <div className="flex-1 bg-white overflow-y-auto">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <motion.div initial={{ opacity: 0, y: -16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="mb-8">
          <p className="text-[11px] font-semibold text-[#4f46e5] tracking-widest mb-2 uppercase flex items-center gap-1.5">
            <Handshake className="h-3.5 w-3.5" /> Vendor / third party
          </p>
          <h1 className="text-4xl font-bold text-[#0a0e1a] mb-2">Vendor &amp; Third-Party Register</h1>
          <p className="text-[#475569] text-sm max-w-2xl">
            Every other collector reads something you own — a repo, a lockfile, a TLS endpoint, a certificate. A
            vendor's cryptography is invisible to all of them, and the only instrument that reaches it is asking. So
            everything on this page is somebody else's word, recorded as such: a questionnaire answer is a claim by an
            interested party, not an observation, and it is never shown with the authority of a completed handshake.
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
          <h2 className="text-base font-semibold text-[#0a0e1a] mb-4">Record a vendor</h2>
          <form onSubmit={handleSubmit} data-testid="vendor-form" className="space-y-4">
            <div>
              <label className={labelClass}>
                Vendor name <span className="text-[#dc2626]">*</span>
              </label>
              <input
                data-testid="vendor-name-input"
                placeholder="e.g. Acme Payments"
                value={form.vendorName}
                onChange={(e) => { set("vendorName", e.target.value); if (formError) setFormError(""); }}
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
                <label className={labelClass}>Product or service</label>
                <input
                  data-testid="vendor-product-input"
                  placeholder="e.g. Card tokenisation API"
                  value={form.productOrService}
                  onChange={(e) => set("productOrService", e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Internal owner</label>
                <input
                  data-testid="vendor-owner-input"
                  placeholder="Team or contact"
                  value={form.internalOwner}
                  onChange={(e) => set("internalOwner", e.target.value)}
                  className={inputClass}
                />
              </div>
            </div>

            <div className="rounded-xl border border-[#e5e7eb] bg-[#f7f8fa] p-4 space-y-4">
              <p className="text-[11px] font-semibold text-[#0a0e1a] uppercase tracking-widest">
                What the vendor said
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>Questionnaire sent</label>
                  <input
                    data-testid="vendor-sent-input"
                    type="date"
                    value={form.questionnaireSentAt}
                    onChange={(e) => set("questionnaireSentAt", e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Responded</label>
                  <input
                    data-testid="vendor-responded-input"
                    type="date"
                    value={form.respondedAt}
                    onChange={(e) => set("respondedAt", e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>PQC roadmap status</label>
                  <select
                    data-testid="vendor-roadmap-select"
                    value={form.pqcRoadmapStatus}
                    onChange={(e) => set("pqcRoadmapStatus", e.target.value as FormState["pqcRoadmapStatus"])}
                    className={inputClass}
                  >
                    <option value="">Not answered</option>
                    <option value="none">No plan</option>
                    <option value="assessing">Assessing</option>
                    <option value="roadmap_published">Roadmap published</option>
                    <option value="migration_underway">Migration underway</option>
                    <option value="pqc_available">PQC available</option>
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Date they claim PQC readiness</label>
                  <input
                    data-testid="vendor-ready-date-input"
                    type="date"
                    value={form.statedPqcReadyDate}
                    onChange={(e) => set("statedPqcReadyDate", e.target.value)}
                    className={inputClass}
                  />
                  <p className="text-[11px] text-[#9aa3b2] mt-1">
                    Leave blank if they have not given one — that reads as "unknown", not "safe".
                  </p>
                </div>
              </div>

              <div>
                <label className={labelClass}>Cryptography they disclosed</label>
                <input
                  data-testid="vendor-crypto-input"
                  placeholder="e.g. TLS 1.2 with ECDHE-RSA, RSA-2048 signing keys — their words"
                  value={form.cryptoDisclosed}
                  onChange={(e) => set("cryptoDisclosed", e.target.value)}
                  className={inputClass}
                />
              </div>
            </div>

            <div className="rounded-xl border border-[#e5e7eb] bg-[#f7f8fa] p-4 space-y-4">
              <p className="text-[11px] font-semibold text-[#0a0e1a] uppercase tracking-widest">
                What your contract says
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>PQC migration clause</label>
                  <select
                    data-testid="vendor-clause-select"
                    value={form.contractPqcClause}
                    onChange={(e) => set("contractPqcClause", e.target.value as FormState["contractPqcClause"])}
                    className={inputClass}
                  >
                    <option value="">Not checked</option>
                    <option value="present">In the contract</option>
                    <option value="absent">Checked — not in the contract</option>
                    <option value="in_negotiation">Being negotiated</option>
                  </select>
                  <p className="text-[11px] text-[#9aa3b2] mt-1">
                    "Not checked" is not the same as "not in the contract". Only pick the second if somebody read it.
                  </p>
                </div>
                <div>
                  <label className={labelClass}>Next renewal / break point</label>
                  <input
                    data-testid="vendor-renewal-input"
                    type="date"
                    value={form.contractRenewalDate}
                    onChange={(e) => set("contractRenewalDate", e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>
            </div>

            <button
              type="submit"
              data-testid="vendor-submit"
              disabled={createAssessment.isPending}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-[#4f46e5] px-6 py-3 text-sm font-semibold text-white shadow-sm hover:bg-[#4338ca] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {createAssessment.isPending ? (
                <>
                  <span className="h-3.5 w-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Saving…
                </>
              ) : (
                "Add vendor"
              )}
            </button>
          </form>
        </motion.div>

        {/* List */}
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
          <h2 className="text-base font-semibold text-[#0a0e1a] mb-4">Recorded vendors</h2>

          {isPending && <p className="text-sm text-[#6b7280]">Loading vendors…</p>}
          {isError && <h3 className="text-sm font-semibold text-[#dc2626]">Vendors could not be loaded</h3>}
          {!isPending && !isError && (assessments ?? []).length === 0 && (
            <div data-testid="vendor-empty" className="rounded-2xl border border-dashed border-[#e5e7eb] p-8 text-center text-sm text-[#6b7280]">
              No vendors recorded yet. Add the first one above.
            </div>
          )}

          {!isPending && !isError && (assessments ?? []).length > 0 && (
            <ul data-testid="vendor-list" className="space-y-3">
              {(assessments ?? []).map((assessment) => (
                <li
                  key={assessment.id}
                  data-testid="vendor-row"
                  data-vendor-name={assessment.vendorName}
                  className="rounded-2xl border border-[#e5e7eb] bg-white p-5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-[#0a0e1a]">{assessment.vendorName}</h3>
                      <p className="mt-0.5 text-xs text-[#6b7280]">
                        {assessment.productOrService || "Product/service not recorded"}
                        {assessment.internalOwner ? ` · owner: ${assessment.internalOwner}` : ""}
                      </p>
                      <p className="mt-1 text-xs text-[#6b7280]">
                        {assessment.pqcRoadmapStatus
                          ? ROADMAP_LABEL[assessment.pqcRoadmapStatus]
                          : "Vendor has not stated a PQC roadmap"}
                      </p>
                      {assessment.cryptoDisclosed && (
                        <p className="mt-1 text-xs text-[#6b7280]">Vendor discloses: {assessment.cryptoDisclosed}</p>
                      )}
                      <p className="mt-1 text-xs text-[#9aa3b2]">
                        Claimed PQC-ready:{" "}
                        {assessment.statedPqcReadyDate
                          ? new Date(assessment.statedPqcReadyDate).toISOString().slice(0, 10)
                          : "no date given"}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove ${assessment.vendorName}`}
                      onClick={() => handleDelete(assessment.id)}
                      className="shrink-0 rounded-lg p-2 text-[#9aa3b2] hover:bg-[#fef2f2] hover:text-[#dc2626] transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-3">
                    <ReadinessBadge assessment={assessment} />
                  </div>
                  <ClauseBadge assessment={assessment} />
                  <AttestationLine assessment={assessment} />
                </li>
              ))}
            </ul>
          )}
        </motion.div>
      </div>
    </div>
  );
}
