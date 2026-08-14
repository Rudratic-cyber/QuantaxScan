import { DEFAULT_QDAY_SCENARIOS, QDAY_FRAMING, type QDayScenario, type QDayScenarioName } from "@workspace/risk";
import type { VendorContractClause, VendorPqcRoadmapStatus } from "@workspace/db";

/**
 * B9's read-side derivation: what a vendor assessment actually entitles us to
 * say. docs/Claude/03-features.md §B9.
 *
 * Everything below is computed on read and never stored, the same discipline
 * A4's Mosca verdicts, C1's mappings and B8's OT exposure follow — a corrected
 * date or a revised Q-Day scenario is reflected on the next request with no
 * backfill, and no row can drift out of agreement with the rule that produced
 * it.
 *
 * **The point of this file is that a vendor's answer is not an observation.**
 * Every other surface in this product reports what a collector saw: a parsed
 * lockfile, a completed TLS handshake, a decoded certificate. This one reports
 * what a supplier said about itself, to a customer it wants to keep, in a
 * document nobody here has audited. Those are not the same kind of fact and
 * they must never be rendered with the same authority. Three mechanisms keep
 * that true:
 *
 *   1. `attestation.discoveryModality` is always `manual_attestation` — the SP
 *      1800-38B §4.1.4 extension `enums.ts` added for exactly this case.
 *   2. `attestation.confidence` sits below every collector's, and is `null`
 *      rather than a floor value when the vendor has not answered at all: no
 *      claim exists, so there is nothing to be confident about.
 *   3. Every narrative is written in the vendor's voice ("the vendor states"),
 *      never the product's ("this vendor is ready"). A board deck built from
 *      these sentences cannot accidentally launder a claim into a finding.
 *
 * The second failure mode, and the one with no precedent to copy: on the
 * contract side, **`absent` and unknown point in opposite directions and both
 * are wrong to guess.** `contractPqcClause: 'absent'` means somebody read the
 * contract and there is no PQC clause — an actionable finding. `null` means
 * nobody has read it. Rendering `null` as "no clause" invents a finding;
 * rendering `absent` as neutral hides one. Hence a four-state `clause.state`
 * where `unknown` is a first-class value with its own narrative.
 */

// ── Attestation ─────────────────────────────────────────────────────────────

/**
 * The confidence a completed vendor questionnaire carries.
 *
 * `RawObservation.confidence` (`@workspace/collectors/types.ts`) documents the
 * scale's anchors: "Regex ≈ 0.7, a completed TLS handshake ≈ 1.0". The other
 * live collectors sit inside that band — dependency evidence at 0.8 and 0.5,
 * certificates just under 1.0. This number is deliberately below all of them
 * and is **chosen, not measured**: there is no sample of vendor questionnaires
 * whose accuracy anybody here has checked, and pretending otherwise would be
 * the same manufactured precision the rest of this codebase refuses. What it
 * encodes is an ordering, and the ordering is the honest part — a self-report
 * from an interested party is weaker evidence than the weakest thing a
 * collector actually parsed.
 */
export const VENDOR_ATTESTATION_CONFIDENCE = 0.3;

export const VENDOR_ATTESTATION_CAVEAT =
  "Recorded from what the vendor said about itself. Nothing in this response was observed, parsed or verified by " +
  "QuantaXscan, and no collector examines this vendor's cryptography — a completed TLS handshake or a decoded " +
  "certificate is evidence, and this is not.";

export const VENDOR_NO_ATTESTATION_CAVEAT =
  "This vendor has not answered. No claim has been recorded, so there is nothing here to be confident about — " +
  "not a low-confidence claim, and certainly not a clean result. The vendor's cryptography is unexamined and " +
  "unattested.";

/**
 * The same absence of evidence, arrived at differently: a response *was*
 * recorded (`respondedAt` is set) and it disclosed nothing.
 *
 * `responseState` deliberately stays `awaiting_response` for both — from the
 * point of view of what is known about this vendor's cryptography they are the
 * same state, and splitting the enum would imply the product does something
 * different with them. But the caveat is customer-facing prose, and telling a
 * reader that a vendor "has not answered" when the register records that they
 * did is simply false. A vendor who replied and declined to say anything is a
 * procurement fact worth seeing, and `respondedAt` is in the payload so a
 * client can tell the two apart without a new enum member.
 */
export const VENDOR_UNINFORMATIVE_RESPONSE_CAVEAT =
  "This vendor responded and disclosed nothing — no roadmap status, no readiness date, no description of the " +
  "cryptography they use. No claim has been recorded, so there is nothing here to be confident about: a refusal " +
  "to answer is not a clean result. Their cryptography remains unexamined and unattested.";

