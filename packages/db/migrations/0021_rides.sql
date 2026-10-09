CREATE TYPE "public"."ride_mode" AS ENUM('walk', 'rollup', 'priority');--> statement-breakpoint
CREATE TABLE "buses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to_area" text NOT NULL,
	"departs_at" timestamp with time zone NOT NULL,
	"riders" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "buses_seats" CHECK ("buses"."riders" BETWEEN 0 AND 8)
);
--> statement-breakpoint
CREATE TABLE "rides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"from_area" text NOT NULL,
	"to_area" text NOT NULL,
	"mode" "ride_mode" NOT NULL,
	"fare" integer NOT NULL,
	"tx_id" uuid,
	"bus_id" uuid,
	"departed_at" timestamp with time zone NOT NULL,
	"arrive_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rides_paid" CHECK (("rides"."fare" = 0) = ("rides"."tx_id" IS NULL)),
	CONSTRAINT "rides_bus" CHECK (("rides"."mode" = 'rollup') = ("rides"."bus_id" IS NOT NULL)),
	CONSTRAINT "rides_order" CHECK ("rides"."arrive_at" >= "rides"."departed_at")
);
--> statement-breakpoint
ALTER TABLE "rides" ADD CONSTRAINT "rides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rides" ADD CONSTRAINT "rides_tx_id_gm_transactions_id_fk" FOREIGN KEY ("tx_id") REFERENCES "public"."gm_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rides" ADD CONSTRAINT "rides_bus_id_buses_id_fk" FOREIGN KEY ("bus_id") REFERENCES "public"."buses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "buses_boarding" ON "buses" USING btree ("to_area","departs_at");--> statement-breakpoint
CREATE INDEX "rides_latest" ON "rides" USING btree ("user_id","departed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rides_idempotency" ON "rides" USING btree ("user_id","idempotency_key");