CREATE TABLE "mutation_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"project_id" uuid,
	"resource_id" text,
	"action" text NOT NULL,
	"source" text NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"status_code" integer,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "mutation_audit_project_created_idx" ON "mutation_audit" USING btree ("project_id","created_at","id");