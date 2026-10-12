-- Window reports (the reel's burn, the Drip Committee minutes) read the
-- system accounts' entries for one window. With only (account_id, id) they
-- scanned every entry those accounts ever had. Measured on 3M entries: a
-- day's burn went from about 125 ms to 3 ms. Building it blocks ledger writes
-- for as long as it takes (about 6 s for 3M entries), so run it off-peak on a
-- big ledger.
CREATE INDEX "gm_entries_account_time_idx" ON "gm_entries" USING btree ("account_id","created_at");