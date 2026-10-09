-- System accounts are created here, not only by the test setup: before this,
-- a fresh database had none, and the first mint would have failed.
-- sys:mint and sys:burn become 16 shards each (shard 0 keeps the old id).
INSERT INTO gm_accounts (id, kind, allow_negative) VALUES
  ('sys:mint', 'system', true),
  ('sys:mint:1', 'system', true),
  ('sys:mint:2', 'system', true),
  ('sys:mint:3', 'system', true),
  ('sys:mint:4', 'system', true),
  ('sys:mint:5', 'system', true),
  ('sys:mint:6', 'system', true),
  ('sys:mint:7', 'system', true),
  ('sys:mint:8', 'system', true),
  ('sys:mint:9', 'system', true),
  ('sys:mint:10', 'system', true),
  ('sys:mint:11', 'system', true),
  ('sys:mint:12', 'system', true),
  ('sys:mint:13', 'system', true),
  ('sys:mint:14', 'system', true),
  ('sys:mint:15', 'system', true),
  ('sys:burn', 'system', false),
  ('sys:burn:1', 'system', false),
  ('sys:burn:2', 'system', false),
  ('sys:burn:3', 'system', false),
  ('sys:burn:4', 'system', false),
  ('sys:burn:5', 'system', false),
  ('sys:burn:6', 'system', false),
  ('sys:burn:7', 'system', false),
  ('sys:burn:8', 'system', false),
  ('sys:burn:9', 'system', false),
  ('sys:burn:10', 'system', false),
  ('sys:burn:11', 'system', false),
  ('sys:burn:12', 'system', false),
  ('sys:burn:13', 'system', false),
  ('sys:burn:14', 'system', false),
  ('sys:burn:15', 'system', false),
  ('sys:city_purse', 'system', false)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

-- A purchase must point at a real burn of exactly its price from its owner,
-- into any burn shard.
CREATE OR REPLACE FUNCTION items_purchase_paid() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  paid bigint;
  payer text;
BEGIN
  IF NEW.source <> 'purchase' THEN RETURN NULL; END IF;
  payer := CASE WHEN NEW.owner_user_id IS NOT NULL THEN 'user:' || NEW.owner_user_id ELSE 'escrow:crew:' || NEW.owner_crew_id END;
  SELECT -amount INTO paid FROM gm_entries WHERE tx_id = NEW.tx_id AND account_id = payer;
  IF paid IS NULL OR paid <> NEW.price_paid OR NOT EXISTS (
       SELECT 1 FROM gm_entries WHERE tx_id = NEW.tx_id AND account_id ~ '^sys:burn(:([1-9]|1[0-5]))?$' AND amount = NEW.price_paid) THEN
    RAISE EXCEPTION 'item % is not backed by a burn of its price', NEW.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
