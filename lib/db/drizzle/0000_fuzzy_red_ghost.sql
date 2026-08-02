CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"language" text NOT NULL,
	"risk_score" integer,
	"last_scan_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_scans" integer DEFAULT 0 NOT NULL,
	"critical_count" integer DEFAULT 0 NOT NULL,
	"alert_count" integer DEFAULT 0 NOT NULL,
	"clean_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scans" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"mode" text DEFAULT 'scan-only' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"risk_score" integer,
	"total_lines" integer DEFAULT 0 NOT NULL,
	"critical_count" integer DEFAULT 0 NOT NULL,
	"alert_count" integer DEFAULT 0 NOT NULL,
	"clean_count" integer DEFAULT 0 NOT NULL,
	"total_effort_hours" real DEFAULT 0 NOT NULL,
	"estimated_cost" integer DEFAULT 0 NOT NULL,
	"executive_summary" text,
	"code" text,
	"language" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" serial PRIMARY KEY NOT NULL,
	"scan_id" integer NOT NULL,
	"file_name" text NOT NULL,
	"line_number" integer NOT NULL,
	"severity" text NOT NULL,
	"algorithm" text NOT NULL,
	"code_snippet" text NOT NULL,
	"nist_replacement" text,
	"nist_standard" text,
	"effort_hours" real DEFAULT 1 NOT NULL,
	"explanation" text
);
--> statement-breakpoint
CREATE TABLE "community_posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"author_name" text NOT NULL,
	"language" text,
	"framework" text,
	"upvotes" integer DEFAULT 0 NOT NULL,
	"downvotes" integer DEFAULT 0 NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity" (
	"id" serial PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar,
	"first_name" varchar,
	"last_name" varchar,
	"profile_image_url" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "shared_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"repo_url" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"collector" text NOT NULL,
	"collector_version" text NOT NULL,
	"surface" text NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"target" text,
	"observation_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "collection_runs_surface_check" CHECK ("collection_runs"."surface" in ('source', 'dependency', 'tls', 'certificate', 'kms', 'config', 'ot', 'binary')),
	CONSTRAINT "collection_runs_status_check" CHECK ("collection_runs"."status" in ('running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"surface" text NOT NULL,
	"algorithm" text NOT NULL,
	"key_size" integer,
	"location" text NOT NULL,
	"location_detail" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_id" integer,
	"data_classification" text,
	"secrecy_lifetime_years" integer,
	"effort_hours" real,
	"agility_score" real,
	CONSTRAINT "assets_surface_check" CHECK ("assets"."surface" in ('source', 'dependency', 'tls', 'certificate', 'kms', 'config', 'ot', 'binary')),
	CONSTRAINT "assets_status_check" CHECK ("assets"."status" in ('active', 'remediated', 'waived', 'gone'))
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset_id" integer NOT NULL,
	"collection_run_id" integer NOT NULL,
	"collector" text NOT NULL,
	"collector_version" text NOT NULL,
	"confidence" real NOT NULL,
	"discovery_modality" text NOT NULL,
	"evidence" jsonb,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observations_discovery_modality_check" CHECK ("observations"."discovery_modality" in ('passive_network_observation', 'active_network_scan', 'endpoint_monitoring', 'configuration_information', 'static_artifact_analysis', 'manual_attestation'))
);
--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_collection_run_id_collection_runs_id_fk" FOREIGN KEY ("collection_run_id") REFERENCES "public"."collection_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "sessions" USING btree ("expire");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_org_fingerprint_idx" ON "assets" USING btree ("organization_id","fingerprint");