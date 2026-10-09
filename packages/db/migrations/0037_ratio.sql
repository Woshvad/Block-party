CREATE TABLE "ratio_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city_day" date NOT NULL,
	"user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ratio_entries_text" CHECK (char_length("ratio_entries"."text") BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE TABLE "ratio_prompts" (
	"city_day" date PRIMARY KEY NOT NULL,
	"market_id" uuid NOT NULL,
	"world" integer NOT NULL,
	"city" integer NOT NULL,
	"winner_entry_id" uuid,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ratio_votes" (
	"city_day" date NOT NULL,
	"voter_id" uuid NOT NULL,
	"low" uuid NOT NULL,
	"high" uuid NOT NULL,
	"winner" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "ratio_votes_city_day_voter_id_low_high_pk" PRIMARY KEY("city_day","voter_id","low","high"),
	CONSTRAINT "ratio_votes_pair" CHECK ("ratio_votes"."low" < "ratio_votes"."high" AND "ratio_votes"."winner" IN ("ratio_votes"."low", "ratio_votes"."high"))
);
--> statement-breakpoint
ALTER TABLE "ratio_entries" ADD CONSTRAINT "ratio_entries_city_day_ratio_prompts_city_day_fk" FOREIGN KEY ("city_day") REFERENCES "public"."ratio_prompts"("city_day") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratio_entries" ADD CONSTRAINT "ratio_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratio_prompts" ADD CONSTRAINT "ratio_prompts_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratio_votes" ADD CONSTRAINT "ratio_votes_voter_id_users_id_fk" FOREIGN KEY ("voter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratio_votes" ADD CONSTRAINT "ratio_votes_low_ratio_entries_id_fk" FOREIGN KEY ("low") REFERENCES "public"."ratio_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratio_votes" ADD CONSTRAINT "ratio_votes_high_ratio_entries_id_fk" FOREIGN KEY ("high") REFERENCES "public"."ratio_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ratio_entries_one" ON "ratio_entries" USING btree ("city_day","user_id");