-- One resident's Grudge Matches, either side. Rent and the drip count a
-- resident's open Grudge stakes (openGmStakes), which runs with every day's
-- first gm; without these it read the whole table each time. Duels already
-- have the same pair of indexes.
CREATE INDEX "grudge_newcomer" ON "grudge_matches" USING btree ("newcomer_id","status");--> statement-breakpoint
CREATE INDEX "grudge_inviter" ON "grudge_matches" USING btree ("inviter_id","status");