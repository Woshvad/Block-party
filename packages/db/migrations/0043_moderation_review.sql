ALTER TABLE "moderation_items" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "moderation_items" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "moderation_items" ADD COLUMN "review" text;--> statement-breakpoint
ALTER TABLE "moderation_items" ADD CONSTRAINT "moderation_items_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_items_for_staff" ON "moderation_items" USING btree ("created_at") WHERE "moderation_items"."status" IN ('flagged', 'error') AND "moderation_items"."reviewed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "moderation_items" ADD CONSTRAINT "moderation_items_review" CHECK (("moderation_items"."reviewed_at" IS NULL) = ("moderation_items"."review" IS NULL) AND ("moderation_items"."review" IS NULL OR "moderation_items"."review" IN ('restored', 'removed')));