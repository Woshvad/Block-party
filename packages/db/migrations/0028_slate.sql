CREATE TABLE "slate_cards" (
	"city_day" date NOT NULL,
	"slot" integer NOT NULL,
	"tier" text NOT NULL,
	"market_id" uuid NOT NULL,
	CONSTRAINT "slate_cards_city_day_slot_pk" PRIMARY KEY("city_day","slot"),
	CONSTRAINT "slate_cards_market_once" UNIQUE("city_day","market_id"),
	CONSTRAINT "slate_cards_slot" CHECK ("slate_cards"."slot" BETWEEN 0 AND 5)
);
--> statement-breakpoint
CREATE TABLE "slates" (
	"city_day" date PRIMARY KEY NOT NULL,
	"modifier" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slate_cards" ADD CONSTRAINT "slate_cards_city_day_slates_city_day_fk" FOREIGN KEY ("city_day") REFERENCES "public"."slates"("city_day") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slate_cards" ADD CONSTRAINT "slate_cards_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slate_cards_market" ON "slate_cards" USING btree ("market_id");--> statement-breakpoint

-- A published Slate is the same for everyone, all day: no edits, no deletes.
CREATE FUNCTION slate_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a published Slate never changes' USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER slates_frozen BEFORE UPDATE OR DELETE ON slates FOR EACH ROW EXECUTE FUNCTION slate_frozen();
--> statement-breakpoint
CREATE TRIGGER slate_cards_frozen BEFORE UPDATE OR DELETE ON slate_cards FOR EACH ROW EXECUTE FUNCTION slate_frozen();
