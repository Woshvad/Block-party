CREATE TYPE "public"."resident_backstory" AS ENUM('airdrop_baby', 'exit_liquidity', 'og_kid', 'bear_market_survivor');--> statement-breakpoint
CREATE TYPE "public"."resident_goal" AS ENUM('oracle', 'crew_captain', 'mayor', 'homebody');--> statement-breakpoint
CREATE TYPE "public"."kit_style" AS ENUM('neon', 'cozy', 'minimal');--> statement-breakpoint
CREATE TABLE "residents" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"name" text NOT NULL,
	"look" jsonb NOT NULL,
	"traits" text[] NOT NULL,
	"traits_swapped_season" integer,
	"goal" "resident_goal" NOT NULL,
	"backstory" "resident_backstory" NOT NULL,
	"starter_item" text NOT NULL,
	"kit_style" "kit_style" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "residents_handle_format" CHECK ("residents"."handle" ~ '^[A-Za-z0-9_]{3,15}$'),
	CONSTRAINT "residents_name_length" CHECK (char_length("residents"."name") BETWEEN 1 AND 200),
	CONSTRAINT "residents_look_object" CHECK (jsonb_typeof("residents"."look") = 'object')
);
--> statement-breakpoint
ALTER TABLE "residents" ADD CONSTRAINT "residents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "residents_handle_lower" ON "residents" USING btree (lower("handle"));