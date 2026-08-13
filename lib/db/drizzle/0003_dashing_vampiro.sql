ALTER TABLE "projects" ADD COLUMN "data_classification" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "secrecy_lifetime_years" integer;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_data_classification_check" CHECK ("projects"."data_classification" in ('public', 'internal', 'confidential', 'regulated', 'indefinite'));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_secrecy_lifetime_years_check" CHECK ("projects"."secrecy_lifetime_years" is null or "projects"."secrecy_lifetime_years" >= 0);--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_data_classification_check" CHECK ("assets"."data_classification" in ('public', 'internal', 'confidential', 'regulated', 'indefinite'));--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_secrecy_lifetime_years_check" CHECK ("assets"."secrecy_lifetime_years" is null or "assets"."secrecy_lifetime_years" >= 0);