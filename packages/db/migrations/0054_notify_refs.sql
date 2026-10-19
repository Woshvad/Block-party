ALTER TABLE "notifications" ADD COLUMN "ref" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_once" ON "notifications" USING btree ("user_id","kind","ref") WHERE "notifications"."ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shifts_uncollected" ON "shifts" USING btree ("ends_at") WHERE "shifts"."kind" = 'active' AND "shifts"."collected_tx" IS NULL;