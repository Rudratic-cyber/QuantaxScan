import { pgTable, text, serial, integer, boolean, timestamp, jsonb, index, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import {
  DISCOVERY_METHOD_VALUES,
  DISCOVERY_RUN_STATUS_VALUES,
  type DiscoveryMethod,
  type DiscoveryRunStatus,
  type EnumeratedScope,
  type RefusedScope,
} from "@workspace/collectors";
import { oneOf } from "./sql-helpers";
import { organizationsTable } from "./organizations";
import { projectsTable } from "./projects";

/**
 * One execution of one discovery method — docs/Claude/17-discovery-design.md §2.3.
 *
 * **This table exists because today a discovery run leaves no record at all.**
 * `POST /projects/:id/discovery` returns `entriesRead`, `namesRead`, `rejected`
 * and `truncated` in the response body, and the instant that response closes
 * nobody can ever recover what the run covered. For certificate transparency
 * that is survivable, because a CT query is total or it fails. For a
 * credentialed cloud enumeration it is not, because **partial success is the
 * normal case**: three regions enumerated, one throttled, one `AccessDenied`,
 * one service unsupported.
 *
 * The codebase already learned this one level down. `collection_schedule_runs`
 * exists because *"a week of unreachable hosts is indistinguishable from a
 * quiet week"* — an absence with no successful collection behind it means
 * nothing at all. Discovery has the identical hole at the level of the estate
 * rather than the asset, and until this table it was wide open.
 *
 * ## This is not a `collection_runs` row, and must never become one
 *
 * The first invariant D8 established: **a discovery source writes no `assets`,
 * no `observations` and no `collection_runs` row**, and introduces no `Surface`
 * value, no fingerprint case and no `location_detail` kind. Discovery examines
 * nothing — it produces a list of places a collector *could* look — so a run
 * here must not be able to make any surface read as examined. Sharing
 * `collection_runs` would put a row that examined nothing into the table the
 * coverage meter counts, which is the one arithmetic error this whole feature
 * exists to prevent. The e2e assertion that guards it walks every surface after
 * a discovery run and requires all of them to still read `never-examined`.
 *
 * ## Why `status` has four values and not two
 *
 * `partial` is the value that did not exist anywhere in this product and had
 * to. A run that enumerated four of five regions is not `succeeded` — it did
 * not do what it was asked — and it is not `failed`, because it produced real
 * leads. Collapsing it into either destroys the only fact a report actually
 * needs: **the boundary of what we can speak for.** The vocabulary lives in
 * `@workspace/collectors` beside the method values; see `DISCOVERY_RUN_STATUS_VALUES`
 * for why `no_evidence` is separate from `failed` too.
 */
export const discoveryRunsTable = pgTable(
  "discovery_runs",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /**
     * RBAC — denormalised from the project at write, by `divisionForTarget()`.
     *
     * Not derived in the policy: parsing a project out of another column inside
     * an RLS policy runs on every row of every query. `assets`,
     * `collection_runs` and `discovered_targets` all carry the same
     * denormalised column from the same helper, and this one must not be the
     * exception that makes division scoping inconsistent.
     */
    divisionId: integer("division_id"),
    /**
     * Project-scoped, matching `discovered_targets`. §2.5 argues this at
     * length and the load-bearing half is RBAC: `divisionForTarget()` returns
     * `null` for a run that targets no project, and `null` means
     * organisation-wide — i.e. *every division sees it*. An org-wide run table
     * would therefore silently widen who can see which cloud accounts a
     * company operates, and that should be a deliberate decision rather than a
     * side effect of enumeration.
     *
     * Open question, recorded rather than hidden (§7 Q2): whether a real
     * customer maps one cloud account to more than one project. If they do,
     * two projects enumerating the same account produce two runs and two sets
     * of leads. The mitigation is to deduplicate on `(identity,
     * discovery_method)` in the *coverage arithmetic*, never in the table —
     * a query can aggregate rows, but no query can split one row back into the
     * two projects it stood for.
     */
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    discoveryMethod: text("discovery_method").$type<DiscoveryMethod>().notNull(),
    /**
     * Which stored credential this run redeemed. Null for an uncredentialed
     * method — certificate transparency needs none, which is its whole appeal.
     *
     * **Deliberately not a foreign key**, for the reason
     * `assets.status_changed_by_run_id` is not one: PostgreSQL checks
     * referential integrity with policies bypassed, so an FK here would let a
     * caller probe for the existence of another tenant's credential ids by
     * watching which inserts fail. The row is a historical record; a revoked
     * credential's id staying readable here is the audit trail working.
     */
    credentialId: integer("credential_id"),
    status: text("status").$type<DiscoveryRunStatus>().notNull(),
    /**
     * Scopes fully enumerated — pagination exhausted, no error, nothing
     * skipped. **The only thing that earns a claim of coverage.**
     */
    enumerated: jsonb("enumerated").$type<EnumeratedScope[]>().notNull().default([]),
    /**
     * Scopes attempted and not completed, each with a reason from the closed
     * vocabulary and never a vendor SDK's error string. This is the half that
     * makes `partial` mean something: without it, a partial run is just a
     * smaller successful one.
     */
    refused: jsonb("refused").$type<RefusedScope[]>().notNull().default([]),
    /** A pagination or safety ceiling was hit. Reported, never silent. */
    truncated: boolean("truncated").notNull().default(false),

    targetsCreated: integer("targets_created").notNull().default(0),
    targetsUpdated: integer("targets_updated").notNull().default(0),
    /**
     * Names the method produced and this product declined to record — out of
     * scope, a wildcard, unparseable. Counted rather than discarded, because
     * *"silently trimming 4,000 names to 500 would make 'we know of N
     * endpoints' a lie, and a lie in the one number this feature was built to
     * make honest."*
     */
    targetsRejected: integer("targets_rejected").notNull().default(0),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    /** Null while the run is in flight, and null forever if the process died mid-run — which is itself the finding. */
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /**
     * A human-readable failure, for a run whose `status` is `failed`. Null
     * otherwise, and never a substitute for a `refused` entry: a refusal is a
     * structured fact about one scope, this is what happened to the run.
     */
    error: text("error"),
  },
  (table) => [
    index("discovery_runs_org_project_idx").on(table.organizationId, table.projectId),
    index("discovery_runs_org_started_idx").on(table.organizationId, table.startedAt),
    check("discovery_runs_method_check", oneOf(table.discoveryMethod, DISCOVERY_METHOD_VALUES)),
    check("discovery_runs_status_check", oneOf(table.status, DISCOVERY_RUN_STATUS_VALUES)),
  ],
);

export const insertDiscoveryRunSchema = createInsertSchema(discoveryRunsTable).omit({ id: true, startedAt: true });
export type InsertDiscoveryRun = z.infer<typeof insertDiscoveryRunSchema>;
export type DiscoveryRun = typeof discoveryRunsTable.$inferSelect;
