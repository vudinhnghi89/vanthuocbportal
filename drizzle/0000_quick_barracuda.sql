CREATE TABLE "document_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_id" integer,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_events_from_check" CHECK ("document_events"."from_status" is null or from_status in ('queued', 'ocr_processing', 'rule_checking', 'classified', 'unit_processing', 'done', 'failed')),
	CONSTRAINT "document_events_to_check" CHECK (to_status in ('queued', 'ocr_processing', 'rule_checking', 'classified', 'unit_processing', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" text NOT NULL,
	"pdf_path" text NOT NULL,
	"md_path" text,
	"extracted" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"matched_rule_id" integer,
	"match_method" text,
	"main_unit_id" integer,
	"info_unit_id" integer,
	"needs_manual" boolean DEFAULT false NOT NULL,
	"error" text,
	"uploaded_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_status_check" CHECK (status in ('queued', 'ocr_processing', 'rule_checking', 'classified', 'unit_processing', 'done', 'failed')),
	CONSTRAINT "documents_match_method_check" CHECK ("documents"."match_method" is null or match_method in ('single', 'agent', 'none'))
);
--> statement-breakpoint
CREATE TABLE "integration_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"base_url" text DEFAULT '' NOT NULL,
	"api_key_enc" text,
	"input_var" text DEFAULT '' NOT NULL,
	"output_var_md" text DEFAULT '' NOT NULL,
	"output_var_json" text DEFAULT '' NOT NULL,
	"timeout_s" integer DEFAULT 120 NOT NULL,
	"retries" integer DEFAULT 3 NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_settings_key_check" CHECK (key in ('dify_ocr', 'dify_agent'))
);
--> statement-breakpoint
CREATE TABLE "issuer_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"alias" text NOT NULL,
	"canonical_issuer" text NOT NULL,
	CONSTRAINT "issuer_aliases_alias_unique" UNIQUE("alias")
);
--> statement-breakpoint
CREATE TABLE "rule_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"action" text NOT NULL,
	"actor_id" integer,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_audit_action_check" CHECK (action in ('create', 'update', 'delete', 'toggle'))
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"doc_type" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"main_unit_id" integer NOT NULL,
	"info_unit_id" integer,
	"priority" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"actor_id" integer,
	"before_masked" jsonb,
	"after_masked" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_audit_key_check" CHECK (key in ('dify_ocr', 'dify_agent'))
);
--> statement-breakpoint
CREATE TABLE "units" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_secretariat" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "units_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_role_check" CHECK (role in ('admin', 'user'))
);
--> statement-breakpoint
ALTER TABLE "document_events" ADD CONSTRAINT "document_events_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_events" ADD CONSTRAINT "document_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_matched_rule_id_rules_id_fk" FOREIGN KEY ("matched_rule_id") REFERENCES "public"."rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_main_unit_id_units_id_fk" FOREIGN KEY ("main_unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_info_unit_id_units_id_fk" FOREIGN KEY ("info_unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_settings" ADD CONSTRAINT "integration_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_audit" ADD CONSTRAINT "rule_audit_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_main_unit_id_units_id_fk" FOREIGN KEY ("main_unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_info_unit_id_units_id_fk" FOREIGN KEY ("info_unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings_audit" ADD CONSTRAINT "settings_audit_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_events_doc_idx" ON "document_events" USING btree ("document_id","at");--> statement-breakpoint
CREATE INDEX "documents_status_idx" ON "documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "documents_created_at_idx" ON "documents" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "documents_main_unit_idx" ON "documents" USING btree ("main_unit_id");--> statement-breakpoint
CREATE INDEX "rule_audit_rule_id_idx" ON "rule_audit" USING btree ("rule_id","at");--> statement-breakpoint
CREATE INDEX "rules_issuer_doc_type_idx" ON "rules" USING btree ("issuer","doc_type");--> statement-breakpoint
CREATE UNIQUE INDEX "units_one_secretariat" ON "units" USING btree ("is_secretariat") WHERE "units"."is_secretariat";