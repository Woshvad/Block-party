CREATE TABLE "country_switches" (
	"country" text PRIMARY KEY NOT NULL,
	"real_trades" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "real_breaks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"return_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "real_limit_raises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"cents" integer NOT NULL,
	"confirmable_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "real_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"birth_year" integer NOT NULL,
	"declared_at" timestamp with time zone NOT NULL,
	"weekly_cents" integer NOT NULL,
	"monthly_cents" integer NOT NULL,
	"loss_cents" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "real_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"market_id" uuid NOT NULL,
	"side" "call_side" NOT NULL,
	"amount_cents" integer NOT NULL,
	"polymarket_fee_cents" integer NOT NULL,
	"builder_fee_cents" integer NOT NULL,
	"status" text DEFAULT 'intent' NOT NULL,
	"fill_price_pct" integer,
	"pnl_cents" integer,
	"created_at" timestamp with time zone NOT NULL,
	"filled_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "real_trades_amount" CHECK ("real_trades"."amount_cents" BETWEEN 1 AND 10000)
);
--> statement-breakpoint
ALTER TABLE "country_switches" ADD CONSTRAINT "country_switches_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "real_breaks" ADD CONSTRAINT "real_breaks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "real_limit_raises" ADD CONSTRAINT "real_limit_raises_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "real_profiles" ADD CONSTRAINT "real_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "real_trades" ADD CONSTRAINT "real_trades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "real_trades" ADD CONSTRAINT "real_trades_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "real_breaks_user" ON "real_breaks" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "real_trades_user" ON "real_trades" USING btree ("user_id","created_at");--> statement-breakpoint

-- A time-out or self-exclusion is never deleted, shortened or lifted early.
CREATE FUNCTION real_breaks_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a break is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.kind <> OLD.kind OR NEW.started_at <> OLD.started_at
     OR (OLD.ends_at IS NULL AND NEW.ends_at IS NOT NULL)
     OR (OLD.ends_at IS NOT NULL AND NEW.ends_at IS NOT NULL AND NEW.ends_at < OLD.ends_at)
     OR (OLD.return_at IS NOT NULL AND NEW.return_at IS DISTINCT FROM OLD.return_at) THEN
    RAISE EXCEPTION 'a break is never shortened or lifted early' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER real_breaks_hold BEFORE UPDATE OR DELETE ON real_breaks FOR EACH ROW EXECUTE FUNCTION real_breaks_hold();
