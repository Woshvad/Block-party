CREATE TABLE "copium_uses" (
	"key" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"paid" boolean NOT NULL,
	"cleared" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "copium_uses" ADD CONSTRAINT "copium_uses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;