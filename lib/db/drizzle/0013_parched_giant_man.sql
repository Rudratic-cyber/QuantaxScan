CREATE TABLE "collection_schedule_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"schedule_id" integer NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"collection_run_id" integer,
	"targets_attempted" integer DEFAULT 0 NOT NULL,
	"targets_observed" integer DEFAULT 0 NOT NULL,
	"detail" jsonb,
	"error" text,
	CONSTRAINT "collection_schedule_runs_status_check" CHECK ("collection_schedule_runs"."status" in ('succeeded', 'no_evidence', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "collection_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"target_kind" text NOT NULL,
	"target" jsonb NOT NULL,
	"interval_minutes" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_succeeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_schedules_target_kind_check" CHECK ("collection_schedules"."target_kind" in ('tls')),
	CONSTRAINT "collection_schedules_interval_minutes_check" CHECK ("collection_schedules"."interval_minutes" is null or "collection_schedules"."interval_minutes" >= 15)
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "status_changed_by_run_id" integer;--> statement-breakpoint
ALTER TABLE "collection_schedule_runs" ADD CONSTRAINT "collection_schedule_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_schedule_runs" ADD CONSTRAINT "collection_schedule_runs_schedule_id_collection_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."collection_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_schedules" ADD CONSTRAINT "collection_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_schedules" ADD CONSTRAINT "collection_schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_schedule_runs_org_started_idx" ON "collection_schedule_runs" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "collection_schedule_runs_schedule_idx" ON "collection_schedule_runs" USING btree ("schedule_id","started_at");--> statement-breakpoint
CREATE INDEX "collection_schedules_org_idx" ON "collection_schedules" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "collection_schedules_org_next_run_idx" ON "collection_schedules" USING btree ("organization_id","next_run_at");--> statement-breakpoint
CREATE INDEX "assets_org_first_seen_idx" ON "assets" USING btree ("organization_id","first_seen");--> statement-breakpoint
CREATE INDEX "assets_org_status_changed_idx" ON "assets" USING btree ("organization_id","status_changed_at");