-- ============================================================================
-- Tenant isolation: roles, grants, and row-level-security policies.
--
-- HAND-WRITTEN, AND IT HAS TO BE.
--
-- `drizzle-kit push` (0.31.9 against drizzle-orm 0.45.2) creates RLS policies
-- with NO `USING` and NO `WITH CHECK` expression — `polqual IS NULL`, which is
-- a policy that permits every row. RLS reads as "enabled", a policy exists,
-- `\d+` shows it, and there is no isolation whatsoever. Reproduced twice from
-- an empty database against PostgreSQL 16.14; see
-- docs/Claude/13-auth-and-tenancy.md §5.4.
--
-- Consequences, all load-bearing:
--   * `.enableRLS()` and `pgPolicy()` are NOT used in the drizzle schema
--     files, so `push` never tries to manage any of this.
--   * This file is applied by `pnpm --filter @workspace/db run apply-rls`
--     against DATABASE_URL_MIGRATOR, after `push`.
--   * `assertTenantIsolationInstalled()` gates API-server startup on the
--     result, so a future `push` regressing the state cannot go unnoticed.
--
-- Idempotent: safe to re-run. Applied verbatim by the pglite test harness too,
-- so the cross-tenant suite exercises these exact policies.
-- ============================================================================


-- ── 1. Roles ────────────────────────────────────────────────────────────────
-- Two roles, because RLS on a single role that also owns the tables is
-- theatre: an owner bypasses its own policies (unless FORCE, below) and a
-- superuser bypasses them unconditionally.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'quantaxscan_migrator') THEN
    -- Owner/migrator. Runs push, apply-tenancy and apply-rls. NEVER serves a
    -- request. No password is set here; assign one out of band or let
    -- `apply-rls` set it from QUANTAXSCAN_MIGRATOR_DB_PASSWORD.
    CREATE ROLE quantaxscan_migrator LOGIN;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'quantaxscan_app') THEN
    -- Runtime. No ownership, no DDL, and — critically — no BYPASSRLS.
    -- DATABASE_URL must authenticate as this role.
    CREATE ROLE quantaxscan_app LOGIN NOINHERIT;
  END IF;
END
$$;

-- The runtime role must never acquire these, whatever else changes.
ALTER ROLE quantaxscan_app NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- The migrator, by contrast, needs to bypass RLS: FORCE ROW LEVEL SECURITY
-- below subjects the table *owner* to the policies too, and the policies name
-- `quantaxscan_app` — so without this a future data migration would silently
-- see zero rows. This is precisely why the runtime must not use this role.
-- Requires superuser to grant; skipped with a notice when apply-rls is itself
-- run as the migrator.
DO $$
BEGIN
  ALTER ROLE quantaxscan_migrator BYPASSRLS;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'could not grant BYPASSRLS to quantaxscan_migrator (needs superuser); grant it by hand before the next data migration';
END
$$;


-- ── 2. Grants ───────────────────────────────────────────────────────────────
-- A second, independent layer: a table with no grant is unreachable by the
-- runtime regardless of policy. That is why `conversations` and `messages`
-- appear only in the REVOKE below — routes/chat.ts proxies to OpenAI and
-- persists nothing, so scoping them would be scoping fiction. Denied instead.

GRANT USAGE ON SCHEMA public TO quantaxscan_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  projects, scans, findings, assets, observations, collection_runs,
  activity, shared_reports, community_posts, ot_fleets, vendor_assessments,
  organizations, organization_members, user_identities, users, sessions
TO quantaxscan_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO quantaxscan_app;

-- Belt and braces. `conversations`/`messages` are not exported from
-- lib/db/src/schema/index.ts, so drizzle never migrates them and they may not
-- exist at all — hence the guard. Where they DO exist (a database predating
-- that), the runtime must not reach them.
DO $$
BEGIN
  IF to_regclass('public.conversations') IS NOT NULL THEN
    REVOKE ALL ON conversations FROM quantaxscan_app;
  END IF;
  IF to_regclass('public.messages') IS NOT NULL THEN
    REVOKE ALL ON messages FROM quantaxscan_app;
  END IF;
END
$$;


-- ── 3. Row-level security ───────────────────────────────────────────────────
-- Two transaction-local GUCs, set by withOrg() via set_config(..., true):
--   app.current_org_id   — the active organisation
--   app.current_user_id  — the signed-in user, '' for the API-key principal
--
-- `nullif(current_setting(...), '')` is not cosmetic. `current_setting(x,
-- true)` returns NULL when the GUC was never set — good, `col = NULL` is NULL,
-- the row is filtered, zero rows, fail closed. But after the transaction that
-- set it commits, it returns the EMPTY STRING, and `''::int` raises
-- `invalid input syntax for type integer: ""` — a 500 instead of an empty
-- result. `nullif` normalises both to NULL. Verified both ways.
--
-- The expression is written inline rather than wrapped in a helper function so
-- the planner can still use the `(organization_id, ...)` indexes.

-- --- The standard shape ------------------------------------------------------

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS projects_org_isolation ON projects;
CREATE POLICY projects_org_isolation ON projects AS PERMISSIVE FOR ALL TO quantaxscan_app
  USING      (organization_id = nullif(current_setting('app.current_org_id', true), '')::int)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::int);

ALTER TABLE scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE scans FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scans_org_isolation ON scans;
CREATE POLICY scans_org_isolation ON scans AS PERMISSIVE FOR ALL TO quantaxscan_app
  USING      (organization_id = nullif(current_setting('app.current_org_id', true), '')::int)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::int);

