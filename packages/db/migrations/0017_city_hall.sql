CREATE TYPE "public"."election_status" AS ENUM('open', 'finalized');--> statement-breakpoint
CREATE TABLE "candidates" (
	"week" date NOT NULL,
	"user_id" uuid NOT NULL,
	"pitch" text NOT NULL,
	"declared_at" timestamp with time zone NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"votes" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "candidates_week_user_id_pk" PRIMARY KEY("week","user_id"),
	CONSTRAINT "candidates_votes" CHECK ("candidates"."votes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "election_voters" (
	"week" date NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "election_voters_week_user_id_pk" PRIMARY KEY("week","user_id")
);
--> statement-breakpoint
CREATE TABLE "elections" (
	"week" date PRIMARY KEY NOT NULL,
	"status" "election_status" DEFAULT 'open' NOT NULL,
	"winner_user_id" uuid,
	"turnout" integer,
	"finalized_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mayor_terms" (
	"week" date PRIMARY KEY NOT NULL,
	"mayor_user_id" uuid NOT NULL,
	"law_id" text,
	"law_chosen_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_week_elections_week_fk" FOREIGN KEY ("week") REFERENCES "public"."elections"("week") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_voters" ADD CONSTRAINT "election_voters_week_elections_week_fk" FOREIGN KEY ("week") REFERENCES "public"."elections"("week") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_voters" ADD CONSTRAINT "election_voters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elections" ADD CONSTRAINT "elections_winner_user_id_users_id_fk" FOREIGN KEY ("winner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mayor_terms" ADD CONSTRAINT "mayor_terms_mayor_user_id_users_id_fk" FOREIGN KEY ("mayor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;