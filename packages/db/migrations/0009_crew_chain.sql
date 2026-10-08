CREATE TABLE "crew_chain_days" (
	"crew_id" uuid NOT NULL,
	"city_day" date NOT NULL,
	"members" integer NOT NULL,
	"active" integer NOT NULL,
	"gms" integer NOT NULL,
	"held" boolean NOT NULL,
	"relit" boolean DEFAULT false NOT NULL,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crew_chain_days_crew_id_city_day_pk" PRIMARY KEY("crew_id","city_day"),
	CONSTRAINT "crew_chain_days_counts" CHECK ("crew_chain_days"."gms" >= 0 AND "crew_chain_days"."gms" <= "crew_chain_days"."members" AND "crew_chain_days"."active" <= "crew_chain_days"."members" AND "crew_chain_days"."gms" <= "crew_chain_days"."active"),
	CONSTRAINT "crew_chain_days_relit" CHECK (NOT ("crew_chain_days"."held" AND "crew_chain_days"."relit"))
);
--> statement-breakpoint
CREATE TABLE "crew_chain_relights" (
	"crew_id" uuid NOT NULL,
	"city_day" date NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crew_chain_relights_crew_id_city_day_user_id_pk" PRIMARY KEY("crew_id","city_day","user_id")
);
--> statement-breakpoint
ALTER TABLE "crew_chain_days" ADD CONSTRAINT "crew_chain_days_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_chain_relights" ADD CONSTRAINT "crew_chain_relights_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_chain_relights" ADD CONSTRAINT "crew_chain_relights_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;