CREATE TYPE "public"."home_tier" AS ENUM('tenement');--> statement-breakpoint
CREATE TYPE "public"."item_source" AS ENUM('kit', 'starter', 'purchase', 'earned');--> statement-breakpoint
CREATE TYPE "public"."crew_piece_proposal_status" AS ENUM('pending', 'bought', 'cancelled');--> statement-breakpoint
CREATE TABLE "crew_houses" (
	"crew_id" uuid PRIMARY KEY NOT NULL,
	"wall_finish" text DEFAULT 'plaster' NOT NULL,
	"floor_finish" text DEFAULT 'boards' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crew_piece_approvals" (
	"proposal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crew_piece_approvals_proposal_id_user_id_pk" PRIMARY KEY("proposal_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "crew_piece_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crew_id" uuid NOT NULL,
	"piece_id" text NOT NULL,
	"proposed_by" uuid NOT NULL,
	"status" "crew_piece_proposal_status" DEFAULT 'pending' NOT NULL,
	"item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "crew_piece_proposals_bought" CHECK (("crew_piece_proposals"."status" = 'bought') = ("crew_piece_proposals"."item_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "homes" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"tier" "home_tier" DEFAULT 'tenement' NOT NULL,
	"wall_finish" text DEFAULT 'plaster' NOT NULL,
	"floor_finish" text DEFAULT 'boards' NOT NULL,
	"door_open" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"piece_id" text NOT NULL,
	"owner_user_id" uuid,
	"owner_crew_id" uuid,
	"source" "item_source" NOT NULL,
	"price_paid" integer,
	"tx_id" uuid,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_one_owner" CHECK (("items"."owner_user_id" IS NULL) <> ("items"."owner_crew_id" IS NULL)),
	CONSTRAINT "items_paid_consistent" CHECK (("items"."source" = 'purchase') = ("items"."price_paid" IS NOT NULL AND "items"."tx_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "placements" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"room" text NOT NULL,
	"layer" text NOT NULL,
	"spot" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "placements_layer" CHECK ("placements"."layer" IN ('floor','rug','wall'))
);
--> statement-breakpoint
ALTER TABLE "crew_houses" ADD CONSTRAINT "crew_houses_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_piece_approvals" ADD CONSTRAINT "crew_piece_approvals_proposal_id_crew_piece_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."crew_piece_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_piece_approvals" ADD CONSTRAINT "crew_piece_approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_piece_proposals" ADD CONSTRAINT "crew_piece_proposals_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_piece_proposals" ADD CONSTRAINT "crew_piece_proposals_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_piece_proposals" ADD CONSTRAINT "crew_piece_proposals_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homes" ADD CONSTRAINT "homes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_owner_crew_id_crews_id_fk" FOREIGN KEY ("owner_crew_id") REFERENCES "public"."crews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_tx_id_gm_transactions_id_fk" FOREIGN KEY ("tx_id") REFERENCES "public"."gm_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placements" ADD CONSTRAINT "placements_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crew_piece_proposals_crew" ON "crew_piece_proposals" USING btree ("crew_id");--> statement-breakpoint
CREATE INDEX "items_owner_user" ON "items" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "items_owner_crew" ON "items" USING btree ("owner_crew_id");--> statement-breakpoint
CREATE UNIQUE INDEX "items_tx_once" ON "items" USING btree ("tx_id");--> statement-breakpoint
CREATE UNIQUE INDEX "items_free_once_user" ON "items" USING btree ("owner_user_id","piece_id") WHERE "items"."source" <> 'purchase';--> statement-breakpoint
CREATE UNIQUE INDEX "items_working_once_user" ON "items" USING btree ("owner_user_id","piece_id") WHERE "items"."piece_id" IN ('guestbook','trophy_wall','slate_board','tv');--> statement-breakpoint
CREATE UNIQUE INDEX "items_working_once_crew" ON "items" USING btree ("owner_crew_id","piece_id") WHERE "items"."piece_id" IN ('guestbook','trophy_wall','slate_board','tv');