ALTER TABLE "share_links" ADD COLUMN "recipient_email" text;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "google_email" text;