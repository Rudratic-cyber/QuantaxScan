/**
 * B9 — the vendor / third-party register, driven through the real browser form.
 *
 * This is the only route this product has to cryptography the customer does
 * not operate, and the only surface whose entire content is somebody else's
 * word. So the claims worth proving here are honesty claims, not CRUD ones:
 *
 *   1. A vendor's answer is stamped `manual_attestation` with a confidence
 *      below every collector's, and a vendor who has answered nothing gets no
 *      confidence at all — not a floor value that reads as weak evidence when
 *      there is no evidence.
 *   2. A vendor who has not answered reads as *unknown*, never as compliant,
 *      clear or safe. B8's "a fleet with no procurement date reads unknown,
 *      never safe" is the precedent this follows exactly.
 *   3. "The contract has no PQC clause" and "nobody has read the contract" are
 *      different facts and never render as each other. That pair is the one
 *      failure this lane can produce that no other test in the repo catches:
 *      one direction invents an obligation, the other hides one.
 *
 * No `page.route` here, per `support/fixtures.ts`'s one rule: every vendor is
 * created by filling in the real `/vendor-register` form and submitting it to
 * the real API server, and every assertion checks either what the page shows
 * or the JSON payload `GET /api/vendor-assessments` actually returns.
 */
import { test, expect } from "./support/fixtures";

function farFutureDate(): string {
  // Safely after every Q-Day scenario this product currently ships
  // (conservative/central/aggressive are 2030/2035/2040) without this spec
  // hardcoding any of those years itself.
  return "2099-06-15";
}

