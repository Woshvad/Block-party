-- The session sweep (every 10 minutes) looks for sessions that expired, or
-- were signed out, over a week ago. With only the user_id index it read the
-- whole table each run. Building these blocks sign-ins for as long as it
-- takes; on a big sessions table, build them first without blocking:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_expires_idx" ON "sessions" USING btree ("expires_at");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_revoked_idx" ON "sessions" USING btree ("revoked_at") WHERE "sessions"."revoked_at" IS NOT NULL;
-- and this step finds them there.
CREATE INDEX IF NOT EXISTS "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_revoked_idx" ON "sessions" USING btree ("revoked_at") WHERE "sessions"."revoked_at" IS NOT NULL;
