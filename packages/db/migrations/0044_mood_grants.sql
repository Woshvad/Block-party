-- Grants that happen once per resident per occasion: the bell's CALLED IT,
-- REKT (with its free Copium) and grid tilt, keyed by bell day. A bell step
-- that runs again after a crash finds its row and grants nothing more.
CREATE TABLE "mood_grants" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mood_grants_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
ALTER TABLE "mood_grants" ADD CONSTRAINT "mood_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;