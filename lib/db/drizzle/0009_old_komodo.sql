CREATE TABLE "credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"description" text,
	"ciphertext" text,
	"iv" text,
	"auth_tag" text,
	"key_id" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_redeemed_at" timestamp with time zone,
	"redemption_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" varchar,
	CONSTRAINT "credentials_kind_check" CHECK ("credentials"."kind" in ('cloud_kms_readonly', 'database_readonly', 'secrets_manager_token', 'idp_client_secret'))
);
--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "retention_mode" text DEFAULT 'retained' NOT NULL;--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "source_discarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credentials_org_idx" ON "credentials" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_org_name_idx" ON "credentials" USING btree ("organization_id","name");--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_retention_mode_check" CHECK ("scans"."retention_mode" in ('retained', 'ephemeral'));