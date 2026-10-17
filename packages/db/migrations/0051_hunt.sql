CREATE TABLE "hunt_days" (
	"day" date PRIMARY KEY NOT NULL,
	"place" text NOT NULL,
	"clue_index" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hunt_days_clue_index" CHECK ("hunt_days"."clue_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "hunt_searches" (
	"day" date NOT NULL,
	"user_id" uuid NOT NULL,
	"place" text NOT NULL,
	"found" boolean NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "hunt_searches_day_user_id_pk" PRIMARY KEY("day","user_id")
);
--> statement-breakpoint
ALTER TABLE "hunt_searches" ADD CONSTRAINT "hunt_searches_day_hunt_days_day_fk" FOREIGN KEY ("day") REFERENCES "public"."hunt_days"("day") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hunt_searches" ADD CONSTRAINT "hunt_searches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hunt_searches_finds" ON "hunt_searches" USING btree ("user_id") WHERE "hunt_searches"."found";
-- custom (keep on regenerate)
--> statement-breakpoint
-- A day's hiding place and every search are final: no edits, no deletes.
CREATE FUNCTION hunt_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the clue hunt''s record never changes' USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER hunt_days_frozen BEFORE UPDATE OR DELETE ON hunt_days FOR EACH ROW EXECUTE FUNCTION hunt_frozen();
--> statement-breakpoint
CREATE TRIGGER hunt_searches_frozen BEFORE UPDATE OR DELETE ON hunt_searches FOR EACH ROW EXECUTE FUNCTION hunt_frozen();
