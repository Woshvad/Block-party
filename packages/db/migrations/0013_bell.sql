CREATE TABLE "bell_steps" (
	"bell_day" date NOT NULL,
	"step" text NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"done_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bell_steps_bell_day_step_pk" PRIMARY KEY("bell_day","step")
);
--> statement-breakpoint
CREATE TABLE "halvings" (
	"season" integer NOT NULL,
	"account_id" text NOT NULL,
	"balance_before" bigint NOT NULL,
	"burned" bigint NOT NULL,
	"tx_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "halvings_season_account_id_pk" PRIMARY KEY("season","account_id"),
	CONSTRAINT "halvings_math" CHECK ("halvings"."balance_before" > 2000 AND "halvings"."burned" = ("halvings"."balance_before" - 2000) / 2 AND "halvings"."burned" > 0)
);
--> statement-breakpoint
ALTER TABLE "halvings" ADD CONSTRAINT "halvings_account_id_gm_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."gm_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "halvings" ADD CONSTRAINT "halvings_tx_id_gm_transactions_id_fk" FOREIGN KEY ("tx_id") REFERENCES "public"."gm_transactions"("id") ON DELETE no action ON UPDATE no action;