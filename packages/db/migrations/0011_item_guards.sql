-- Items are granted, never transferred or destroyed: no resale, no gifting.
CREATE FUNCTION items_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.piece_id <> OLD.piece_id
     OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
     OR NEW.owner_crew_id IS DISTINCT FROM OLD.owner_crew_id
     OR NEW.source <> OLD.source
     OR NEW.price_paid IS DISTINCT FROM OLD.price_paid
     OR NEW.tx_id IS DISTINCT FROM OLD.tx_id THEN
    RAISE EXCEPTION 'items are never transferred or changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER items_fixed BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION items_fixed();
--> statement-breakpoint
CREATE TRIGGER items_no_delete BEFORE DELETE ON items FOR EACH ROW EXECUTE FUNCTION gm_append_only();
--> statement-breakpoint
CREATE TRIGGER items_no_truncate BEFORE TRUNCATE ON items FOR EACH STATEMENT EXECUTE FUNCTION gm_append_only();
--> statement-breakpoint

-- A purchase must point at a real burn of exactly its price from its owner.
CREATE FUNCTION items_purchase_paid() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  paid bigint;
  payer text;
BEGIN
  IF NEW.source <> 'purchase' THEN RETURN NULL; END IF;
  payer := CASE WHEN NEW.owner_user_id IS NOT NULL THEN 'user:' || NEW.owner_user_id ELSE 'escrow:crew:' || NEW.owner_crew_id END;
  SELECT -amount INTO paid FROM gm_entries WHERE tx_id = NEW.tx_id AND account_id = payer;
  IF paid IS NULL OR paid <> NEW.price_paid OR NOT EXISTS (
       SELECT 1 FROM gm_entries WHERE tx_id = NEW.tx_id AND account_id = 'sys:burn' AND amount = NEW.price_paid) THEN
    RAISE EXCEPTION 'item % is not backed by a burn of its price', NEW.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER items_purchase_paid AFTER INSERT ON items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION items_purchase_paid();
