CREATE TABLE "network_flows" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"flow_key" text NOT NULL,
	"source_identity" text NOT NULL,
	"source_address" text,
	"source_hostname" text,
	"source_workload" text,
	"destination_identity" text NOT NULL,
	"destination_address" text,
	"destination_hostname" text,
	"destination_workload" text,
	"destination_port" integer NOT NULL,
	"transport" text NOT NULL,
	"application_protocol" text,
	"crypto_state" text NOT NULL,
	"reported_cipher_suite" text,
	"reported_tls_version" text,
	"crypto_reported_at" timestamp with time zone,
	"record_format" text NOT NULL,
	"record_count" integer NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_flows_transport_check" CHECK ("network_flows"."transport" in ('tcp', 'udp', 'other')),
	CONSTRAINT "network_flows_crypto_state_check" CHECK ("network_flows"."crypto_state" in ('observed', 'undetermined')),
	CONSTRAINT "network_flows_record_format_check" CHECK ("network_flows"."record_format" in ('vpc-flow-log', 'load-balancer-access-log', 'service-mesh-telemetry', 'firewall-session-log', 'other')),
	CONSTRAINT "network_flows_destination_port_check" CHECK ("network_flows"."destination_port" is null or "network_flows"."destination_port" >= 1),
	CONSTRAINT "network_flows_record_count_check" CHECK ("network_flows"."record_count" is null or "network_flows"."record_count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "network_flows" ADD CONSTRAINT "network_flows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_flows" ADD CONSTRAINT "network_flows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "network_flows_org_flow_key_idx" ON "network_flows" USING btree ("organization_id","flow_key");--> statement-breakpoint
CREATE INDEX "network_flows_org_project_idx" ON "network_flows" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX "network_flows_org_destination_idx" ON "network_flows" USING btree ("organization_id","destination_identity","destination_port");