ALTER TABLE findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE findings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS findings_org_isolation ON findings;
CREATE POLICY findings_org_isolation ON findings AS PERMISSIVE FOR ALL TO quantaxscan_app
  USING      (organization_id = nullif(current_setting('app.current_org_id', true), '')::int)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::int);

ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assets_org_isolation ON assets;
CREATE POLICY assets_org_isolation ON assets AS PERMISSIVE FOR ALL TO quantaxscan_app
  USING      (organization_id = nullif(current_setting('app.current_org_id', true), '')::int)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::int);

ALTER TABLE observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE observations FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS observations_org_isolation ON observations;
CREATE POLICY observations_org_isolation ON observations AS PERMISSIVE FOR ALL TO quantaxscan_app
  USING      (organization_id = nullif(current_setting('app.current_org_id', true), '')::int)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::int);

ALTER TABLE collection_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_runs FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS collection_runs_org_isolation ON collection_runs;
CREATE POLICY collection_runs_org_isolation ON collection_runs AS PERMISSIVE FOR ALL TO quantaxscan_app
  USING      (organization_id = nullif(current_setting('app.current_org_id', true), '')::int)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::int);

ALTER TABLE ot_fleets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ot_fleets FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ot_fleets_org_isolation ON ot_fleets;
CREATE POLICY ot_fleets_org_isolation ON ot_fleets AS PERMISSIVE FOR ALL TO quantaxscan_app
  USING      (organization_id = nullif(current_setting('app.current_org_id', true), '')::int)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::int);

-- B9 — the vendor/third-party register. Standard shape: a manual register
-- carrying what a supplier claimed and what the contract with them says, both
-- of which are as tenant-private as any scan result.
ALTER TABLE vendor_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_assessments FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vendor_assessments_org_isolation ON vendor_assessments;
CREATE POLICY vendor_assessments_org_isolation ON vendor_assessments AS PERMISSIVE FOR ALL TO quantaxscan_app
  USING      (organization_id = nullif(current_setting('app.current_org_id', true), '')::int)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::int);

-- --- Three tables that need a different shape --------------------------------

-- organization_members: the caller must be able to see their OWN memberships
-- before any organisation has been selected — that is the login bootstrap.
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organization_members_org_isolation ON organization_members;
CREATE POLICY organization_members_org_isolation ON organization_members AS PERMISSIVE FOR ALL TO quantaxscan_app
  USING      (organization_id = nullif(current_setting('app.current_org_id',  true), '')::int
           OR user_id         = nullif(current_setting('app.current_user_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id',  true), '')::int);

-- organizations: the active organisation, plus the ones the caller belongs to
-- (the switcher). The subquery is evaluated under organization_members' own
-- policy, whose `user_id` branch satisfies it without referencing
-- `organizations` — so there is no recursion.
--
-- No WITH CHECK, deliberately: PostgreSQL then applies USING as the check, so
-- a runtime INSERT of a new organisation is rejected (its id is not the
-- current GUC). Organisations are created by `apply-tenancy` and, from P2, by
-- the sign-up path through withoutOrgScope().
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organizations_org_isolation ON organizations;
CREATE POLICY organizations_org_isolation ON organizations AS PERMISSIVE FOR ALL TO quantaxscan_app
  USING (id = nullif(current_setting('app.current_org_id', true), '')::int
      OR id IN (SELECT m.organization_id FROM organization_members m
                 WHERE m.user_id = nullif(current_setting('app.current_user_id', true), '')));

-- shared_reports: the public-share rule lives IN the policy, so the anonymous
-- share-link route goes THROUGH the choke point rather than around it.
ALTER TABLE shared_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_reports FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shared_reports_org_isolation ON shared_reports;
CREATE POLICY shared_reports_org_isolation ON shared_reports AS PERMISSIVE FOR ALL TO quantaxscan_app
  USING      (organization_id = nullif(current_setting('app.current_org_id', true), '')::int
           OR (visibility = 'public' AND revoked_at IS NULL AND expires_at > now()))
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::int);

-- activity: platform-level rows (organization_id IS NULL) are visible to all.
--
-- THE ASYMMETRY BELOW IS DELIBERATE — read this before "fixing" it. `USING`
-- admits NULL; `WITH CHECK` does not. The verified consequence is that a
-- NULL-org row is readable and deletable but NOT updatable: an UPDATE
-- evaluates WITH CHECK against the new row, which still has a NULL
-- organization_id, and is rejected. That is intended. The legacy global feed
-- is immutable and prunable, and no tenant may mint new unowned rows. The last
-- writer of NULL-org rows (the public demo scan route) no longer writes here.
--
-- If a platform-level writer is ever genuinely needed it goes through
-- withoutOrgScope("...") and this WITH CHECK gains the same IS NULL branch —
-- an explicit change, not an accident.
ALTER TABLE activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS activity_org_isolation ON activity;
CREATE POLICY activity_org_isolation ON activity AS PERMISSIVE FOR ALL TO quantaxscan_app
  USING      (organization_id IS NULL
           OR organization_id = nullif(current_setting('app.current_org_id', true), '')::int)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::int);

-- --- Deliberately NOT RLS-scoped ---------------------------------------------
--   users, sessions   — both are read before an organisation context exists.
--   community_posts   — public content by design.
--
-- User enumeration is still contained: the only route that lists users joins
-- through organization_members, which IS scoped, so a caller can only reach
-- users who share an organisation with them.
