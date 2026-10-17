CREATE TABLE "make_good_collections" (
	"make_good_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"tx_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "make_good_collections_make_good_id_user_id_pk" PRIMARY KEY("make_good_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "make_goods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reason" text NOT NULL,
	"amount" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "make_goods_amount" CHECK ("make_goods"."amount" BETWEEN 1 AND 200),
	CONSTRAINT "make_goods_reason" CHECK (char_length("make_goods"."reason") BETWEEN 1 AND 80)
);
--> statement-breakpoint
ALTER TABLE "make_good_collections" ADD CONSTRAINT "make_good_collections_make_good_id_make_goods_id_fk" FOREIGN KEY ("make_good_id") REFERENCES "public"."make_goods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "make_good_collections" ADD CONSTRAINT "make_good_collections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "make_good_collections" ADD CONSTRAINT "make_good_collections_tx_id_gm_transactions_id_fk" FOREIGN KEY ("tx_id") REFERENCES "public"."gm_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "make_goods" ADD CONSTRAINT "make_goods_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "make_goods_created" ON "make_goods" USING btree ("created_at");--> statement-breakpoint
-- custom (keep on regenerate)
-- A make-good is a record of GM the city gave away: who made it, when and for
-- how much never change, and it's never deleted. Only the reason can change,
-- when the AI check takes it down or staff put it back. Collections are
-- append-only, like the ledger they point at.
CREATE FUNCTION make_goods_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a make-good is fixed once made' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER make_goods_fixed BEFORE UPDATE ON make_goods
  FOR EACH ROW EXECUTE FUNCTION make_goods_fixed();
--> statement-breakpoint
CREATE TRIGGER make_goods_no_delete BEFORE DELETE ON make_goods
  FOR EACH ROW EXECUTE FUNCTION gm_append_only();
--> statement-breakpoint
CREATE TRIGGER make_good_collections_append_only BEFORE UPDATE OR DELETE ON make_good_collections
  FOR EACH ROW EXECUTE FUNCTION gm_append_only();
