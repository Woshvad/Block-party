ALTER TABLE "calls" ADD COLUMN "in_play" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "in_play" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "live_price" integer;--> statement-breakpoint
CREATE INDEX "markets_playing" ON "markets" USING btree ("freezes_at") WHERE "markets"."in_play";--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_in_play" CHECK (NOT "calls"."in_play" OR (NOT "calls"."on_slate" AND "calls"."via" IS NULL AND ("calls"."status" <> 'locked' OR "calls"."half")));--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_in_play" CHECK ("markets"."in_play" = ("markets"."live_price" IS NOT NULL) AND (NOT "markets"."in_play" OR ("markets"."status" = 'frozen' AND "markets"."category" = 'sports' AND "markets"."live_price" BETWEEN 1 AND 99)));--> statement-breakpoint
-- custom (keep on regenerate)
-- calls_guard as in 0027, and: whether a call is in play is never edited, and
-- an in-play call locks only on a tick at least 2 minutes after it was made
-- (TOWER.inPlayDelaySeconds), so nobody watching the match can beat the feed.
CREATE OR REPLACE FUNCTION calls_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tick_price integer;
  tick_market uuid;
  tick_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'calls are never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.market_id <> OLD.market_id OR NEW.side <> OLD.side OR NEW.chance <> OLD.chance
     OR NEW.seen_price <> OLD.seen_price OR NEW.created_at <> OLD.created_at OR NEW.via IS DISTINCT FROM OLD.via
     OR NEW.via_user_id IS DISTINCT FROM OLD.via_user_id OR NEW.on_slate <> OLD.on_slate OR NEW.ticket <> OLD.ticket
     OR NEW.in_play <> OLD.in_play THEN
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
    SELECT price, market_id, at INTO tick_price, tick_market, tick_at FROM market_ticks WHERE id = NEW.tick_id;
    IF tick_market IS DISTINCT FROM NEW.market_id OR tick_price IS DISTINCT FROM NEW.locked_price THEN
      RAISE EXCEPTION 'a call locks at a real tick of its own market' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.in_play AND tick_at < NEW.created_at + interval '120 seconds' THEN
      RAISE EXCEPTION 'an in-play call locks 2 minutes after it was made, at the earliest' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
