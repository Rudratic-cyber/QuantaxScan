import { DEFAULT_QDAY_SCENARIOS, type QDayScenario, type QDayScenarioName } from "@workspace/risk";

/**
 * B4 — "a certificate whose `notAfter` falls after the conservative Q-Day
 * scenario is the finding that matters" (docs/Claude/02-roadmap.md M2 exit
 * criterion: "Certificate inventory shows which certs outlive the
 * conservative Q-Day scenario").
 *
 * This is a direct expiry-vs-scenario-year comparison, not A4's Mosca
 * inequality (`lib/risk/src/mosca.ts`, `X + Y > Z`). Mosca asks whether data
 * outlives the cryptography protecting it, which needs a secrecy lifetime
 * and a migration-effort estimate per asset. A certificate has neither of
 * its own — the question here is narrower and needs no assumption: will the
 * relying-party trust anchored in this certificate's public-key algorithm
 * still be in force on the day the certificate itself says it expires? So
 * this reads `DEFAULT_QDAY_SCENARIOS` (Z) directly against the certificate's
 * own `notAfter`, with no X or Y at all.
 *
 * Reuses `DEFAULT_QDAY_SCENARIOS` rather than a local year, per
 * AGENTS.md/CLAUDE.md: "this repo treats a hardcoded date as a defect".
 * **Never persisted** — scenario years are customer-overridable (A4,
 * roadmap M4 Enterprise), so a stored verdict would be exactly the C1
 * stale-row failure (a 2026 row disagreeing with a 2028 read). Both callers
 * (`POST` and `GET /projects/:id/certificates`) derive this at read time.
 */
export interface CertificateQDayVerdict {
  scenario: QDayScenarioName;
  qDayYear: number;
  rationale: string;
  confidence: QDayScenario["confidence"];
  /** Whether this certificate's `notAfter` falls on or after this scenario's Q-Day (1 January of `qDayYear`). */
  outlivesQDay: boolean;
}

export function evaluateCertificateExpiryAgainstQDay(
  notAfter: Date,
  scenarios: readonly QDayScenario[] = DEFAULT_QDAY_SCENARIOS,
): CertificateQDayVerdict[] {
  return scenarios.map((scenario) => ({
    scenario: scenario.name,
    qDayYear: scenario.qDayYear,
    rationale: scenario.rationale,
    confidence: scenario.confidence,
    outlivesQDay: notAfter.getTime() >= Date.UTC(scenario.qDayYear, 0, 1),
  }));
}
