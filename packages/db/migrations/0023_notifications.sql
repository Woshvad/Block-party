CREATE TYPE "public"."notification_status" AS ENUM('queued', 'sent', 'suppressed', 'failed');--> statement-breakpoint
CREATE TABLE "crew_bot_mutes" (
	"crew_id" uuid NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "crew_bot_mutes_crew_id_kind_pk" PRIMARY KEY("crew_id","kind")
);
--> statement-breakpoint
CREATE TABLE "crew_bot_posts" (
	"crew_id" uuid NOT NULL,
	"city_day" date NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crew_bot_posts_crew_id_city_day_kind_pk" PRIMARY KEY("crew_id","city_day","kind")
);
--> statement-breakpoint
CREATE TABLE "notification_prefs" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"quiet_start" integer DEFAULT 23 NOT NULL,
	"quiet_end" integer DEFAULT 8 NOT NULL,
	"alerts" text[] DEFAULT '{}'::text[] NOT NULL,
	"bell_2h" boolean DEFAULT false NOT NULL,
	"push_off" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_prefs_hours" CHECK ("notification_prefs"."quiet_start" BETWEEN 0 AND 23 AND "notification_prefs"."quiet_end" BETWEEN 0 AND 23)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "notification_status" DEFAULT 'queued' NOT NULL,
	"reason" text,
	"template" text,
	"text" text,
	"local_day" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	CONSTRAINT "notifications_sent" CHECK (("notifications"."status" = 'sent') = ("notifications"."sent_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "crew_bot_mutes" ADD CONSTRAINT "crew_bot_mutes_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_bot_posts" ADD CONSTRAINT "crew_bot_posts_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_due" ON "notifications" USING btree ("scheduled_for") WHERE "notifications"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "notifications_user" ON "notifications" USING btree ("user_id","created_at");