function nearTermDate(): string {
  // One month out from whenever the suite runs — always before every Q-Day
  // scenario, and never itself a hardcoded calendar date.
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

type ApiVendor = {
  id: number;
  vendorName: string;
  statedPqcReadyDate: string | null;
  contractPqcClause: string | null;
  cryptoDisclosed: string | null;
  posture: {
    responseState: string;
    answeredQuestionCount: number;
    questionCount: number;
    attestation: { discoveryModality: string; confidence: number | null; caveat: string };
    verdicts: { scenario: string; qDayYear: number; state: string; narrative: string }[];
    exposedScenarioCount: number;
    unknownScenarioCount: number;
    scenarioCount: number;
    clause: { state: string; contractRenewalDate: string | null; noLeverScheduled: boolean; narrative: string };
  };
};

async function vendorsFromApi(api: import("@playwright/test").APIRequestContext): Promise<ApiVendor[]> {
  const res = await api.get("/api/vendor-assessments");
  expect(res.status()).toBe(200);
  return (await res.json()) as ApiVendor[];
}

test.describe("the vendor / third-party register (B9)", () => {
  test("an empty register reads as empty, not as loading forever or an error", async ({ credentialed }) => {
    await credentialed.goto("/vendor-register");
    await expect(credentialed.getByTestId("vendor-empty")).toBeVisible({ timeout: 20_000 });
    await expect(credentialed.getByText("Vendors could not be loaded")).toHaveCount(0);
  });

  test("saving a vendor through the real form persists it, and the panel's payload matches what's on screen", async ({
    credentialed,
    api,
  }) => {
    await credentialed.goto("/vendor-register");

    await credentialed.getByTestId("vendor-name-input").fill("Acme Payments");
    await credentialed.getByTestId("vendor-product-input").fill("Card tokenisation API");
    await credentialed.getByTestId("vendor-owner-input").fill("Procurement");
    await credentialed.getByTestId("vendor-responded-input").fill(nearTermDate());
    await credentialed.getByTestId("vendor-roadmap-select").selectOption("roadmap_published");
    await credentialed.getByTestId("vendor-ready-date-input").fill(farFutureDate());
    await credentialed.getByTestId("vendor-crypto-input").fill("TLS 1.2 with ECDHE-RSA, RSA-2048 signing keys");
    await credentialed.getByTestId("vendor-submit").click();

    const row = credentialed.getByTestId("vendor-row").filter({ hasText: "Acme Payments" });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText("Card tokenisation API");
    await expect(row).toContainText("owner: Procurement");
    await expect(row).toContainText("Vendor states: roadmap published");
    await expect(row).toContainText("Vendor discloses: TLS 1.2 with ECDHE-RSA");

    // The form cleared and the list, not the form, is the source of truth.
    await expect(credentialed.getByTestId("vendor-name-input")).toHaveValue("");

    const vendors = await vendorsFromApi(api);
    const saved = vendors.find((v) => v.vendorName === "Acme Payments");
    expect(saved, "the vendor the form claims to have saved must actually be in the register").toBeDefined();
    expect(saved!.statedPqcReadyDate).not.toBeNull();
    expect(new Date(saved!.statedPqcReadyDate!).getUTCFullYear()).toBe(2099);
    // Every one of the three vendor-answered questions was filled in.
    expect(saved!.posture.responseState).toBe("answered");
    expect(saved!.posture.answeredQuestionCount).toBe(saved!.posture.questionCount);
  });

  test("a vendor's answer is stamped manual_attestation with a confidence below every collector's", async ({
    credentialed,
    api,
  }) => {
    await credentialed.goto("/vendor-register");

    await credentialed.getByTestId("vendor-name-input").fill("Attestation provenance vendor");
    await credentialed.getByTestId("vendor-roadmap-select").selectOption("pqc_available");
    await credentialed.getByTestId("vendor-submit").click();

    const row = credentialed.getByTestId("vendor-row").filter({ hasText: "Attestation provenance vendor" });
    await expect(row).toBeVisible({ timeout: 20_000 });

    const attestation = row.getByTestId("vendor-attestation");
    await expect(attestation).toHaveAttribute("data-modality", "manual_attestation");
    await expect(attestation).toContainText("manual attestation");
    // Shown to the reader, not just carried in the payload: nothing on this
    // page was observed by anything.
    await expect(attestation).toContainText(/not observed|Nothing in this response was observed/i);

    const saved = (await vendorsFromApi(api)).find((v) => v.vendorName === "Attestation provenance vendor")!;
    expect(saved.posture.attestation.discoveryModality).toBe("manual_attestation");
    // The scale documented on `RawObservation.confidence`: regex 0.7, a
    // completed TLS handshake 1.0. A vendor's self-report must sit below both,
    // or a claim is being presented with the authority of a handshake.
    expect(saved.posture.attestation.confidence).not.toBeNull();
    expect(saved.posture.attestation.confidence!).toBeLessThan(0.7);
    expect(saved.posture.attestation.confidence!).toBeGreaterThan(0);
  });

  test("a vendor who has not answered reads as unknown — never as compliant, clear or safe", async ({
    credentialed,
    api,
  }) => {
    await credentialed.goto("/vendor-register");

    // Nothing but the name: the questionnaire has gone nowhere, or gone
    // unanswered. This is the case the register exists to make honest.
    await credentialed.getByTestId("vendor-name-input").fill("Silent supplier — never replied");
    await credentialed.getByTestId("vendor-submit").click();

    const row = credentialed.getByTestId("vendor-row").filter({ hasText: "Silent supplier — never replied" });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText("Vendor has not stated a PQC roadmap");
    await expect(row).toContainText("Claimed PQC-ready: no date given");

    const badge = row.getByTestId("vendor-readiness");
    await expect(badge).toHaveAttribute("data-state", "unknown");
    await expect(badge).toContainText("Unknown");
    // The failure this test exists to catch: silence rendering as a clean bill
    // of health anywhere in the row.
    await expect(badge).not.toContainText(/\bClaimed in time\b/);
    await expect(row).not.toContainText(/\bsafe\b/i);
    await expect(row).not.toContainText(/\bcompliant\b/i);

    // No claim exists, so there is nothing to be confident about — the badge
    // must not show a low confidence, which would read as weak evidence rather
    // than as no evidence.
    const attestation = row.getByTestId("vendor-attestation");
    await expect(attestation).toHaveAttribute("data-confidence", "none");
    await expect(attestation).toHaveAttribute("data-response-state", "awaiting_response");
    await expect(attestation).toContainText("Awaiting response");

    const saved = (await vendorsFromApi(api)).find((v) => v.vendorName === "Silent supplier — never replied")!;
    expect(saved.posture.attestation.confidence).toBeNull();
    expect(saved.posture.responseState).toBe("awaiting_response");
    expect(saved.posture.unknownScenarioCount).toBe(saved.posture.scenarioCount);
    expect(saved.posture.exposedScenarioCount).toBe(0);
    expect(saved.posture.verdicts.every((v) => v.state === "unknown")).toBe(true);
  });

  test("a vendor whose own claimed readiness date falls after a Q-Day scenario is surfaced as exposed", async ({
    credentialed,
    api,
  }) => {
    await credentialed.goto("/vendor-register");

    await credentialed.getByTestId("vendor-name-input").fill("Late supplier — 2099 by their own account");
    await credentialed.getByTestId("vendor-ready-date-input").fill(farFutureDate());
    await credentialed.getByTestId("vendor-submit").click();

    const row = credentialed.getByTestId("vendor-row").filter({ hasText: "Late supplier — 2099 by their own account" });
    await expect(row).toBeVisible({ timeout: 20_000 });

    const badge = row.getByTestId("vendor-readiness");
    await expect(badge).toHaveAttribute("data-state", "exposed");
    await expect(badge).toContainText("Exposed");
    // The conservative scenario specifically — the deadline that binds soonest.
    await expect(badge).toContainText(/conservative.*Exposed/);

    const saved = (await vendorsFromApi(api)).find(
      (v) => v.vendorName === "Late supplier — 2099 by their own account",
    )!;
    expect(saved.posture.exposedScenarioCount).toBeGreaterThan(0);
    const conservative = saved.posture.verdicts.find((v) => v.scenario === "conservative")!;
    expect(conservative.state).toBe("exposed");
    // Even the exposed verdict is stated as the vendor's claim rather than as
    // a fact this product established.
    expect(conservative.narrative).toMatch(/vendor states/i);
  });

  test("a vendor claiming readiness before every scenario reads as a claim, not as proof", async ({
    credentialed,
    api,
  }) => {
    await credentialed.goto("/vendor-register");

    await credentialed.getByTestId("vendor-name-input").fill("Prompt supplier — claims next month");
    await credentialed.getByTestId("vendor-ready-date-input").fill(nearTermDate());
    await credentialed.getByTestId("vendor-submit").click();

    const row = credentialed.getByTestId("vendor-row").filter({ hasText: "Prompt supplier — claims next month" });
    await expect(row).toBeVisible({ timeout: 20_000 });

    const badge = row.getByTestId("vendor-readiness");
    await expect(badge).toHaveAttribute("data-state", "clear");
    // The wording proves exposure is not unconditional without ever claiming
    // the vendor *is* ready — "Claimed in time", not "Clear".
    await expect(badge).toContainText("Claimed in time");

    const saved = (await vendorsFromApi(api)).find((v) => v.vendorName === "Prompt supplier — claims next month")!;
    expect(saved.posture.exposedScenarioCount).toBe(0);
    expect(saved.posture.unknownScenarioCount).toBe(0);
    expect(saved.posture.verdicts.every((v) => v.narrative.match(/claim, not an observation/i))).toBe(true);
  });
});

test.describe("B9 — 'no PQC clause' and 'nobody read the contract' are different facts", () => {
  test("a contract nobody has read reads as not checked, and never as having no clause", async ({
    credentialed,
    api,
  }) => {
    await credentialed.goto("/vendor-register");

    // The clause dropdown is left on its default. Nobody has opened the
    // contract; that is not a finding about the contract.
    await credentialed.getByTestId("vendor-name-input").fill("Unread contract vendor");
    await credentialed.getByTestId("vendor-submit").click();

    const row = credentialed.getByTestId("vendor-row").filter({ hasText: "Unread contract vendor" });
    await expect(row).toBeVisible({ timeout: 20_000 });

    const clause = row.getByTestId("vendor-clause");
    await expect(clause).toHaveAttribute("data-state", "unknown");
    await expect(clause).toContainText("Contract not checked");
    // The failure in this direction: an unchecked contract rendered as a
    // finding the customer never made.
    await expect(clause).not.toContainText("No PQC clause in contract");
    // ...and it must not claim a lever is missing either, which is a claim
    // about a contract somebody actually read.
    await expect(row.getByTestId("vendor-no-lever")).toHaveCount(0);

    const saved = (await vendorsFromApi(api)).find((v) => v.vendorName === "Unread contract vendor")!;
    expect(saved.contractPqcClause).toBeNull();
    expect(saved.posture.clause.state).toBe("unknown");
    expect(saved.posture.clause.noLeverScheduled).toBe(false);
    expect(saved.posture.clause.narrative).toMatch(/not the same as there being none/i);
  });

  test("a contract that was read and has no clause reads as a finding, never as neutral", async ({
    credentialed,
    api,
  }) => {
    await credentialed.goto("/vendor-register");

    await credentialed.getByTestId("vendor-name-input").fill("No-clause vendor");
    await credentialed.getByTestId("vendor-clause-select").selectOption("absent");
    await credentialed.getByTestId("vendor-submit").click();

    const row = credentialed.getByTestId("vendor-row").filter({ hasText: "No-clause vendor" });
    await expect(row).toBeVisible({ timeout: 20_000 });

    const clause = row.getByTestId("vendor-clause");
    await expect(clause).toHaveAttribute("data-state", "absent");
    await expect(clause).toContainText("No PQC clause in contract");
    // The failure in the other direction: a real finding rendered as the
    // neutral "we haven't looked" state.
    await expect(clause).not.toContainText("Contract not checked");
    // No clause and no renewal date recorded: no obligation, and no scheduled
    // moment at which one could be created.
    await expect(row.getByTestId("vendor-no-lever")).toBeVisible();

    const saved = (await vendorsFromApi(api)).find((v) => v.vendorName === "No-clause vendor")!;
    expect(saved.contractPqcClause).toBe("absent");
    expect(saved.posture.clause.state).toBe("absent");
    expect(saved.posture.clause.noLeverScheduled).toBe(true);
    expect(saved.posture.clause.narrative).toMatch(/no contractual obligation to migrate/i);
  });

  test("a scheduled renewal means a missing clause is not called leverless", async ({ credentialed, api }) => {
    await credentialed.goto("/vendor-register");

    await credentialed.getByTestId("vendor-name-input").fill("No-clause but renewable vendor");
    await credentialed.getByTestId("vendor-clause-select").selectOption("absent");
    await credentialed.getByTestId("vendor-renewal-input").fill(nearTermDate());
    await credentialed.getByTestId("vendor-submit").click();

    const row = credentialed.getByTestId("vendor-row").filter({ hasText: "No-clause but renewable vendor" });
    await expect(row).toBeVisible({ timeout: 20_000 });

    await expect(row.getByTestId("vendor-clause")).toHaveAttribute("data-state", "absent");
    await expect(row.getByTestId("vendor-no-lever")).toHaveCount(0);

    const saved = (await vendorsFromApi(api)).find((v) => v.vendorName === "No-clause but renewable vendor")!;
    expect(saved.posture.clause.noLeverScheduled).toBe(false);
    expect(saved.posture.clause.contractRenewalDate).not.toBeNull();
  });

  test("removing a vendor through the form takes it out of the register for real", async ({ credentialed, api }) => {
    await credentialed.goto("/vendor-register");

    await credentialed.getByTestId("vendor-name-input").fill("Vendor slated for removal");
    await credentialed.getByTestId("vendor-submit").click();

    const row = credentialed.getByTestId("vendor-row").filter({ hasText: "Vendor slated for removal" });
    await expect(row).toBeVisible({ timeout: 20_000 });

    await row.getByRole("button", { name: /Remove Vendor slated for removal/ }).click();
    await expect(row).toHaveCount(0);

    const vendors = await vendorsFromApi(api);
    expect(vendors.find((v) => v.vendorName === "Vendor slated for removal")).toBeUndefined();
  });
});
