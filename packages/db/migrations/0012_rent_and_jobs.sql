CREATE TYPE "public"."rent_status" AS ENUM('paid', 'couch', 'sublet');--> statement-breakpoint
CREATE TYPE "public"."shift_kind" AS ENUM('active', 'away');--> statement-breakpoint
CREATE TABLE "rent_charges" (
	"user_id" uuid NOT NULL,
	"saturday" date NOT NULL,
	"status" "rent_status" NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	"tx_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rent_charges_user_id_saturday_pk" PRIMARY KEY("user_id","saturday"),
	CONSTRAINT "rent_charges_paid" CHECK (("rent_charges"."status" = 'paid') = ("rent_charges"."tx_id" IS NOT NULL AND "rent_charges"."amount" > 0)),
	CONSTRAINT "rent_charges_unpaid_zero" CHECK ("rent_charges"."status" = 'paid' OR "rent_charges"."amount" = 0)
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"city_day" date NOT NULL,
	"slot" integer NOT NULL,
	"kind" "shift_kind" NOT NULL,
	"seed" integer,
	"started_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"score" integer,
	"pay" integer,
	"collected_tx" uuid,
	CONSTRAINT "shifts_slot" CHECK ("shifts"."slot" BETWEEN 1 AND 2),
	CONSTRAINT "shifts_score" CHECK ("shifts"."score" IS NULL OR "shifts"."score" BETWEEN 0 AND 10),
	CONSTRAINT "shifts_pay" CHECK ("shifts"."pay" IS NULL OR "shifts"."pay" BETWEEN 5 AND 12),
	CONSTRAINT "shifts_collected_paid" CHECK ("shifts"."collected_tx" IS NULL OR "shifts"."pay" IS NOT NULL),
	CONSTRAINT "shifts_active_seed" CHECK (("shifts"."kind" = 'active') = ("shifts"."seed" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "daily_gm" ADD COLUMN "said_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "proof_of_neighbour_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rent_charges" ADD CONSTRAINT "rent_charges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_charges" ADD CONSTRAINT "rent_charges_tx_id_gm_transactions_id_fk" FOREIGN KEY ("tx_id") REFERENCES "public"."gm_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_collected_tx_gm_transactions_id_fk" FOREIGN KEY ("collected_tx") REFERENCES "public"."gm_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_daily_cap" ON "shifts" USING btree ("user_id","city_day","slot");--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_one_away_a_day" ON "shifts" USING btree ("user_id","city_day") WHERE "shifts"."kind" = 'away';