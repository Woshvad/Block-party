CREATE TABLE "tower_moments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"bucket" integer NOT NULL,
	"from_price" integer,
	"to_price" integer,
	"outcome" boolean,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "tower_moments_once" UNIQUE("market_id","kind","bucket"),
	CONSTRAINT "tower_moments_kind" CHECK (("tower_moments"."kind" = 'swing' AND "tower_moments"."from_price" IS NOT NULL AND "tower_moments"."to_price" IS NOT NULL AND "tower_moments"."outcome" IS NULL) OR ("tower_moments"."kind" = 'settled' AND "tower_moments"."outcome" IS NOT NULL AND "tower_moments"."to_price" IS NULL AND "tower_moments"."bucket" = 0)),
	CONSTRAINT "tower_moments_prices" CHECK ("tower_moments"."from_price" BETWEEN 1 AND 99 AND "tower_moments"."to_price" BETWEEN 1 AND 99)
);
--> statement-breakpoint
ALTER TABLE "tower_moments" ADD CONSTRAINT "tower_moments_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tower_moments_at" ON "tower_moments" USING btree ("at");--> statement-breakpoint
CREATE INDEX "markets_resolved_at" ON "markets" USING btree ("resolved_at") WHERE "markets"."status" = 'resolved';