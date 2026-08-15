CREATE TABLE "division_grants" (
	"organization_id" integer NOT NULL,
	"division_id" integer NOT NULL,
	"user_id" varchar NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "division_grants_division_id_user_id_pk" PRIMARY KEY("division_id","user_id"),
	CONSTRAINT "division_grants_role_check" CHECK ("division_grants"."role" in ('viewer', 'member', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "divisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"created_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_members" DROP CONSTRAINT "organization_members_role_check";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "division_id" integer;--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "division_id" integer;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "division_id" integer;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD COLUMN "division_id" integer;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "division_id" integer;--> statement-breakpoint
ALTER TABLE "observations" ADD COLUMN "division_id" integer;--> statement-breakpoint
ALTER TABLE "discovered_targets" ADD COLUMN "division_id" integer;--> statement-breakpoint
ALTER TABLE "network_flows" ADD COLUMN "division_id" integer;--> statement-breakpoint
ALTER TABLE "collection_schedules" ADD COLUMN "division_id" integer;--> statement-breakpoint
ALTER TABLE "division_grants" ADD CONSTRAINT "division_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "division_grants" ADD CONSTRAINT "division_grants_division_id_divisions_id_fk" FOREIGN KEY ("division_id") REFERENCES "public"."divisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "division_grants" ADD CONSTRAINT "division_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "divisions" ADD CONSTRAINT "divisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "division_grants_user_idx" ON "division_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "division_grants_org_idx" ON "division_grants" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "divisions_org_slug_idx" ON "divisions" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "divisions_org_idx" ON "divisions" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_division_id_divisions_id_fk" FOREIGN KEY ("division_id") REFERENCES "public"."divisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_role_check" CHECK ("organization_members"."role" in ('viewer', 'member', 'admin', 'owner'));