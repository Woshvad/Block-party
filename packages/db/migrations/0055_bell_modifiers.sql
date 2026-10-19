CREATE TABLE "contrarian_cards" (
	"city_day" date NOT NULL,
	"market_id" uuid NOT NULL,
	"yes" integer NOT NULL,
	"no" integer NOT NULL,
	"majority" "call_side",
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "contrarian_cards_city_day_market_id_pk" PRIMARY KEY("city_day","market_id"),
	CONSTRAINT "contrarian_cards_counts" CHECK ("contrarian_cards"."yes" >= 0 AND "contrarian_cards"."no" >= 0),
	CONSTRAINT "contrarian_cards_majority" CHECK ("contrarian_cards"."majority" IS NULL OR ("contrarian_cards"."majority" = 'yes' AND "contrarian_cards"."yes" > "contrarian_cards"."no") OR ("contrarian_cards"."majority" = 'no' AND "contrarian_cards"."no" > "contrarian_cards"."yes"))
);--> statement-breakpoint
CREATE TABLE "nothing_day_grids" (
	"city_day" date NOT NULL,
	"user_id" uuid NOT NULL,
	"aura_centi" integer NOT NULL,
	"bot_aura_centi" integer,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "nothing_day_grids_city_day_user_id_pk" PRIMARY KEY("city_day","user_id")
);--> statement-breakpoint
CREATE TABLE "nothing_day_wins" (
	"city_day" date NOT NULL,
	"user_id" uuid NOT NULL,
	"aura_centi" integer NOT NULL,
	"bot_aura_centi" integer NOT NULL,
	"tile" boolean NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "nothing_day_wins_city_day_user_id_pk" PRIMARY KEY("city_day","user_id"),
	CONSTRAINT "nothing_day_wins_beat" CHECK ("nothing_day_wins"."aura_centi" > "nothing_day_wins"."bot_aura_centi")
);--> statement-breakpoint
ALTER TABLE "contrarian_cards" ADD CONSTRAINT "contrarian_cards_slate_card_fk" FOREIGN KEY ("city_day","market_id") REFERENCES "public"."slate_cards"("city_day","market_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nothing_day_grids" ADD CONSTRAINT "nothing_day_grids_city_day_slates_city_day_fk" FOREIGN KEY ("city_day") REFERENCES "public"."slates"("city_day") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nothing_day_grids" ADD CONSTRAINT "nothing_day_grids_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nothing_day_wins" ADD CONSTRAINT "nothing_day_wins_city_day_slates_city_day_fk" FOREIGN KEY ("city_day") REFERENCES "public"."slates"("city_day") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nothing_day_wins" ADD CONSTRAINT "nothing_day_wins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nothing_day_wins_user" ON "nothing_day_wins" USING btree ("user_id");--> statement-breakpoint
-- custom (keep on regenerate)
-- What a modifier settled at the bell is final: no edits, no deletes.
CREATE FUNCTION modifier_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a Bell Modifier''s result never changes' USING ERRCODE = 'integrity_constraint_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER contrarian_cards_frozen BEFORE UPDATE OR DELETE ON contrarian_cards FOR EACH ROW EXECUTE FUNCTION modifier_frozen();--> statement-breakpoint
CREATE TRIGGER nothing_day_wins_frozen BEFORE UPDATE OR DELETE ON nothing_day_wins FOR EACH ROW EXECUTE FUNCTION modifier_frozen();--> statement-breakpoint
-- The cast never beats its own bot for a banner tile.
CREATE FUNCTION nothing_day_wins_no_cast() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM npcs WHERE user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'the cast never earns a banner tile' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER nothing_day_wins_no_cast BEFORE INSERT ON nothing_day_wins FOR EACH ROW EXECUTE FUNCTION nothing_day_wins_no_cast();--> statement-breakpoint
-- custom (keep on regenerate)
-- What NOTHING Day's bell judged is final too: no edits, no deletes.
CREATE TRIGGER nothing_day_grids_frozen BEFORE UPDATE OR DELETE ON nothing_day_grids FOR EACH ROW EXECUTE FUNCTION modifier_frozen();
