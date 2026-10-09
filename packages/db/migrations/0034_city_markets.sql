CREATE TYPE "public"."city_market_kind" AS ENUM('headcount', 'manual');--> statement-breakpoint
CREATE TYPE "public"."city_market_status" AS ENUM('open', 'resolved', 'void', 'settled', 'refunded');--> statement-breakpoint
CREATE TABLE "city_markets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question" text NOT NULL,
	"kind" "city_market_kind" NOT NULL,
	"place" text,
	"threshold" integer,
	"measure_at" timestamp with time zone,
	"bell_day" date NOT NULL,
	"locks_at" timestamp with time zone NOT NULL,
	"status" "city_market_status" DEFAULT 'open' NOT NULL,
	"outcome" boolean,
	"created_by" uuid NOT NULL,
	"resolved_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "city_markets_headcount" CHECK ("city_markets"."kind" <> 'headcount' OR ("city_markets"."place" IS NOT NULL AND "city_markets"."threshold" > 0 AND "city_markets"."measure_at" IS NOT NULL)),
	CONSTRAINT "city_markets_outcome" CHECK (("city_markets"."status" IN ('resolved', 'settled')) = ("city_markets"."outcome" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "city_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"side" "call_side" NOT NULL,
	"stake" integer NOT NULL,
	"payout" integer,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "city_positions_stake" CHECK ("city_positions"."stake" BETWEEN 1 AND 800 AND ("city_positions"."payout" IS NULL OR "city_positions"."payout" >= 0))
);
--> statement-breakpoint
ALTER TABLE "city_markets" ADD CONSTRAINT "city_markets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "city_markets" ADD CONSTRAINT "city_markets_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "city_positions" ADD CONSTRAINT "city_positions_market_id_city_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."city_markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "city_positions" ADD CONSTRAINT "city_positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "city_markets_bell" ON "city_markets" USING btree ("bell_day","status");--> statement-breakpoint
CREATE UNIQUE INDEX "city_positions_one" ON "city_positions" USING btree ("market_id","user_id");--> statement-breakpoint
CREATE INDEX "city_positions_user" ON "city_positions" USING btree ("user_id");