CREATE TYPE "public"."gm_account_kind" AS ENUM('user', 'system', 'escrow');--> statement-breakpoint
CREATE TABLE "gm_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "gm_account_kind" NOT NULL,
	"user_id" uuid,
	"allow_negative" boolean DEFAULT false NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gm_accounts_balance_floor" CHECK ("gm_accounts"."allow_negative" OR "gm_accounts"."balance" >= 0),
	CONSTRAINT "gm_accounts_user_kind" CHECK (("gm_accounts"."kind" = 'user') = ("gm_accounts"."user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "gm_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tx_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gm_entries_nonzero" CHECK ("gm_entries"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "gm_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" text NOT NULL,
	"payload_hash" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gm_transactions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gm_accounts" ADD CONSTRAINT "gm_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gm_entries" ADD CONSTRAINT "gm_entries_tx_id_gm_transactions_id_fk" FOREIGN KEY ("tx_id") REFERENCES "public"."gm_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gm_entries" ADD CONSTRAINT "gm_entries_account_id_gm_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."gm_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gm_accounts_user_idx" ON "gm_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "gm_entries_tx_idx" ON "gm_entries" USING btree ("tx_id");--> statement-breakpoint
CREATE INDEX "gm_entries_account_idx" ON "gm_entries" USING btree ("account_id","id");