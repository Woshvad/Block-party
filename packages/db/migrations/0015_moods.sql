CREATE TYPE "public"."mood_kind" AS ENUM('called_it', 'rekt', 'tilted', 'cozy', 'rested', 'chart_brain');--> statement-breakpoint
CREATE TABLE "copium_credits" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"free" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "copium_credits_free" CHECK ("copium_credits"."free" >= 0)
);
--> statement-breakpoint
CREATE TABLE "moods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"mood" "mood_kind" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"cleared_at" timestamp with time zone,
	"cleared_by" text,
	"source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "moods_cleared_consistent" CHECK (("moods"."cleared_at" IS NULL) = ("moods"."cleared_by" IS NULL)),
	CONSTRAINT "moods_ends_after_start" CHECK ("moods"."ends_at" IS NULL OR "moods"."ends_at" > "moods"."started_at")
);
--> statement-breakpoint
CREATE TABLE "play_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "play_sessions_order" CHECK ("play_sessions"."last_seen_at" >= "play_sessions"."started_at")
);
--> statement-breakpoint
ALTER TABLE "residents" ADD COLUMN "hide_candle_color" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "copium_credits" ADD CONSTRAINT "copium_credits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moods" ADD CONSTRAINT "moods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_sessions" ADD CONSTRAINT "play_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moods_user" ON "moods" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "moods_one_open" ON "moods" USING btree ("user_id","mood") WHERE "moods"."cleared_at" IS NULL;--> statement-breakpoint
CREATE INDEX "play_sessions_latest" ON "play_sessions" USING btree ("user_id","last_seen_at");