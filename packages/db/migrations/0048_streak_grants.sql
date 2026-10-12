-- Streak days a poll owes: noted in the poll's transaction for each resident
-- whose call it locked, and deleted by the transaction that grants the day,
-- so a grant that fails, or a run cut off after the poll commits, is made by
-- the next poll instead of lost.
CREATE TABLE "streak_grants" (
	"user_id" uuid NOT NULL,
	"city_day" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "streak_grants_user_id_city_day_pk" PRIMARY KEY("user_id","city_day")
);
--> statement-breakpoint
ALTER TABLE "streak_grants" ADD CONSTRAINT "streak_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;