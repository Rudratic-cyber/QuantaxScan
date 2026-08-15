CREATE TABLE "discovered_targets" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"hostname" text NOT NULL,
	"source_domain" text NOT NULL,
	"discovery_method" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"dns_resolution" text,
	"resolved_addresses" jsonb,
	"dns_checked_at" timestamp with time zone,
	"first_discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discovered_targets_method_check" CHECK ("discovered_targets"."discovery_method" in ('certificate_transparency')),
	CONSTRAINT "discovered_targets_dns_resolution_check" CHECK ("discovered_targets"."dns_resolution" in ('resolved', 'not-resolved', 'undetermined'))
);
--> statement-breakpoint
ALTER TABLE "discovered_targets" ADD CONSTRAINT "discovered_targets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_targets" ADD CONSTRAINT "discovered_targets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discovered_targets_org_project_hostname_method_idx" ON "discovered_targets" USING btree ("organization_id","project_id","hostname","discovery_method");--> statement-breakpoint
CREATE INDEX "discovered_targets_org_project_idx" ON "discovered_targets" USING btree ("organization_id","project_id");