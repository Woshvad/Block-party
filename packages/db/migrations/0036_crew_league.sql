CREATE TABLE "crew_league" (
	"crew_id" uuid PRIMARY KEY NOT NULL,
	"size_group" text NOT NULL,
	"place" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "league_weeks" (
	"week" date NOT NULL,
	"crew_id" uuid NOT NULL,
	"size_group" text NOT NULL,
	"division" integer NOT NULL,
	"rank" integer NOT NULL,
	"score_milli" integer,
	"moved" text NOT NULL,
	"champion" boolean DEFAULT false NOT NULL,
	CONSTRAINT "league_weeks_week_crew_id_pk" PRIMARY KEY("week","crew_id")
);
--> statement-breakpoint
ALTER TABLE "crew_league" ADD CONSTRAINT "crew_league_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_weeks" ADD CONSTRAINT "league_weeks_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crew_league_place" ON "crew_league" USING btree ("size_group","place");