export interface VendorAttestation {
  /** Always `manual_attestation` — SP 1800-38B §4.1.4 plus this project's two extensions. See `@workspace/collectors`'s enums. */
  discoveryModality: "manual_attestation";
  /** `null` when the vendor has answered nothing: no claim, therefore no confidence. Never a floor value. */
  confidence: number | null;
  caveat: string;
}

// ── Response state ──────────────────────────────────────────────────────────

/**
 * How much of the questionnaire the vendor has actually answered. Derived from
 * the answers themselves rather than from `respondedAt`, so a row cannot claim
 * a response it does not contain.
 */
export type VendorResponseState = "awaiting_response" | "partial" | "answered";

// ── Q-Day readiness, against what the vendor claims ─────────────────────────

export type VendorReadinessState = "exposed" | "clear" | "unknown";

export interface VendorReadinessVerdict {
  scenario: QDayScenarioName;
  qDayYear: number;
  state: VendorReadinessState;
  narrative: string;
}

// ── Contract lever ──────────────────────────────────────────────────────────

/**
 * `unknown` is the fourth state the stored column deliberately does not have
 * (see `vendor_assessments.ts`): the column is null, nobody has read the
 * contract. It is a different fact from `absent` and rendering either as the
 * other is a bug this type exists to make hard.
 */
export type VendorClauseState = VendorContractClause | "unknown";

export interface VendorClauseAssessment {
  state: VendorClauseState;
  contractRenewalDate: string | null;
  /** True only when a clause is known to be missing AND no renewal is scheduled — no obligation and no scheduled moment to create one. */
  noLeverScheduled: boolean;
  narrative: string;
}

export interface VendorPostureAssessment {
  responseState: VendorResponseState;
  answeredQuestionCount: number;
  questionCount: number;
  respondedAt: string | null;
  pqcRoadmapStatus: VendorPqcRoadmapStatus | null;
  statedPqcReadyDate: string | null;
  attestation: VendorAttestation;
  verdicts: VendorReadinessVerdict[];
  exposedScenarioCount: number;
  unknownScenarioCount: number;
  scenarioCount: number;
  clause: VendorClauseAssessment;
  /** Mandatory framing for any customer-facing use of the scenario years. */
  framing: string;
}

export interface AssessVendorPostureInput {
  respondedAt: Date | null;
  pqcRoadmapStatus: VendorPqcRoadmapStatus | null;
  /** Null when the vendor has not given a date. Never inferred from `pqcRoadmapStatus`. */
  statedPqcReadyDate: Date | null;
  cryptoDisclosed: string | null;
  contractPqcClause: VendorContractClause | null;
  contractRenewalDate: Date | null;
  /** Customer-overridable; defaults to `DEFAULT_QDAY_SCENARIOS`. Never hardcode a scenario year. */
  scenarios?: readonly QDayScenario[];
}

const ROADMAP_PHRASE: Record<VendorPqcRoadmapStatus, string> = {
  none: "states it has no post-quantum migration plan",
  assessing: "states it is still assessing post-quantum migration",
  roadmap_published: "states it has published a post-quantum roadmap",
  migration_underway: "states its post-quantum migration is underway",
  pqc_available: "states post-quantum options are already available",
};

function narrateReadiness(
  scenario: QDayScenario,
  state: VendorReadinessState,
  statedPqcReadyDate: Date | null,
  roadmapStatus: VendorPqcRoadmapStatus | null,
): string {
  if (state === "unknown") {
    const said = roadmapStatus === null ? "" : ` The vendor ${ROADMAP_PHRASE[roadmapStatus]}, but gave no date.`;
    return (
      `The vendor has not stated a date by which it will be post-quantum ready, so its readiness under the ` +
      `${scenario.name} scenario (Q-Day ${scenario.qDayYear}) is unknown — not clear.${said} Ask for a date, ` +
      `even a tentative one, to get a verdict at all.`
    );
  }

  const dateStr = statedPqcReadyDate!.toISOString().slice(0, 10);
  return state === "exposed"
    ? `The vendor states it will be post-quantum ready by ${dateStr}, which is after the ${scenario.name} ` +
      `scenario's Q-Day of ${scenario.qDayYear}. On the vendor's own account it will still be using ` +
      `quantum-vulnerable cryptography past that deadline. This is their claim, unverified — the real date ` +
      `could be later still.`
    : `The vendor states it will be post-quantum ready by ${dateStr}, which is before the ${scenario.name} ` +
      `scenario's Q-Day of ${scenario.qDayYear}. That is a claim, not an observation: nothing here has checked ` +
      `whether the date is achievable or whether it has since slipped.`;
}

