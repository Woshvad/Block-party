CREATE TYPE "public"."rivalry_status" AS ENUM('pending', 'active');--> statement-breakpoint
CREATE TABLE "best_frens" (
	"user_id" uuid NOT NULL,
	"fren_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "best_frens_user_id_fren_id_pk" PRIMARY KEY("user_id","fren_id"),
	CONSTRAINT "best_frens_not_self" CHECK ("best_frens"."user_id" <> "best_frens"."fren_id")
);
--> statement-breakpoint
CREATE TABLE "rivalries" (
	"a" uuid NOT NULL,
	"b" uuid NOT NULL,
	"proposed_by" uuid NOT NULL,
	"status" "rivalry_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "rivalries_a_b_pk" PRIMARY KEY("a","b"),
	CONSTRAINT "rivalries_ordered" CHECK ("rivalries"."a" < "rivalries"."b"),
	CONSTRAINT "rivalries_proposer" CHECK ("rivalries"."proposed_by" IN ("rivalries"."a", "rivalries"."b")),
	CONSTRAINT "rivalries_accepted" CHECK (("rivalries"."status" = 'active') = ("rivalries"."accepted_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "best_frens" ADD CONSTRAINT "best_frens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "best_frens" ADD CONSTRAINT "best_frens_fren_id_users_id_fk" FOREIGN KEY ("fren_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rivalries" ADD CONSTRAINT "rivalries_a_users_id_fk" FOREIGN KEY ("a") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rivalries" ADD CONSTRAINT "rivalries_b_users_id_fk" FOREIGN KEY ("b") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rivalries" ADD CONSTRAINT "rivalries_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "best_frens_fren" ON "best_frens" USING btree ("fren_id");--> statement-breakpoint
CREATE INDEX "rivalries_b" ON "rivalries" USING btree ("b");