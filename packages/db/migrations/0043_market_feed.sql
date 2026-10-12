-- Which markets the latest good poll carried: one the feed has dropped keeps
-- a stale price, so it leaves the Floor and takes no calls. Existing rows start
-- off the feed; the next poll (a minute) puts the live ones back.
-- The index serves each poll's read of its source's markets not yet final.
ALTER TABLE "markets" ADD COLUMN "in_feed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "markets_unsettled" ON "markets" USING btree ("source","freezes_at") WHERE "markets"."status" IN ('open', 'frozen');