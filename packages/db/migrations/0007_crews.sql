CREATE TYPE "public"."crew_role" AS ENUM('lead', 'deputy', 'member');--> statement-breakpoint
CREATE TYPE "public"."crew_join_policy" AS ENUM('approval', 'open');--> statement-breakpoint
CREATE TYPE "public"."crew_join_request_status" AS ENUM('pending', 'approved', 'declined', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."crew_left_reason" AS ENUM('left', 'removed', 'dissolved');--> statement-breakpoint
CREATE TABLE "crew_invites" (
	"code" text PRIMARY KEY NOT NULL,
	"crew_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"pre_approved" boolean NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"uses" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crew_join_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crew_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"invited_by" uuid,
	"status" "crew_join_request_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crew_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crew_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "crew_role" NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"left_reason" "crew_left_reason",
	CONSTRAINT "crew_members_left_consistent" CHECK (("crew_members"."left_at" IS NULL) = ("crew_members"."left_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "crews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"join_policy" "crew_join_policy" DEFAULT 'approval' NOT NULL,
	"banner" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dissolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "crew_invites" ADD CONSTRAINT "crew_invites_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_invites" ADD CONSTRAINT "crew_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_join_requests" ADD CONSTRAINT "crew_join_requests_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_join_requests" ADD CONSTRAINT "crew_join_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_join_requests" ADD CONSTRAINT "crew_join_requests_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_join_requests" ADD CONSTRAINT "crew_join_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_members" ADD CONSTRAINT "crew_members_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_members" ADD CONSTRAINT "crew_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crews" ADD CONSTRAINT "crews_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crew_invites_crew" ON "crew_invites" USING btree ("crew_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crew_join_requests_one_pending" ON "crew_join_requests" USING btree ("crew_id","user_id") WHERE "crew_join_requests"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "crew_members_one_crew" ON "crew_members" USING btree ("user_id") WHERE "crew_members"."left_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "crew_members_one_lead" ON "crew_members" USING btree ("crew_id") WHERE "crew_members"."left_at" IS NULL AND "crew_members"."role" = 'lead';--> statement-breakpoint
CREATE INDEX "crew_members_roster" ON "crew_members" USING btree ("crew_id") WHERE "crew_members"."left_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "crews_name_key_live" ON "crews" USING btree ("name_key") WHERE "crews"."dissolved_at" IS NULL;