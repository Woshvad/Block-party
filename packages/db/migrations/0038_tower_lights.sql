CREATE TYPE "public"."light_bid_status" AS ENUM('open', 'won', 'refunded');--> statement-breakpoint
CREATE TABLE "light_bids" (
	"city_day" date NOT NULL,
	"crew_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"placed_by" uuid NOT NULL,
	"status" "light_bid_status" DEFAULT 'open' NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "light_bids_city_day_crew_id_pk" PRIMARY KEY("city_day","crew_id"),
	CONSTRAINT "light_bids_amount" CHECK ("light_bids"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "light_bids" ADD CONSTRAINT "light_bids_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "light_bids" ADD CONSTRAINT "light_bids_placed_by_users_id_fk" FOREIGN KEY ("placed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "light_bids_day" ON "light_bids" USING btree ("city_day","status");