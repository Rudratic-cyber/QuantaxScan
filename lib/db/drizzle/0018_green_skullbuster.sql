/*
 * Discovery stage 0, second half. Separate from 0017 for one reason:
 * `source_domain` is what 0017's `source_scope` backfill reads, so it cannot
 * be dropped in the migration that populates from it.
 *
 * The index swap rides here rather than in 0017 because it depends on
 * `identity` being NOT NULL, which 0017's backfill is what establishes.
 *
 * Keying on `identity` is the change that matters, not a rename for tidiness:
 * `hostname` is nullable from 0017 onward, NULLs do not collide in a unique
 * index, and a constraint still keyed on it would therefore stop deduplicating
 * every target kind that has no DNS name — silently, and on every re-run.
 */
DROP INDEX "discovered_targets_org_project_hostname_method_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "discovered_targets_org_project_identity_method_idx" ON "discovered_targets" USING btree ("organization_id","project_id","identity","discovery_method");--> statement-breakpoint
ALTER TABLE "discovered_targets" DROP COLUMN "source_domain";