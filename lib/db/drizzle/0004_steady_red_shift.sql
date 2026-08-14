CREATE TABLE "ot_fleets" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"vendor" text,
	"model" text,
	"device_count" integer,
	"site" text,
	"owner" text,
	"crypto_in_use" text,
	"refresh_cycle_years" integer,
	"next_procurement_date" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ot_fleets_device_count_check" CHECK ("ot_fleets"."device_count" is null or "ot_fleets"."device_count" >= 0),
	CONSTRAINT "ot_fleets_refresh_cycle_years_check" CHECK ("ot_fleets"."refresh_cycle_years" is null or "ot_fleets"."refresh_cycle_years" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ot_fleets" ADD CONSTRAINT "ot_fleets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ot_fleets_org_idx" ON "ot_fleets" USING btree ("organization_id");