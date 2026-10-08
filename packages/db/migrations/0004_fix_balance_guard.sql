-- Fix for 0001: a deferred trigger's NEW is the row as it was when the event
-- fired, not at commit. Opening and funding an account in one transaction,
-- or posting to one account twice in one transaction (the bell job), was
-- wrongly refused. Compare the row as it stands at commit instead.
CREATE OR REPLACE FUNCTION gm_check_account_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest_after bigint;
  cached bigint;
BEGIN
  SELECT balance INTO cached FROM gm_accounts WHERE id = NEW.id;
  SELECT balance_after INTO latest_after FROM gm_entries
    WHERE account_id = NEW.id ORDER BY id DESC LIMIT 1;
  IF cached <> COALESCE(latest_after, 0) THEN
    RAISE EXCEPTION 'gm account % balance % set outside the ledger (ledger says %)',
      NEW.id, cached, COALESCE(latest_after, 0)
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
