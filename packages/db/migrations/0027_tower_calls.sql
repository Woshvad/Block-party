CREATE TYPE "public"."call_side" AS ENUM('yes', 'no');--> statement-breakpoint
CREATE TYPE "public"."call_status" AS ENUM('pending', 'locked', 'price_moved', 'expired');--> statement-breakpoint
CREATE TYPE "public"."market_category" AS ENUM('crypto', 'sports', 'politics', 'culture', 'other');--> statement-breakpoint
CREATE TYPE "public"."market_status" AS ENUM('open', 'frozen', 'resolved', 'void');--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"market_id" uuid NOT NULL,
	"side" "call_side" NOT NULL,
	"chance" integer NOT NULL,
	"seen_price" integer NOT NULL,
	"status" "call_status" DEFAULT 'pending' NOT NULL,
	"tick_id" bigint,
	"locked_price" integer,
	"locked_at" timestamp with time zone,
	"on_slate" boolean DEFAULT false NOT NULL,
	"half" boolean DEFAULT false NOT NULL,
	"ticket" boolean DEFAULT false NOT NULL,
	"via" text,
	"via_user_id" uuid,
	"aura_centi" integer,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "calls_chance" CHECK ("calls"."chance" BETWEEN 1 AND 99 AND "calls"."seen_price" BETWEEN 1 AND 99),
	CONSTRAINT "calls_locked" CHECK (("calls"."status" = 'locked') = ("calls"."locked_price" IS NOT NULL AND "calls"."tick_id" IS NOT NULL AND "calls"."locked_at" IS NOT NULL)),
	CONSTRAINT "calls_via" CHECK (("calls"."via" IS NULL) = ("calls"."via_user_id" IS NULL) AND ("calls"."via" IS NULL OR "calls"."via" IN ('tail', 'fade'))),
	CONSTRAINT "calls_side" CHECK (("calls"."side" = 'yes' AND "calls"."chance" > "calls"."seen_price") OR ("calls"."side" = 'no' AND "calls"."chance" < "calls"."seen_price"))
);
--> statement-breakpoint
CREATE TABLE "feed_polls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"ok" boolean NOT NULL,
	"markets" integer DEFAULT 0 NOT NULL,
	"error" text,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_ticks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"market_id" uuid NOT NULL,
	"price" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "market_ticks_price" CHECK ("market_ticks"."price" BETWEEN 1 AND 99)
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"question" text NOT NULL,
	"category" "market_category" NOT NULL,
	"ladder" text,
	"info_only" boolean DEFAULT false NOT NULL,
	"freezes_at" timestamp with time zone NOT NULL,
	"settles_by" timestamp with time zone NOT NULL,
	"status" "market_status" DEFAULT 'open' NOT NULL,
	"outcome" boolean,
	"price" integer NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "markets_source_external" UNIQUE("source","external_id"),
	CONSTRAINT "markets_price" CHECK ("markets"."price" BETWEEN 1 AND 99),
	CONSTRAINT "markets_resolved" CHECK (("markets"."status" = 'resolved') = ("markets"."outcome" IS NOT NULL)),
	CONSTRAINT "markets_order" CHECK ("markets"."settles_by" >= "markets"."freezes_at")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"balance" integer NOT NULL,
	"as_of" date NOT NULL,
	CONSTRAINT "tickets_range" CHECK ("tickets"."balance" BETWEEN 0 AND 9)
);
--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_tick_id_market_ticks_id_fk" FOREIGN KEY ("tick_id") REFERENCES "public"."market_ticks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_via_user_id_users_id_fk" FOREIGN KEY ("via_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_ticks" ADD CONSTRAINT "market_ticks_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calls_one_per_market" ON "calls" USING btree ("user_id","market_id") WHERE "calls"."status" IN ('pending', 'locked');--> statement-breakpoint
CREATE INDEX "calls_pending" ON "calls" USING btree ("market_id") WHERE "calls"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "calls_market" ON "calls" USING btree ("market_id","status");--> statement-breakpoint
CREATE INDEX "market_ticks_market" ON "market_ticks" USING btree ("market_id","at");--> statement-breakpoint

-- No edits: a pending call can lock, move or expire once; a locked call only
-- ever gains its Aura, once. Nothing is ever deleted.
CREATE FUNCTION calls_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tick_price integer;
  tick_market uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'calls are never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.market_id <> OLD.market_id OR NEW.side <> OLD.side OR NEW.chance <> OLD.chance
     OR NEW.seen_price <> OLD.seen_price OR NEW.created_at <> OLD.created_at OR NEW.via IS DISTINCT FROM OLD.via
     OR NEW.via_user_id IS DISTINCT FROM OLD.via_user_id OR NEW.on_slate <> OLD.on_slate OR NEW.ticket <> OLD.ticket THEN
    RAISE EXCEPTION 'a call is never edited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('price_moved', 'expired') THEN
    RAISE EXCEPTION 'a dropped call stays dropped' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'locked' THEN
    IF NEW.status <> 'locked' OR NEW.tick_id <> OLD.tick_id OR NEW.locked_price <> OLD.locked_price
       OR NEW.locked_at <> OLD.locked_at OR NEW.half <> OLD.half
       OR (OLD.aura_centi IS NOT NULL AND NEW.aura_centi IS DISTINCT FROM OLD.aura_centi) THEN
      RAISE EXCEPTION 'a locked call only gains its Aura, once' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- pending -> something
  IF NEW.aura_centi IS NOT NULL THEN
    RAISE EXCEPTION 'only a locked call has Aura' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'locked' THEN
    SELECT price, market_id INTO tick_price, tick_market FROM market_ticks WHERE id = NEW.tick_id;
    IF tick_market IS DISTINCT FROM NEW.market_id OR tick_price IS DISTINCT FROM NEW.locked_price THEN
      RAISE EXCEPTION 'a call locks at a real tick of its own market' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER calls_guard BEFORE UPDATE OR DELETE ON calls FOR EACH ROW EXECUTE FUNCTION calls_guard();
--> statement-breakpoint

-- A new call starts pending with no Aura; ticks are append-only.
CREATE FUNCTION calls_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'pending' OR NEW.aura_centi IS NOT NULL THEN
    RAISE EXCEPTION 'a call starts pending' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER calls_insert_guard BEFORE INSERT ON calls FOR EACH ROW EXECUTE FUNCTION calls_insert_guard();
--> statement-breakpoint
CREATE FUNCTION ticks_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ticks are never changed' USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER ticks_append_only BEFORE UPDATE OR DELETE ON market_ticks FOR EACH ROW EXECUTE FUNCTION ticks_append_only();
--> statement-breakpoint

-- Once a market resolves or is voided, that's final: Aura was scored on it.
CREATE FUNCTION markets_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'markets are never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('resolved', 'void') AND (NEW.status <> OLD.status OR NEW.outcome IS DISTINCT FROM OLD.outcome) THEN
    RAISE EXCEPTION 'market % is already final', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER markets_final BEFORE UPDATE OR DELETE ON markets FOR EACH ROW EXECUTE FUNCTION markets_final();