function narrateClause(state: VendorClauseState, renewal: Date | null): string {
  const renewalStr = renewal === null ? null : renewal.toISOString().slice(0, 10);
  const renewalClause =
    renewalStr === null
      ? "No contract renewal or break date is recorded, so there is no scheduled moment at which one could be added."
      : `The next contract renewal or break point is ${renewalStr} — the moment at which one can be added.`;

  switch (state) {
    case "present":
      return (
        `The contract with this vendor contains a post-quantum migration clause, so there is a contractual ` +
        `obligation to point at if the vendor does not move. Whether the clause is strong enough to be worth ` +
        `invoking is a legal question this product does not answer.`
      );
    case "absent":
      return (
        `The contract has been checked and contains no post-quantum migration clause. This vendor is under no ` +
        `contractual obligation to migrate at all. ${renewalClause}`
      );
    case "in_negotiation":
      return (
        `A post-quantum migration clause is being negotiated into the contract but is not in force yet, so there ` +
        `is no obligation today. ${renewalClause}`
      );
    case "unknown":
      return (
        `Nobody has recorded whether the contract with this vendor contains a post-quantum migration clause. ` +
        `That is not the same as there being none — it means the contract has not been read. ${renewalClause}`
      );
  }
}

export function assessVendorPosture(input: AssessVendorPostureInput): VendorPostureAssessment {
  const scenarios = input.scenarios ?? DEFAULT_QDAY_SCENARIOS;

  // The three questions the *vendor* answers. `contractPqcClause` and
  // `contractRenewalDate` are deliberately not counted: they are facts about a
  // document the customer holds, recorded by the customer, so including them
  // would let a diligent customer's own filing make an unresponsive vendor
  // look like it had replied.
  const answers = [input.pqcRoadmapStatus, input.statedPqcReadyDate, input.cryptoDisclosed];
  const questionCount = answers.length;
  const answeredQuestionCount = answers.filter((a) => a !== null && a !== "").length;
  const responseState: VendorResponseState =
    answeredQuestionCount === 0 ? "awaiting_response" : answeredQuestionCount === questionCount ? "answered" : "partial";

  const date = input.statedPqcReadyDate;
  const verdicts: VendorReadinessVerdict[] = scenarios.map((scenario) => {
    const qDayInstant = Date.UTC(scenario.qDayYear, 0, 1);
    // Unknown is never clear. A vendor that has said nothing about a date —
    // including one that told us it has no plan at all — has not given us a
    // date to compare, and inferring one from `pqcRoadmapStatus` would be
    // manufacturing the vendor's commitment on their behalf in whichever
    // direction happened to suit.
    const state: VendorReadinessState = date === null ? "unknown" : date.getTime() > qDayInstant ? "exposed" : "clear";
    return {
      scenario: scenario.name,
      qDayYear: scenario.qDayYear,
      state,
      narrative: narrateReadiness(scenario, state, date, input.pqcRoadmapStatus),
    };
  });

  const clauseState: VendorClauseState = input.contractPqcClause ?? "unknown";

  return {
    responseState,
    answeredQuestionCount,
    questionCount,
    respondedAt: input.respondedAt?.toISOString() ?? null,
    pqcRoadmapStatus: input.pqcRoadmapStatus,
    statedPqcReadyDate: date?.toISOString() ?? null,
    attestation: {
      discoveryModality: "manual_attestation",
      confidence: responseState === "awaiting_response" ? null : VENDOR_ATTESTATION_CONFIDENCE,
      caveat:
        responseState !== "awaiting_response"
          ? VENDOR_ATTESTATION_CAVEAT
          : input.respondedAt === null
            ? VENDOR_NO_ATTESTATION_CAVEAT
            : VENDOR_UNINFORMATIVE_RESPONSE_CAVEAT,
    },
    verdicts,
    exposedScenarioCount: verdicts.filter((v) => v.state === "exposed").length,
    unknownScenarioCount: verdicts.filter((v) => v.state === "unknown").length,
    scenarioCount: verdicts.length,
    clause: {
      state: clauseState,
      contractRenewalDate: input.contractRenewalDate?.toISOString() ?? null,
      noLeverScheduled: clauseState === "absent" && input.contractRenewalDate === null,
      narrative: narrateClause(clauseState, input.contractRenewalDate),
    },
    framing: QDAY_FRAMING,
  };
}
