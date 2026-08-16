CREATE TABLE "discovery_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"division_id" integer,
	"project_id" integer NOT NULL,
	"discovery_method" text NOT NULL,
	"credential_id" integer,
	"status" text NOT NULL,
	"enumerated" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"refused" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"targets_created" integer DEFAULT 0 NOT NULL,
	"targets_updated" integer DEFAULT 0 NOT NULL,
	"targets_rejected" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "discovery_runs_method_check" CHECK ("discovery_runs"."discovery_method" in ('certificate_transparency', 'cloud_account_enumeration', 'fleet_directory', 'identity_provider_metadata')),
	CONSTRAINT "discovery_runs_status_check" CHECK ("discovery_runs"."status" in ('succeeded', 'partial', 'no_evidence', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "credentials" DROP CONSTRAINT "credentials_kind_check";--> statement-breakpoint
ALTER TABLE "discovered_targets" DROP CONSTRAINT "discovered_targets_method_check";--> statement-breakpoint
ALTER TABLE "discovered_targets" ALTER COLUMN "hostname" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD COLUMN "enumeration" jsonb;--> statement-breakpoint
/*
 * Discovery stage 0 — docs/Claude/17-discovery-design.md §2.2.
 *
 * HAND-EDITED. `drizzle-kit generate` emitted these three as bare
 * `ADD COLUMN ... NOT NULL`, which cannot apply to a table that already has
 * rows: there is no value for the existing ones. Rewritten as CLAUDE.md's
 * "add nullable -> backfill -> constrain", the same shape `apply-tenancy` uses
 * and for the same reason. The snapshot is untouched and still describes the
 * end state, which is identical either way.
 *
 * `source_domain` is deliberately still present here and is dropped in 0018 —
 * it is the source of the `source_scope` backfill, so the two cannot be one
 * migration.
 */
ALTER TABLE "discovered_targets" ADD COLUMN "identity" text;--> statement-breakpoint
ALTER TABLE "discovered_targets" ADD COLUMN "target_kind" text;--> statement-breakpoint
ALTER TABLE "discovered_targets" ADD COLUMN "source_scope" jsonb;--> statement-breakpoint

/*
 * Backfill. Every row that can exist here was written by certificate
 * transparency — it was the only discovery method until this migration, and
 * the only writer of this table — so all three values are derived rather than
 * assumed:
 *
 *   identity     the CT hostname, which was this table's identity all along;
 *                the column is renamed in effect, not repurposed.
 *   target_kind  'hostname' is a fact about CT, not a default. It is written
 *                as an explicit UPDATE rather than a column DEFAULT precisely
 *                so it cannot silently apply to a future insert: a cloud
 *                enumeration that forgot to pass a kind would otherwise file
 *                a KMS key ring as a hostname, and nothing would say so.
 *   source_scope the domain the customer asked us to search, in the
 *                discriminated shape that can now also hold a cloud account.
 */
UPDATE "discovered_targets" SET
  "identity"     = "hostname",
  "target_kind"  = 'hostname',
  "source_scope" = jsonb_build_object('kind', 'domain', 'domain', "source_domain")
WHERE "identity" IS NULL;--> statement-breakpoint

ALTER TABLE "discovered_targets" ALTER COLUMN "identity" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "discovered_targets" ALTER COLUMN "target_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "discovered_targets" ALTER COLUMN "source_scope" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "discovered_targets" ADD COLUMN "last_discovered_run_id" integer;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discovery_runs_org_project_idx" ON "discovery_runs" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX "discovery_runs_org_started_idx" ON "discovery_runs" USING btree ("organization_id","started_at");--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_kind_check" CHECK ("credentials"."kind" in ('cloud_kms_readonly', 'database_readonly', 'secrets_manager_token', 'idp_client_secret', 'cloud_readonly_inventory', 'fleet_directory_readonly'));--> statement-breakpoint
ALTER TABLE "discovered_targets" ADD CONSTRAINT "discovered_targets_kind_check" CHECK ("discovered_targets"."target_kind" in ('hostname', 'cloud_account', 'cloud_resource', 'database', 'key_store', 'endpoint_host'));--> statement-breakpoint
ALTER TABLE "discovered_targets" ADD CONSTRAINT "discovered_targets_method_check" CHECK ("discovered_targets"."discovery_method" in ('certificate_transparency', 'cloud_account_enumeration', 'fleet_directory', 'identity_provider_metadata'));