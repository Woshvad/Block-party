-- Ledger guards: the database refuses a bad ledger even if app code is wrong.

-- 1. The ledger is append-only.
CREATE FUNCTION gm_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'gm ledger is append-only: % on % refused', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER gm_entries_append_only BEFORE UPDATE OR DELETE ON gm_entries
  FOR EACH ROW EXECUTE FUNCTION gm_append_only();
--> statement-breakpoint
CREATE TRIGGER gm_entries_no_truncate BEFORE TRUNCATE ON gm_entries
  FOR EACH STATEMENT EXECUTE FUNCTION gm_append_only();
--> statement-breakpoint
CREATE TRIGGER gm_transactions_append_only BEFORE UPDATE OR DELETE ON gm_transactions
  FOR EACH ROW EXECUTE FUNCTION gm_append_only();
--> statement-breakpoint
CREATE TRIGGER gm_transactions_no_truncate BEFORE TRUNCATE ON gm_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION gm_append_only();
--> statement-breakpoint

-- 2. At commit, every entry must balance its transaction and chain from the
--    account's previous entry, and the cached balance must match the chain.
CREATE FUNCTION gm_check_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tx_sum bigint;
  prev_after bigint;
  latest_after bigint;
  cached bigint;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO tx_sum FROM gm_entries WHERE tx_id = NEW.tx_id;
  IF tx_sum <> 0 THEN
    RAISE EXCEPTION 'gm tx % does not balance (sum %)', NEW.tx_id, tx_sum
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT balance_after INTO prev_after FROM gm_entries
    WHERE account_id = NEW.account_id AND id < NEW.id
    ORDER BY id DESC LIMIT 1;
  IF NEW.balance_after <> COALESCE(prev_after, 0) + NEW.amount THEN
    RAISE EXCEPTION 'gm entry % breaks the balance chain for %', NEW.id, NEW.account_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT balance_after INTO latest_after FROM gm_entries
    WHERE account_id = NEW.account_id ORDER BY id DESC LIMIT 1;
  SELECT balance INTO cached FROM gm_accounts WHERE id = NEW.account_id;
  IF cached <> latest_after THEN
    RAISE EXCEPTION 'gm account % balance % does not match ledger %', NEW.account_id, cached, latest_after
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER gm_entries_check AFTER INSERT ON gm_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gm_check_entry();
--> statement-breakpoint

-- 3. A balance can only change alongside ledger entries.
CREATE FUNCTION gm_check_account_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest_after bigint;
BEGIN
  SELECT balance_after INTO latest_after FROM gm_entries
    WHERE account_id = NEW.id ORDER BY id DESC LIMIT 1;
  IF NEW.balance <> COALESCE(latest_after, 0) THEN
    RAISE EXCEPTION 'gm account % balance % set outside the ledger (ledger says %)',
      NEW.id, NEW.balance, COALESCE(latest_after, 0)
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER gm_accounts_balance_check AFTER INSERT OR UPDATE OF balance ON gm_accounts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gm_check_account_balance();
