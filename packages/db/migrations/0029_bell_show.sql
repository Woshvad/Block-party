CREATE TABLE "bell_stamps" (
	"user_id" uuid NOT NULL,
	"city_day" date NOT NULL,
	"gm" integer NOT NULL,
	"tx_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bell_stamps_user_id_city_day_pk" PRIMARY KEY("user_id","city_day")
);
--> statement-breakpoint
CREATE TABLE "crew_bell_scores" (
	"bell_day" date NOT NULL,
	"crew_id" uuid NOT NULL,
	"chips" integer NOT NULL,
	"long_shots" integer NOT NULL,
	"chain_days" integer NOT NULL,
	"score_milli" integer NOT NULL,
	CONSTRAINT "crew_bell_scores_bell_day_crew_id_pk" PRIMARY KEY("bell_day","crew_id")
);
--> statement-breakpoint
ALTER TABLE "bell_stamps" ADD CONSTRAINT "bell_stamps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bell_stamps" ADD CONSTRAINT "bell_stamps_tx_id_gm_transactions_id_fk" FOREIGN KEY ("tx_id") REFERENCES "public"."gm_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_bell_scores" ADD CONSTRAINT "crew_bell_scores_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crew_bell_scores_rank" ON "crew_bell_scores" USING btree ("bell_day","score_milli");