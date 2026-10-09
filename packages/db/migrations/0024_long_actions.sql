CREATE TYPE "public"."long_action_status" AS ENUM('running', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "long_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"item_id" uuid,
	"status" "long_action_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "long_actions_order" CHECK ("long_actions"."ends_at" > "long_actions"."started_at"),
	CONSTRAINT "long_actions_finished" CHECK (("long_actions"."status" = 'running') = ("long_actions"."finished_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "long_actions" ADD CONSTRAINT "long_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "long_actions" ADD CONSTRAINT "long_actions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "long_actions_one_running" ON "long_actions" USING btree ("user_id") WHERE "long_actions"."status" = 'running';--> statement-breakpoint
CREATE INDEX "long_actions_due" ON "long_actions" USING btree ("ends_at") WHERE "long_actions"."status" = 'running';