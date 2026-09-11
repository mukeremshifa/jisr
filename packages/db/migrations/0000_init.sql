CREATE TYPE "public"."actor_kind" AS ENUM('worker', 'staff', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."asset_kind" AS ENUM('room', 'bus', 'machine', 'gate', 'speakup');--> statement-breakpoint
CREATE TYPE "public"."audit_severity" AS ENUM('info', 'warn', 'critical');--> statement-breakpoint
CREATE TYPE "public"."broadcast_status" AS ENUM('draft', 'previewed', 'sending', 'sent', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."case_category" AS ENUM('maintenance', 'pay', 'safety', 'accommodation', 'leave', 'transport', 'other');--> statement-breakpoint
CREATE TYPE "public"."case_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."case_status" AS ENUM('new', 'clarifying', 'awaiting_confirmation', 'confirmed', 'routed', 'escalated', 'in_progress', 'decided', 'closed', 'reopened', 'critical_open', 'pending_supervisor', 'pending_hr', 'approved', 'executed', 'denied', 'expired');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('queued', 'sent', 'delivered', 'failed', 'acked');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('image', 'audio_in', 'audio_out');--> statement-breakpoint
CREATE TYPE "public"."message_modality" AS ENUM('text', 'audio', 'image', 'location', 'sticker');--> statement-breakpoint
CREATE TYPE "public"."pay_kind" AS ENUM('overtime', 'night_overtime', 'unpaid_days', 'other');--> statement-breakpoint
CREATE TYPE "public"."pay_status" AS ENUM('proposed', 'pending_supervisor', 'pending_hr', 'approved', 'executed', 'denied', 'expired');--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"site_id" uuid,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"event" text NOT NULL,
	"severity" "audit_severity" DEFAULT 'info' NOT NULL,
	"actor" text,
	"subject" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcast_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"language" text NOT NULL,
	"provider_sid" text,
	"status" "delivery_status" DEFAULT 'queued' NOT NULL,
	"acked_at" timestamp with time zone,
	"reminders_sent" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by_staff_id" uuid,
	"text_en" text NOT NULL,
	"target" jsonb DEFAULT '{"siteIds":[]}'::jsonb NOT NULL,
	"translations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "broadcast_status" DEFAULT 'draft' NOT NULL,
	"slack_channel_id" text,
	"slack_message_ts" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_ref" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"company_id" uuid NOT NULL,
	"site_id" uuid,
	"asset_id" uuid,
	"worker_id" uuid,
	"reporter_token_hash" text,
	"is_speakup" boolean DEFAULT false NOT NULL,
	"category" "case_category",
	"severity" "case_severity",
	"status" "case_status" DEFAULT 'new' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"summary_en" text,
	"transcript_original" text,
	"transcript_en" text,
	"confirmed_by_worker" boolean DEFAULT false NOT NULL,
	"injection_suspected" boolean DEFAULT false NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"clarify_count" integer DEFAULT 0 NOT NULL,
	"correction_count" integer DEFAULT 0 NOT NULL,
	"slack_channel_id" text,
	"slack_message_ts" text,
	"decision_token_id" text,
	"sla_due_at" timestamp with time zone,
	"first_response_at" timestamp with time zone,
	"routed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"gcs_key" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"kind" "media_kind" NOT NULL,
	"duration_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid,
	"worker_id" uuid,
	"direction" "message_direction" NOT NULL,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"modality" "message_modality" NOT NULL,
	"provider_sid" text,
	"language" text,
	"text_original" text,
	"text_en" text,
	"media_id" uuid,
	"status" text DEFAULT 'received' NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pay_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"period" text NOT NULL,
	"kind" "pay_kind" NOT NULL,
	"hours_x100" integer NOT NULL,
	"rate_fils" integer NOT NULL,
	"multiplier_bp" integer NOT NULL,
	"amount_fils" integer NOT NULL,
	"payload_sha256" text NOT NULL,
	"status" "pay_status" DEFAULT 'proposed' NOT NULL,
	"proposed_by_staff_id" uuid,
	"approved_by_staff_id" uuid,
	"auth_req_id" text,
	"decided_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limits_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "sealed_identities" (
	"case_id" uuid PRIMARY KEY NOT NULL,
	"reporter_worker_id_enc" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"radius_m" integer,
	"slack_channel_id" text,
	"slack_escalation_channel_id" text,
	"slack_safety_channel_id" text,
	"timezone" text DEFAULT 'Asia/Dubai' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"email" text NOT NULL,
	"auth0_sub" text,
	"slack_user_id" text,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_sessions" (
	"worker_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"pending_asset_id" uuid,
	"pending_asset_expires_at" timestamp with time zone,
	"pending_question" text,
	"pending_question_field" text,
	"speakup_case_id" uuid,
	"last_case_id" uuid,
	"speakup_pending" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"site_id" uuid,
	"public_ref" text NOT NULL,
	"display_name" text NOT NULL,
	"phone_hmac" text NOT NULL,
	"phone_enc" "bytea" NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"hourly_rate_fils" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"consented_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_deliveries" ADD CONSTRAINT "broadcast_deliveries_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_deliveries" ADD CONSTRAINT "broadcast_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_deliveries" ADD CONSTRAINT "broadcast_deliveries_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_created_by_staff_id_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_adjustments" ADD CONSTRAINT "pay_adjustments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_adjustments" ADD CONSTRAINT "pay_adjustments_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_adjustments" ADD CONSTRAINT "pay_adjustments_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_adjustments" ADD CONSTRAINT "pay_adjustments_proposed_by_staff_id_staff_id_fk" FOREIGN KEY ("proposed_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_adjustments" ADD CONSTRAINT "pay_adjustments_approved_by_staff_id_staff_id_fk" FOREIGN KEY ("approved_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sealed_identities" ADD CONSTRAINT "sealed_identities_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_sessions" ADD CONSTRAINT "worker_sessions_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_sessions" ADD CONSTRAINT "worker_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_sessions" ADD CONSTRAINT "worker_sessions_pending_asset_id_assets_id_fk" FOREIGN KEY ("pending_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_sessions" ADD CONSTRAINT "worker_sessions_speakup_case_id_cases_id_fk" FOREIGN KEY ("speakup_case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_sessions" ADD CONSTRAINT "worker_sessions_last_case_id_cases_id_fk" FOREIGN KEY ("last_case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_company_code_uq" ON "assets" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "audit_company_time_idx" ON "audit_log" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "broadcast_deliveries_uq" ON "broadcast_deliveries" USING btree ("broadcast_id","worker_id");--> statement-breakpoint
CREATE INDEX "case_events_case_idx" ON "case_events" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cases_public_id_uq" ON "cases" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "cases_company_status_idx" ON "cases" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "cases_site_idx" ON "cases" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "cases_worker_idx" ON "cases" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "cases_sla_idx" ON "cases" USING btree ("sla_due_at");--> statement-breakpoint
CREATE INDEX "media_company_idx" ON "media" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_sid_uq" ON "messages" USING btree ("provider_sid");--> statement-breakpoint
CREATE INDEX "messages_case_idx" ON "messages" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_worker_idx" ON "messages" USING btree ("worker_id","created_at");--> statement-breakpoint
CREATE INDEX "pay_company_status_idx" ON "pay_adjustments" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_company_code_uq" ON "sites" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_company_email_uq" ON "staff" USING btree ("company_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "workers_phone_hmac_uq" ON "workers" USING btree ("phone_hmac");--> statement-breakpoint
CREATE UNIQUE INDEX "workers_company_ref_uq" ON "workers" USING btree ("company_id","public_ref");