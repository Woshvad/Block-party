CREATE TABLE "npcs" (
	"key" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"home" text NOT NULL,
	CONSTRAINT "npcs_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "npcs" ADD CONSTRAINT "npcs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO users (id, status, age_ack_at) VALUES
  ('00000000-0000-4000-8000-000000000901', 'guest', now()),
  ('00000000-0000-4000-8000-000000000902', 'guest', now()),
  ('00000000-0000-4000-8000-000000000903', 'guest', now()),
  ('00000000-0000-4000-8000-000000000904', 'guest', now())
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO npcs (key, user_id, name, home) VALUES
  ('nothing_9000', '00000000-0000-4000-8000-000000000901', 'NOTHING-9000', 'roof'),
  ('contrarian', '00000000-0000-4000-8000-000000000902', 'The Contrarian', 'tower'),
  ('faucet_fren', '00000000-0000-4000-8000-000000000903', 'Faucet Fren', 'faucet'),
  ('hash_brown', '00000000-0000-4000-8000-000000000904', 'Hash Brown', 'diner')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
-- The cast never earns, holds or loses GM: no ledger account may belong to them.
CREATE FUNCTION npcs_hold_no_gm() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS NOT NULL AND EXISTS (SELECT 1 FROM npcs WHERE user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'NPCs never hold GM' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER npcs_hold_no_gm BEFORE INSERT OR UPDATE ON gm_accounts FOR EACH ROW EXECUTE FUNCTION npcs_hold_no_gm();
