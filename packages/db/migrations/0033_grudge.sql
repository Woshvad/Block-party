CREATE TYPE "public"."grudge_status" AS ENUM('offered', 'active', 'declined', 'cancelled', 'expired', 'settled', 'tied');--> statement-breakpoint
CREATE TABLE "grudge_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city_day" date NOT NULL,
	"newcomer_id" uuid NOT NULL,
	"inviter_id" uuid NOT NULL,
	"status" "grudge_status" DEFAULT 'offered' NOT NULL,
	"winner_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "grudge_two_people" CHECK ("grudge_matches"."newcomer_id" <> "grudge_matches"."inviter_id"),
	CONSTRAINT "grudge_winner" CHECK (("grudge_matches"."status" = 'settled') = ("grudge_matches"."winner_id" IS NOT NULL) AND ("grudge_matches"."winner_id" IS NULL OR "grudge_matches"."winner_id" IN ("grudge_matches"."newcomer_id", "grudge_matches"."inviter_id")))
);
--> statement-breakpoint
CREATE TABLE "inviters" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"inviter_id" uuid NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "grudge_matches" ADD CONSTRAINT "grudge_matches_newcomer_id_users_id_fk" FOREIGN KEY ("newcomer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grudge_matches" ADD CONSTRAINT "grudge_matches_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inviters" ADD CONSTRAINT "inviters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inviters" ADD CONSTRAINT "inviters_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grudge_once_per_pair" ON "grudge_matches" USING btree (LEAST("newcomer_id", "inviter_id"),GREATEST("newcomer_id", "inviter_id"));--> statement-breakpoint
CREATE INDEX "grudge_day" ON "grudge_matches" USING btree ("city_day","status");