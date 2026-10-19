CREATE TABLE "nothing_day_grids" (
	"city_day" date NOT NULL,
	"user_id" uuid NOT NULL,
	"aura_centi" integer NOT NULL,
	"bot_aura_centi" integer,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "nothing_day_grids_city_day_user_id_pk" PRIMARY KEY("city_day","user_id")
);
--> statement-breakpoint
ALTER TABLE "nothing_day_grids" ADD CONSTRAINT "nothing_day_grids_city_day_slates_city_day_fk" FOREIGN KEY ("city_day") REFERENCES "public"."slates"("city_day") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nothing_day_grids" ADD CONSTRAINT "nothing_day_grids_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- custom (keep on regenerate)
-- What NOTHING Day's bell judged is final too: no edits, no deletes.
CREATE TRIGGER nothing_day_grids_frozen BEFORE UPDATE OR DELETE ON nothing_day_grids FOR EACH ROW EXECUTE FUNCTION modifier_frozen();
