/**
 * The SQL that widens a **populated** `discovered_targets` from D8's
 * hostname-only shape to stage 0's `identity`/`target_kind`/`source_scope`.
 * docs/Claude/17-discovery-design.md §2.2.
 *
 * Exported from `src/` rather than written inline in
 * `scripts/apply-discovery-identity.ts` for one reason: **the script cannot be
 * tested and this can.** The script talks to a live `pg` connection and is run
 * by hand during a deploy; these statements run against the pglite harness in
 * `discovery-identity-backfill.test.ts`, seeded with a legacy-shaped row.
 *
 * That test is the only thing in the repository that proves the backfill
 * produces correct values, and the reason it is needed is worth stating: the
 * generated migration `0017_fine_gravity.sql` contains the same logic, but
 * every existing gate applies it to an **empty** database — pglite's
 * `createTestDb()` migrates from nothing, so its `UPDATE` matches zero rows and
 * passes without asserting anything. A backfill only tested against an empty
 * table is a backfill nobody has tested.
 *
 * Keep these statements and `0017_fine_gravity.sql` saying the same thing. They
 * are deliberately duplicated rather than shared, because the migration file is
 * a historical record that must never change once it has been applied anywhere,
 * while this is live code that may be corrected.
 */

/** Step 1 — add the new columns nullable, and release `hostname`'s NOT NULL. */
export const DISCOVERY_IDENTITY_ADD_COLUMNS = `
alter table discovered_targets
  add column if not exists identity     text,
  add column if not exists target_kind  text,
  add column if not exists source_scope jsonb,
  add column if not exists last_discovered_run_id integer;
alter table discovered_targets alter column hostname drop not null;
`;

/**
 * Step 2 — derive all three values from what the row already holds.
 *
 * Guarded on `source_domain` still existing, because migration 0018 drops it:
 * a database that has already been through the full sequence must re-run this
 * harmlessly rather than error on a missing column.
 *
 * Every row that can exist here was written by certificate transparency — the
 * only discovery method until stage 0, and the only writer of this table — so
 * each value is *derived*, not assumed:
 *
 *   identity      the CT hostname, which was this table's identity all along.
 *                 Renamed in effect, not repurposed.
 *   target_kind   `'hostname'` is a fact about CT. Written as an explicit
 *                 UPDATE and NOT as a column DEFAULT, so it cannot silently
 *                 apply to a future insert — a cloud enumeration that forgot to
 *                 pass a kind would otherwise file a KMS key ring as a
 *                 hostname, and nothing anywhere would say so.
 *   source_scope  the domain the customer asked us to search, in the
 *                 discriminated shape that now also holds a cloud account, a
 *                 directory or an issuer.
 *
 * `coalesce` throughout and a `where` that matches only unfilled rows: running
 * this twice must not overwrite a value a later method legitimately wrote.
 */
export const DISCOVERY_IDENTITY_BACKFILL = `
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_name = 'discovered_targets' and column_name = 'source_domain') then
    update discovered_targets set
      identity     = coalesce(identity, hostname),
      target_kind  = coalesce(target_kind, 'hostname'),
      source_scope = coalesce(source_scope,
                              jsonb_build_object('kind', 'domain', 'domain', source_domain))
    where identity is null or target_kind is null or source_scope is null;
  else
    update discovered_targets set
      identity    = coalesce(identity, hostname),
      target_kind = coalesce(target_kind, 'hostname')
    where identity is null or target_kind is null;
  end if;
end
$$;
`;

/** Counts rows the backfill could not derive a value for. Must be zero before constraining. */
export const DISCOVERY_IDENTITY_UNFILLED = `
select count(*)::int as n from discovered_targets
 where identity is null or target_kind is null or source_scope is null
`;

/** Step 3 — constrain, once the backfill is known to have covered every row. */
export const DISCOVERY_IDENTITY_CONSTRAIN = `
alter table discovered_targets
  alter column identity     set not null,
  alter column target_kind  set not null,
  alter column source_scope set not null;
`;
