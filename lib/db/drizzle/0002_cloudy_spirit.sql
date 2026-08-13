CREATE TABLE "organization_members" (
	"organization_id" integer NOT NULL,
	"user_id" varchar NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id"),
	CONSTRAINT "organization_members_role_check" CHECK ("organization_members"."role" in ('owner', 'member'))
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"personal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"provider_tenant_id" text,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "user_identities_provider_check" CHECK ("user_identities"."provider" in ('google', 'github', 'microsoft'))
);
--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "expire" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "organization_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "organization_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "organization_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "community_posts" ADD COLUMN "author_user_id" varchar;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "organization_id" integer;--> statement-breakpoint
ALTER TABLE "shared_reports" ADD COLUMN "organization_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_reports" ADD COLUMN "created_by_user_id" varchar;--> statement-breakpoint
ALTER TABLE "shared_reports" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_reports" ADD COLUMN "expires_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_reports" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shared_reports" ADD COLUMN "last_accessed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shared_reports" ADD COLUMN "access_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "observations" ADD COLUMN "organization_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_members_user_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_provider_subject_idx" ON "user_identities" USING btree ("provider","provider_user_id");--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_reports" ADD CONSTRAINT "shared_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_reports" ADD CONSTRAINT "shared_reports_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD CONSTRAINT "collection_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_org_idx" ON "projects" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "scans_org_idx" ON "scans" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "findings_org_idx" ON "findings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "activity_org_idx" ON "activity" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "shared_reports_org_idx" ON "shared_reports" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "observations_org_idx" ON "observations" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "shared_reports" ADD CONSTRAINT "shared_reports_visibility_check" CHECK ("shared_reports"."visibility" in ('private', 'public'));