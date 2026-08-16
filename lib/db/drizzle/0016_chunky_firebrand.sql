CREATE TABLE "waivers" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"division_id" integer,
	"asset_id" integer NOT NULL,
	"justification" text NOT NULL,
	"signed_off_by" text NOT NULL,
	"signed_off_by_user_id" varchar,
	"signed_off_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waivers_expiry_after_signoff_check" CHECK ("waivers"."expires_at" > "waivers"."signed_off_at")
);
--> statement-breakpoint
ALTER TABLE "waivers" ADD CONSTRAINT "waivers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waivers" ADD CONSTRAINT "waivers_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "waivers_org_asset_idx" ON "waivers" USING btree ("organization_id","asset_id");--> statement-breakpoint
CREATE INDEX "waivers_org_expires_idx" ON "waivers" USING btree ("organization_id","expires_at");