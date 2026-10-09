CREATE TABLE "alt_flags" (
	"city_day" date NOT NULL,
	"low" uuid NOT NULL,
	"high" uuid NOT NULL,
	"from_user" uuid NOT NULL,
	"to_user" uuid NOT NULL,
	"amount" integer NOT NULL,
	"back" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "alt_flags_city_day_low_high_pk" PRIMARY KEY("city_day","low","high"),
	CONSTRAINT "alt_flags_order" CHECK ("alt_flags"."low" < "alt_flags"."high")
);
--> statement-breakpoint
ALTER TABLE "alt_flags" ADD CONSTRAINT "alt_flags_low_users_id_fk" FOREIGN KEY ("low") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alt_flags" ADD CONSTRAINT "alt_flags_high_users_id_fk" FOREIGN KEY ("high") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alt_flags_pair" ON "alt_flags" USING btree ("low","high");