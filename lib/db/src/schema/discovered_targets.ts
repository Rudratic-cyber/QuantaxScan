import { pgTable, text, serial, integer, timestamp, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import {
  DISCOVERY_METHOD_VALUES,
  DISCOVERY_TARGET_KIND_VALUES,
  DNS_RESOLUTION_VALUES,
  type CtCertificateEvidence,
  type DiscoveryMethod,
  type DiscoveryScope,
  type DiscoveryTargetKind,
  type DnsResolution,
} from "@workspace/collectors";
import { oneOf } from "./sql-helpers";
import { organizationsTable } from "./organizations";
import { projectsTable } from "./projects";

/**
 * D8 — targets discovered without being told about them.
 * docs/Claude/03-features.md §D8.
 *
 * **Deliberately not an `assets` row**, for a reason that differs from B8's and
 * B9's. Those two are not assets because a human's claim is not an observation.
 * This one is not an asset because *there is no cryptography here at all*: a
 * discovered name is a place a collector could look, and until one does, this
 * product knows nothing about what is served there — not an algorithm, not a
 * key size, not whether anything answers. Writing it into `assets` would put a
 * name somebody's CA once logged into the same table as a completed TLS
 * handshake, and every meter that counts assets would silently inflate.
 *
 * Consequently there is **no new `Surface` value, no fingerprint case, no
 * `location_detail` kind, and no `collection_runs` row** anywhere in this
 * feature. Discovery does not examine anything, so it must not be able to make
 * a surface read as examined. What it does instead is give the D3 coverage
 * meter a denominator it has never had: "we know of 400 names and 12 have been
 * probed" is a far more useful and far more honest sentence than today's "12
 * assets on the tls surface", which quietly implies 12 is the estate.
 *
 * ## What a row here asserts, exactly
 *
 * One thing: *this name appeared in a public certificate-transparency log
 * entry for a certificate covering the domain the customer asked us to
 * search.* Not that the customer owns it, not that a host exists there, not
 * that anything is currently served from it. `evidence` carries the log record
 * that supports even that much, so a reader can check it rather than trust it.
 * See `discovery.ts` in `@workspace/collectors` for the full argument and for
 * the three filters that keep other people's names out of this table.
 *
 * ## What is deliberately *not* a column
 *
 *   - **An "owned"/"verified" flag.** There is no evidence for one and a
 *     column invites a value. Ownership verification (a DNS TXT challenge, a
 *     registrar record) is real work this lane did not do, and a nullable
 *     `verified` column would read as "not verified yet" when the truth is
 *     "this product has no verification mechanism at all".
 *   - **`examined_at` / `examined_by`.** Whether a collector has looked at a
 *     name is derived on read by matching against `assets.location`, never
 *     stored — the same discipline `resolveSecrecyLifetime()`, `assessOtExposure()`
 *     and the C1 mapping engine follow. A stored flag can disagree with the
 *     evidence; a derived one cannot.
 */
export const discoveredTargetsTable = pgTable(
  "discovered_targets",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /** RBAC — denormalised from the project. See §4.3. */
    divisionId: integer("division_id"),
    /**
     * Real foreign key, unlike `assets` (which associates to a project only by
     * its `project:<id>:` location prefix). Nothing here is fingerprinted or
     * reconciled across surfaces, so there is no reason to weaken the
     * relationship — and a cascade is the behaviour a customer expects when
     * they delete a project. Note that a foreign key is **not** subject to RLS
     * (see CLAUDE.md), so the route still confirms the parent is visible
     * inside the scope before inserting.
     */
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    /**
     * The source's own canonical id for this thing — a hostname, an ARN, a
     * resource name, an Azure `kid`, a machine SID. **Never constructed by us.**
     *
     * This was `hostname NOT NULL` when certificate transparency was the only
     * method, because a CT log yields nothing else. An IAM role, a KMS key, an
     * S3 bucket and a Windows machine have no hostname, and forcing one would
     * mean minting a fake name — the exact thing `normaliseHostname()` refuses
     * to do (*"this function never fixes a name into something plausible,
     * because a repaired name is a name nobody has evidence for"*). Read it
     * through `targetKind`, which says what sort of id it is.
     */
    identity: text("identity").notNull(),
    /** How to read `identity`. See `DISCOVERY_TARGET_KIND_VALUES`. */
    targetKind: text("target_kind").$type<DiscoveryTargetKind>().notNull(),
    /**
     * Present **iff** this target genuinely has a DNS name.
     *
     * NULL means "this kind of thing does not have one", which is why the three
     * DNS corroboration columns below are meaningful exactly where this is set
     * and meaningless where it is not. For a `hostname` target this equals
     * `identity`; the duplication is deliberate, because a query for "things we
     * could point the TLS prober at" should not have to know which target kinds
     * happen to be addressable.
     */
    hostname: text("hostname"),
    /**
     * What was searched — the question that produced this lead.
     *
     * Was `source_domain text NOT NULL`, and the reason it exists is unchanged:
     * *"a name's scope claim can be re-checked against the question that
     * produced it."* What changed is that the question outgrew a string. "We
     * enumerated your AWS account" is four facts — provider, account, service,
     * region — and any one of them can be the thing that went wrong, so the
     * shape has to hold them apart. `jsonb`, so a new scope kind needs no
     * migration; validated at the application boundary. See `DiscoveryScope`.
     */
    sourceScope: jsonb("source_scope").$type<DiscoveryScope>().notNull(),
    discoveryMethod: text("discovery_method").$type<DiscoveryMethod>().notNull(),
    /**
     * The `discovery_runs` row that most recently saw this target.
     *
     * **Not a foreign key**, matching `discovery_runs.credential_id` and
     * `assets.status_changed_by_run_id`: referential integrity is checked with
     * RLS bypassed, so an FK is a cross-tenant existence oracle. Null for rows
     * written before this column existed — which is a real state and not a
     * defect, since D8 shipped without a run record at all.
     */
    lastDiscoveredRunId: integer("last_discovered_run_id"),
    /**
     * The log record this name came from — issuer, serial, validity window,
     * entry id, and the raw name string before normalisation. Every field is
     * nullable inside the JSON for the usual reason: a log that states no
     * issuer yields null, never a placeholder that reads like a value someone
     * recorded.
     */
    evidence: jsonb("evidence").$type<CtCertificateEvidence>().notNull(),
    /**
     * What a DNS lookup established about this name — and **null means nobody
     * looked**, a fourth state distinct from all three values.
     *
     * This is corroboration, not discovery: CT tells us a name was certified,
     * DNS tells us whether it currently resolves. A name in a CT log that no
     * longer resolves is the single most common false lead this method
     * produces, and the difference between recording that and not recording it
     * is the difference between an inventory and a list of guesses.
     */
    dnsResolution: text("dns_resolution").$type<DnsResolution>(),
    /** The addresses the lookup returned, when it returned any. Null when the lookup was never made or established nothing. */
    resolvedAddresses: jsonb("resolved_addresses").$type<string[]>(),
    dnsCheckedAt: timestamp("dns_checked_at", { withTimezone: true }),
    /** When this name was first seen by any run. Re-running discovery updates `lastDiscoveredAt` and leaves this alone. */
    firstDiscoveredAt: timestamp("first_discovered_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * The most recent run that still saw this name in the log.
     *
     * A name that stops appearing is **not** deleted and **not** marked gone.
     * CT is append-only: a name disappearing from a query result says
     * something about the query, not about the estate. The row stays and its
     * `lastDiscoveredAt` ages, which is a fact; deleting it would be a claim.
     */
    lastDiscoveredAt: timestamp("last_discovered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One row per identity per method per project. Re-running discovery must
    // refresh a target, never duplicate it — a duplicated target would inflate
    // `knownTargets`, which is the number this whole feature exists to make
    // trustworthy.
    //
    // Keyed on `identity` rather than `hostname` since 0017: `hostname` is now
    // nullable, and NULLs do not collide in a unique index, so keying on it
    // would let every non-hostname target duplicate freely on every re-run —
    // silently, and in exactly the number the meter reports.
    uniqueIndex("discovered_targets_org_project_identity_method_idx").on(
      table.organizationId,
      table.projectId,
      table.identity,
      table.discoveryMethod,
    ),
    index("discovered_targets_org_project_idx").on(table.organizationId, table.projectId),
    check("discovered_targets_method_check", oneOf(table.discoveryMethod, DISCOVERY_METHOD_VALUES)),
    check("discovered_targets_kind_check", oneOf(table.targetKind, DISCOVERY_TARGET_KIND_VALUES)),
    // Nullable, so NULL satisfies this — "nobody looked" stays sayable.
    check("discovered_targets_dns_resolution_check", oneOf(table.dnsResolution, DNS_RESOLUTION_VALUES)),
  ],
);

export const insertDiscoveredTargetSchema = createInsertSchema(discoveredTargetsTable).omit({
  id: true,
  firstDiscoveredAt: true,
  lastDiscoveredAt: true,
});
export type InsertDiscoveredTarget = z.infer<typeof insertDiscoveredTargetSchema>;
export type DiscoveredTarget = typeof discoveredTargetsTable.$inferSelect;
