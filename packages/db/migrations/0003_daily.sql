CREATE TYPE "public"."streak_day_kind" AS ENUM('played', 'hodl');--> statement-breakpoint
CREATE TABLE "badges" (
	"user_id" uuid NOT NULL,
	"badge" text NOT NULL,
	"earned_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "badges_user_id_badge_pk" PRIMARY KEY("user_id","badge")
);
--> statement-breakpoint
CREATE TABLE "daily_gm" (
	"user_id" uuid NOT NULL,
	"city_day" date NOT NULL,
	"drip" integer NOT NULL,
	"broke_floor" boolean NOT NULL,
	"net_worth" bigint NOT NULL,
	"tx_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_gm_user_id_city_day_pk" PRIMARY KEY("user_id","city_day"),
	CONSTRAINT "daily_gm_drip_positive" CHECK ("daily_gm"."drip" > 0)
);
--> statement-breakpoint
CREATE TABLE "streak_days" (
	"user_id" uuid NOT NULL,
	"city_day" date NOT NULL,
	"kind" "streak_day_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "streak_days_user_id_city_day_pk" PRIMARY KEY("user_id","city_day")
);
--> statement-breakpoint
CREATE TABLE "streaks" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"current" integer DEFAULT 0 NOT NULL,
	"longest" integer DEFAULT 0 NOT NULL,
	"last_day" date,
	"hodl_days" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "streaks_hodl_range" CHECK ("streaks"."hodl_days" BETWEEN 0 AND 2),
	CONSTRAINT "streaks_current_range" CHECK ("streaks"."current" >= 0 AND "streaks"."longest" >= "streaks"."current"),
	CONSTRAINT "streaks_last_day_set" CHECK (("streaks"."current" = 0) = ("streaks"."last_day" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "badges" ADD CONSTRAINT "badges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_gm" ADD CONSTRAINT "daily_gm_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_gm" ADD CONSTRAINT "daily_gm_tx_id_gm_transactions_id_fk" FOREIGN KEY ("tx_id") REFERENCES "public"."gm_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "streak_days" ADD CONSTRAINT "streak_days_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "streaks" ADD CONSTRAINT "streaks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;