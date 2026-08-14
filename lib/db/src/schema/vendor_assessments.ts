import { pgTable, text, serial, integer, timestamp, index, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { oneOf } from "./sql-helpers";
import { organizationsTable } from "./organizations";

/**
 * B9 — the vendor / third-party register. docs/Claude/03-features.md §B9,
 * docs/Claude/02-roadmap.md "Phase 5 — Long-lead surfaces".
 *
 * The only route this product has to cryptography the customer does not
 * operate. Every other collector reads something the customer owns — a repo, a
 * lockfile, a TLS endpoint, a certificate. A vendor's crypto posture is
 * invisible to all of them, and the only instrument that reaches it is asking
 * and writing down the answer.
 *
 * **Deliberately not an `assets` row on the `vendor` surface**, for the same
 * reason B8's `ot_fleets` is not one (see that file's header), plus one that
 * is specific to this lane: `assets` records what a collector *observed*, and
 * a questionnaire answer is not an observation of anything. It is a claim,
 * made by the party with the strongest incentive to overstate, which this
 * product has not verified and mostly cannot. Persisting it beside a TLS
 * handshake — same table, same lifecycle, same `confidence` column read by the
 * same meters — would put a vendor's assertion and a completed handshake on
 * one footing, which is exactly the conflation the D3 coverage meter exists to
 * prevent. Consequence, stated rather than hidden: `vendor` stays `planned` in
 * `COLLECTOR_SURFACES`, so the meter keeps reporting the vendor surface as
 * never examined even when this register is full. That is the honest reading —
 * nothing was examined; somebody was asked.
 *
 * Two distinct kinds of fact live here and must not be collapsed:
 *
 *   1. **What the vendor said** — `pqcRoadmapStatus`, `statedPqcReadyDate`,
 *      `cryptoDisclosed`. Every one is an unverified attestation; the API
 *      stamps them `manual_attestation` with a confidence below every
 *      collector's (see `lib/api-server/src/lib/vendor-posture.ts`).
 *   2. **What the customer's contract says** — `contractPqcClause`,
 *      `contractRenewalDate`. Not a claim at all: a fact about a document the
 *      customer holds, and the only actual lever they have over a vendor who
 *      is not moving.
 *
 * Every column but `vendorName` is nullable with **no database default** — see
 * CLAUDE.md "Null means not supplied". The distinction that carries the most
 * weight here is on `contractPqcClause`: `'absent'` means somebody read the
 * contract and there is no PQC clause in it (a finding, and an actionable
 * one), while `NULL` means nobody has looked. A default of `'absent'` would
 * manufacture a finding; treating `NULL` as `'absent'` on read would do the
 * same thing one layer up. Both directions of that error are wrong and neither
 * is visible once it has happened.
 */

/**
 * How the vendor answered "do you have a post-quantum migration plan?".
 *
 * Defined here rather than in `@workspace/collectors` because — unlike
 * `Surface` or `DiscoveryModality` — none of this is part of the collector
 * contract. `lib/collectors` is deliberately dependency-free so it can ship as
 * a standalone on-prem agent, and an on-prem agent has no concept of a
 * procurement questionnaire or a contract clause, exactly as it has no concept
 * of an organisation role (`auth-enums.ts`) or a data classification
 * (`classification.ts`). The mechanism CLAUDE.md's rule protects is preserved
 * exactly: one const tuple, `text` + a `CHECK` built by `oneOf()`, never a
 * Postgres `ENUM`. They live in this file rather than a shared enums module
 * because exactly one table uses them.
 *
 * `'none'` is an answer — the vendor told us they have no plan. It is not the
 * same as `NULL`, which means the vendor has not told us anything.
 */
export const VENDOR_PQC_ROADMAP_STATUS_VALUES = [
  "none",
  "assessing",
  "roadmap_published",
  "migration_underway",
  "pqc_available",
] as const;

export type VendorPqcRoadmapStatus = (typeof VENDOR_PQC_ROADMAP_STATUS_VALUES)[number];

/**
 * Whether the contract in force with this vendor obliges them to migrate.
 *
 * There is deliberately no `'unknown'` value: unknown is `NULL`, i.e. the
 * column is not set. Adding `'unknown'` as a fourth literal would let a row be
 * both "not supplied" and "explicitly unknown" with no way to tell which a
 * given row means, and would tempt a `NOT NULL DEFAULT 'unknown'` that erases
 * the difference between an unchecked contract and a checked one.
 */
export const VENDOR_CONTRACT_CLAUSE_VALUES = ["present", "absent", "in_negotiation"] as const;

export type VendorContractClause = (typeof VENDOR_CONTRACT_CLAUSE_VALUES)[number];

export const vendorAssessmentsTable = pgTable(
  "vendor_assessments",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /** What the customer calls this supplier, e.g. "Acme Payments". The only required field. */
    vendorName: text("vendor_name").notNull(),
    /** Which product or service of theirs this assessment covers — one vendor can have several. */
    productOrService: text("product_or_service"),
    /** Free text: the internal team or person who owns this relationship. Not a user id — often procurement, not an app user. */
    internalOwner: text("internal_owner"),

    // ── What we asked, and whether they answered ────────────────────────────
    /** When the questionnaire went out. Null: it has not been sent, which is a different state from "sent and ignored". */
    questionnaireSentAt: timestamp("questionnaire_sent_at", { withTimezone: true }),
    /**
     * When the vendor's answers came back — the provenance stamp on every
     * claim below. Null means no response has been recorded, and a vendor who
     * has not answered must read as *unknown*, never as compliant.
     */
    respondedAt: timestamp("responded_at", { withTimezone: true }),

    // ── What the vendor claims (unverified attestations) ────────────────────
    pqcRoadmapStatus: text("pqc_roadmap_status").$type<VendorPqcRoadmapStatus>(),
    /**
     * The date the vendor *states* it will be post-quantum ready. Not a
     * commitment this product has verified, and not a date anybody here
     * derived — it is a quote. Null when they have not given one, which is by
     * far the most common answer and must not be filled in with a guess.
     */
    statedPqcReadyDate: timestamp("stated_pqc_ready_date", { withTimezone: true }),
    /**
     * Free-form: what the vendor says it uses, e.g. "TLS 1.2 with ECDHE-RSA,
     * RSA-2048 signing keys in HSM". Deliberately not constrained to the
     * finding algorithm vocabulary (which is derived from parsed evidence) —
     * the same reasoning as `ot_fleets.cryptoInUse`.
     */
    cryptoDisclosed: text("crypto_disclosed"),

    // ── What the customer's contract says (not a claim — a document) ────────
    /** `'absent'` = the contract was read and has no PQC clause. Null = nobody has read it. See the header. */
    contractPqcClause: text("contract_pqc_clause").$type<VendorContractClause>(),
    /**
     * Next contract renewal or break point — the moment a clause can actually
     * be inserted. A vendor with no clause and no scheduled renewal has no
     * lever at all, which is the fact this column exists to make visible.
     */
    contractRenewalDate: timestamp("contract_renewal_date", { withTimezone: true }),

    /** Where the answers are recorded: a document reference, ticket or URL. Not fetched or validated — a pointer for a human. */
    attestationEvidence: text("attestation_evidence"),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("vendor_assessments_org_idx").on(table.organizationId),
    // `oneOf()` emits `col in (...)`, which is NULL — and therefore passes a
    // CHECK — when the column is NULL. That is required: both columns are
    // nullable because null means "not supplied".
    check("vendor_assessments_pqc_roadmap_status_check", oneOf(table.pqcRoadmapStatus, VENDOR_PQC_ROADMAP_STATUS_VALUES)),
    check("vendor_assessments_contract_pqc_clause_check", oneOf(table.contractPqcClause, VENDOR_CONTRACT_CLAUSE_VALUES)),
  ],
);

export const insertVendorAssessmentSchema = createInsertSchema(vendorAssessmentsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertVendorAssessment = z.infer<typeof insertVendorAssessmentSchema>;
export type VendorAssessment = typeof vendorAssessmentsTable.$inferSelect;
