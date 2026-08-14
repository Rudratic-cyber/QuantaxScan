CREATE TABLE "vendor_assessments" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"vendor_name" text NOT NULL,
	"product_or_service" text,
	"internal_owner" text,
	"questionnaire_sent_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"pqc_roadmap_status" text,
	"stated_pqc_ready_date" timestamp with time zone,
	"crypto_disclosed" text,
	"contract_pqc_clause" text,
	"contract_renewal_date" timestamp with time zone,
	"attestation_evidence" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_assessments_pqc_roadmap_status_check" CHECK ("vendor_assessments"."pqc_roadmap_status" in ('none', 'assessing', 'roadmap_published', 'migration_underway', 'pqc_available')),
	CONSTRAINT "vendor_assessments_contract_pqc_clause_check" CHECK ("vendor_assessments"."contract_pqc_clause" in ('present', 'absent', 'in_negotiation'))
);
--> statement-breakpoint
ALTER TABLE "vendor_assessments" ADD CONSTRAINT "vendor_assessments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_assessments_org_idx" ON "vendor_assessments" USING btree ("organization_id");