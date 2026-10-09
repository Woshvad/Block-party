CREATE TYPE "public"."duel_status" AS ENUM('offered', 'active', 'declined', 'cancelled', 'expired', 'retreated', 'settled', 'void');--> statement-breakpoint
CREATE TABLE "duel_prefs" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"duels_on" boolean DEFAULT false NOT NULL,
	"allow_naming" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "duels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"challenger_id" uuid NOT NULL,
	"opponent_id" uuid NOT NULL,
	"challenger_side" "call_side" NOT NULL,
	"status" "duel_status" DEFAULT 'offered' NOT NULL,
	"stake_challenger" integer NOT NULL,
	"stake_opponent" integer DEFAULT 0 NOT NULL,
	"snap_challenger" boolean DEFAULT false NOT NULL,
	"snap_opponent" boolean DEFAULT false NOT NULL,
	"last_call" boolean DEFAULT false NOT NULL,
	"retreated_by" uuid,
	"winner_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "duels_two_people" CHECK ("duels"."challenger_id" <> "duels"."opponent_id"),
	CONSTRAINT "duels_stakes" CHECK ("duels"."stake_challenger" BETWEEN 0 AND 80 AND "duels"."stake_opponent" BETWEEN 0 AND 80),
	CONSTRAINT "duels_winner" CHECK ("duels"."winner_id" IS NULL OR "duels"."winner_id" IN ("duels"."challenger_id", "duels"."opponent_id")),
	CONSTRAINT "duels_retreat" CHECK ("duels"."retreated_by" IS NULL OR "duels"."retreated_by" IN ("duels"."challenger_id", "duels"."opponent_id")),
	CONSTRAINT "duels_settled" CHECK (("duels"."status" = 'settled') = ("duels"."winner_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "duel_prefs" ADD CONSTRAINT "duel_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duels" ADD CONSTRAINT "duels_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duels" ADD CONSTRAINT "duels_challenger_id_users_id_fk" FOREIGN KEY ("challenger_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duels" ADD CONSTRAINT "duels_opponent_id_users_id_fk" FOREIGN KEY ("opponent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "duels_challenger" ON "duels" USING btree ("challenger_id","status");--> statement-breakpoint
CREATE INDEX "duels_opponent" ON "duels" USING btree ("opponent_id","status");--> statement-breakpoint
CREATE INDEX "duels_market" ON "duels" USING btree ("market_id","status");