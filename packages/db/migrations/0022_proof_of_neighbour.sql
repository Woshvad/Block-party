CREATE TYPE "public"."proof_kind" AS ENUM('phone', 'wallet_history', 'coinbase', 'world_id');--> statement-breakpoint
CREATE TABLE "phone_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"phone_hash" text NOT NULL,
	"provider_ref" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "phone_checks_status" CHECK ("phone_checks"."status" IN ('pending','verified','failed'))
);
--> statement-breakpoint
CREATE TABLE "room_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"room" text NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "room_visits_order" CHECK ("room_visits"."left_at" IS NULL OR "room_visits"."left_at" >= "room_visits"."joined_at")
);
--> statement-breakpoint
CREATE TABLE "verified_identities" (
	"user_id" uuid NOT NULL,
	"kind" "proof_kind" NOT NULL,
	"subject_hash" text NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verified_identities_user_id_kind_pk" PRIMARY KEY("user_id","kind")
);
--> statement-breakpoint
ALTER TABLE "phone_checks" ADD CONSTRAINT "phone_checks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_visits" ADD CONSTRAINT "room_visits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_identities" ADD CONSTRAINT "verified_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "phone_checks_user" ON "phone_checks" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "room_visits_room" ON "room_visits" USING btree ("room","joined_at");--> statement-breakpoint
CREATE INDEX "room_visits_user" ON "room_visits" USING btree ("user_id","joined_at");--> statement-breakpoint
CREATE UNIQUE INDEX "verified_identities_subject" ON "verified_identities" USING btree ("kind","subject_hash");