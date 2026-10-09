CREATE TYPE "public"."chat_kind" AS ENUM('board', 'crew', 'dm');--> statement-breakpoint
CREATE TABLE "board_follows" (
	"user_id" uuid NOT NULL,
	"place" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_follows_user_id_place_pk" PRIMARY KEY("user_id","place")
);
--> statement-breakpoint
CREATE TABLE "dm_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"a" uuid NOT NULL,
	"b" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dm_threads_ordered" CHECK ("dm_threads"."a" < "dm_threads"."b")
);
--> statement-breakpoint
CREATE TABLE "fren_taps" (
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"place" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fren_taps_from_id_to_id_pk" PRIMARY KEY("from_id","to_id"),
	CONSTRAINT "fren_taps_not_self" CHECK ("fren_taps"."from_id" <> "fren_taps"."to_id")
);
--> statement-breakpoint
CREATE TABLE "frens" (
	"a" uuid NOT NULL,
	"b" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "frens_a_b_pk" PRIMARY KEY("a","b"),
	CONSTRAINT "frens_ordered" CHECK ("frens"."a" < "frens"."b")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "chat_kind" NOT NULL,
	"channel" text NOT NULL,
	"author_id" uuid NOT NULL,
	"text" text NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "messages_text" CHECK (char_length("messages"."text") BETWEEN 1 AND 4000)
);
--> statement-breakpoint
ALTER TABLE "board_follows" ADD CONSTRAINT "board_follows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_threads" ADD CONSTRAINT "dm_threads_a_users_id_fk" FOREIGN KEY ("a") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_threads" ADD CONSTRAINT "dm_threads_b_users_id_fk" FOREIGN KEY ("b") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_threads" ADD CONSTRAINT "dm_threads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fren_taps" ADD CONSTRAINT "fren_taps_from_id_users_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fren_taps" ADD CONSTRAINT "fren_taps_to_id_users_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "frens" ADD CONSTRAINT "frens_a_users_id_fk" FOREIGN KEY ("a") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "frens" ADD CONSTRAINT "frens_b_users_id_fk" FOREIGN KEY ("b") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dm_threads_pair" ON "dm_threads" USING btree ("a","b");--> statement-breakpoint
CREATE INDEX "frens_b" ON "frens" USING btree ("b");--> statement-breakpoint
CREATE INDEX "messages_channel" ON "messages" USING btree ("kind","channel","created_at");