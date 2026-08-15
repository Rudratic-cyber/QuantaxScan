import { sql } from "drizzle-orm";
import { executeRows, type AppDatabase } from "./org-scope";

/**
 * Verification that tenant isolation is actually installed — not merely that
 * something called a policy exists.
 *
 * This is the control that catches the trap in
 * docs/Claude/13-auth-and-tenancy.md §5.4: `drizzle-kit push` creates policies
 * with `polqual IS NULL`, which permit every row. RLS reads as enabled, `\d+`
 * lists the policy, and there is no isolation at all. A check that only asked
 * "does a policy exist?" would pass on exactly that state.
 *
 * So the check is specific: for every organisation-scoped table, RLS must be
 * ENABLED and FORCED, and there must be at least one policy that applies to
 * the runtime role AND has a non-null `USING` expression.
 *
 * The same function backs `assertTenantIsolationInstalled()` at API-server
 * startup and the migration-integrity test in lib/db, so the check runs
 * against the real production database and not only the test one.
 */

/** The role the runtime connects as. Must not own the tables and must not have BYPASSRLS. */
export const RUNTIME_DB_ROLE = "quantaxscan_app";

export const ORG_SCOPED_TABLES = [
  "projects",
  "scans",
  "findings",
  "assets",
  "observations",
  "collection_runs",
  "activity",
  "shared_reports",
  "organizations",
  "organization_members",
  "ot_fleets",
  "vendor_assessments",
  // F4 — the credential store. Scoped like everything else, and additionally
  // encrypted at rest; RLS is what stops one tenant addressing another's
  // credential id, encryption is what survives a database-only compromise.
  // Neither substitutes for the other.
  "credentials",
] as const;

export type OrgScopedTable = (typeof ORG_SCOPED_TABLES)[number];

export interface TableIsolationState {
  table: string;
  exists: boolean;
  rlsEnabled: boolean;
  rlsForced: boolean;
  /** Policies applying to the runtime role (or to PUBLIC) that have a real USING expression. */
  effectivePolicies: string[];
  /** Policies applying to the runtime role whose USING expression is NULL — i.e. permit-everything. */
  permitAllPolicies: string[];
}

interface StateRow {
  table_name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  policy_name: string | null;
  qual_is_null: boolean | null;
  applies_to_runtime: boolean | null;
}

export async function inspectTenantIsolation(db: AppDatabase): Promise<TableIsolationState[]> {
  const tables = sql.raw(ORG_SCOPED_TABLES.map((t) => `'${t}'`).join(", "));

  // `polroles = '{0}'` is the encoding for a policy applied to PUBLIC; any
  // other entry is an explicit role OID list.
  const rows = await executeRows<StateRow>(
    db,
    sql`
    select c.relname                                as table_name,
           c.relrowsecurity                         as rls_enabled,
           c.relforcerowsecurity                    as rls_forced,
           p.polname                                as policy_name,
           (p.polqual is null)                      as qual_is_null,
           (p.polroles = '{0}'
            or ${RUNTIME_DB_ROLE}::regrole::oid = any(p.polroles)) as applies_to_runtime
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_policy p on p.polrelid = c.oid
     where n.nspname = 'public'
       and c.relname in (${tables})`,
  );

  return ORG_SCOPED_TABLES.map((table) => {
    const forTable = rows.filter((r) => r.table_name === table);
    const first = forTable[0];
    return {
      table,
      exists: first !== undefined,
      rlsEnabled: first?.rls_enabled === true,
      rlsForced: first?.rls_forced === true,
      effectivePolicies: forTable
        .filter((r) => r.policy_name !== null && r.applies_to_runtime === true && r.qual_is_null === false)
        .map((r) => r.policy_name as string),
      permitAllPolicies: forTable
        .filter((r) => r.policy_name !== null && r.applies_to_runtime === true && r.qual_is_null === true)
        .map((r) => r.policy_name as string),
    };
  });
}

export function describeIsolationFailures(states: TableIsolationState[]): string[] {
  const problems: string[] = [];

  for (const state of states) {
    if (!state.exists) {
      problems.push(`${state.table}: table does not exist — run the migrations first`);
      continue;
    }
    if (!state.rlsEnabled) {
      problems.push(`${state.table}: row-level security is not enabled`);
    }
    if (!state.rlsForced) {
      problems.push(`${state.table}: row-level security is not FORCEd (a table owner would bypass its own policies)`);
    }
    if (state.permitAllPolicies.length > 0) {
      problems.push(
        `${state.table}: policy ${state.permitAllPolicies.join(", ")} has a NULL USING expression, which permits EVERY row. ` +
          `This is what \`drizzle-kit push\` produces — reapply lib/db/sql/tenant-isolation.sql`,
      );
    }
    if (state.effectivePolicies.length === 0) {
      problems.push(
        `${state.table}: no policy with a real USING expression applies to ${RUNTIME_DB_ROLE}`,
      );
    }
  }

  return problems;
}

/**
 * Fail closed at startup rather than serve a request with isolation missing.
 * Mirrors the existing `assertApiKeysConfigured()` idiom in the API server.
 */
export async function assertTenantIsolationInstalled(db: AppDatabase): Promise<void> {
  const problems = describeIsolationFailures(await inspectTenantIsolation(db));

  if (problems.length > 0) {
    throw new Error(
      `Tenant isolation is not installed. Refusing to start.\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\n\nApply it with: pnpm --filter @workspace/db run apply-rls` +
        `\n(see docs/Claude/13-auth-and-tenancy.md §5.4 for why this is not managed by drizzle-kit push)`,
    );
  }
}
