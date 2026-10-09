CREATE TYPE "public"."syndicate_status" AS ENUM('proposed', 'live', 'expired');--> statement-breakpoint
CREATE TABLE "syndicate_shakes" (
	"syndicate_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "syndicate_shakes_syndicate_id_user_id_pk" PRIMARY KEY("syndicate_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "syndicates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crew_id" uuid NOT NULL,
	"proposer_id" uuid NOT NULL,
	"market_id" uuid,
	"city_market_id" uuid,
	"side" "call_side" NOT NULL,
	"per_shake" integer,
	"needed" integer NOT NULL,
	"status" "syndicate_status" DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"live_at" timestamp with time zone,
	CONSTRAINT "syndicates_target" CHECK (("syndicates"."market_id" IS NULL) <> ("syndicates"."city_market_id" IS NULL)),
	CONSTRAINT "syndicates_per_shake" CHECK (("syndicates"."city_market_id" IS NULL) = ("syndicates"."per_shake" IS NULL) AND ("syndicates"."per_shake" IS NULL OR "syndicates"."per_shake" BETWEEN 1 AND 50))
);
--> statement-breakpoint
ALTER TABLE "city_positions" DROP CONSTRAINT "city_positions_stake";--> statement-breakpoint
ALTER TABLE "city_positions" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "city_positions" ADD COLUMN "crew_id" uuid;--> statement-breakpoint
ALTER TABLE "syndicate_shakes" ADD CONSTRAINT "syndicate_shakes_syndicate_id_syndicates_id_fk" FOREIGN KEY ("syndicate_id") REFERENCES "public"."syndicates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "syndicate_shakes" ADD CONSTRAINT "syndicate_shakes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "syndicates" ADD CONSTRAINT "syndicates_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "syndicates" ADD CONSTRAINT "syndicates_proposer_id_users_id_fk" FOREIGN KEY ("proposer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "syndicates" ADD CONSTRAINT "syndicates_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "syndicates" ADD CONSTRAINT "syndicates_city_market_id_city_markets_id_fk" FOREIGN KEY ("city_market_id") REFERENCES "public"."city_markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "syndicates_one_open_tower" ON "syndicates" USING btree ("crew_id","market_id") WHERE "syndicates"."status" IN ('proposed', 'live') AND "syndicates"."market_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "syndicates_one_open_city" ON "syndicates" USING btree ("crew_id","city_market_id") WHERE "syndicates"."status" IN ('proposed', 'live') AND "syndicates"."city_market_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "city_positions" ADD CONSTRAINT "city_positions_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "city_positions_one_crew" ON "city_positions" USING btree ("market_id","crew_id");--> statement-breakpoint
ALTER TABLE "city_positions" ADD CONSTRAINT "city_positions_owner" CHECK (("city_positions"."user_id" IS NULL) <> ("city_positions"."crew_id" IS NULL));--> statement-breakpoint
ALTER TABLE "city_positions" ADD CONSTRAINT "city_positions_stake" CHECK ("city_positions"."stake" >= 1 AND ("city_positions"."crew_id" IS NOT NULL OR "city_positions"."stake" <= 800) AND ("city_positions"."payout" IS NULL OR "city_positions"."payout" >= 0));