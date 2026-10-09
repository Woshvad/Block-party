CREATE TABLE "reality_checks" (
	"user_id" uuid NOT NULL,
	"session_started_at" timestamp with time zone NOT NULL,
	"hour" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "reality_checks_user_id_session_started_at_hour_pk" PRIMARY KEY("user_id","session_started_at","hour")
);
--> statement-breakpoint
ALTER TABLE "reality_checks" ADD CONSTRAINT "reality_checks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;