CREATE TYPE "public"."warmup_side" AS ENUM('up', 'down');--> statement-breakpoint
CREATE TYPE "public"."warmup_stamp" AS ENUM('called_it', 'rekt', 'void');--> statement-breakpoint
CREATE TYPE "public"."warmup_window_status" AS ENUM('open', 'resolved', 'void');--> statement-breakpoint
CREATE TABLE "warmup_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"window_id" uuid NOT NULL,
	"side" "warmup_side" NOT NULL,
	"account_day" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"stamp" "warmup_stamp",
	"settled_at" timestamp with time zone,
	CONSTRAINT "warmup_calls_user_day" UNIQUE("user_id","account_day"),
	CONSTRAINT "warmup_calls_window_user" UNIQUE("window_id","user_id"),
	CONSTRAINT "warmup_calls_day" CHECK ("warmup_calls"."account_day" BETWEEN 0 AND 2),
	CONSTRAINT "warmup_calls_settled" CHECK (("warmup_calls"."stamp" IS NULL) = ("warmup_calls"."settled_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "warmup_polls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"ok" boolean NOT NULL,
	"windows" integer DEFAULT 0 NOT NULL,
	"error" text,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warmup_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"question" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"trading" boolean DEFAULT true NOT NULL,
	"status" "warmup_window_status" DEFAULT 'open' NOT NULL,
	"outcome" "warmup_side",
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warmup_windows_source_external" UNIQUE("source","external_id"),
	CONSTRAINT "warmup_windows_source_slot" UNIQUE("source","starts_at"),
	CONSTRAINT "warmup_windows_order" CHECK ("warmup_windows"."ends_at" > "warmup_windows"."starts_at"),
	CONSTRAINT "warmup_windows_resolved" CHECK (("warmup_windows"."status" = 'resolved') = ("warmup_windows"."outcome" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "warmup_calls" ADD CONSTRAINT "warmup_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warmup_calls" ADD CONSTRAINT "warmup_calls_window_id_warmup_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."warmup_windows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "warmup_calls_unsettled" ON "warmup_calls" USING btree ("window_id") WHERE "warmup_calls"."stamp" IS NULL;--> statement-breakpoint
CREATE INDEX "warmup_polls_source_at" ON "warmup_polls" USING btree ("source","at");--> statement-breakpoint
CREATE INDEX "warmup_windows_waiting" ON "warmup_windows" USING btree ("source","ends_at") WHERE "warmup_windows"."status" = 'open';
-- custom (keep on regenerate)
--> statement-breakpoint
-- A window that resolved or voided is final (its calls were stamped on it),
-- it keeps its slot, and no window is ever deleted.
CREATE FUNCTION warmup_windows_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'warm-up windows are never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.source <> OLD.source OR NEW.external_id <> OLD.external_id OR NEW.starts_at <> OLD.starts_at OR NEW.ends_at <> OLD.ends_at THEN
    RAISE EXCEPTION 'a warm-up window keeps its slot' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('resolved', 'void') AND (NEW.status <> OLD.status OR NEW.outcome IS DISTINCT FROM OLD.outcome) THEN
    RAISE EXCEPTION 'warm-up window % is already final', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER warmup_windows_final BEFORE UPDATE OR DELETE ON warmup_windows FOR EACH ROW EXECUTE FUNCTION warmup_windows_final();
--> statement-breakpoint
-- A warm-up is taken unsettled, on the account day it says (24 hours each
-- from the resident's first tap, so the 0 to 2 check is their first 3 days),
-- in the first 2 minutes of a window still open. WARMUP in @bp/core says the
-- same: change one, change both.
CREATE FUNCTION warmup_calls_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  arrived timestamptz;
  w_status warmup_window_status;
  w_starts timestamptz;
BEGIN
  IF NEW.stamp IS NOT NULL OR NEW.settled_at IS NOT NULL THEN
    RAISE EXCEPTION 'a warm-up starts unsettled' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT created_at INTO arrived FROM users WHERE id = NEW.user_id;
  IF arrived IS NULL OR NEW.account_day <> GREATEST(0, floor(extract(epoch FROM NEW.created_at - arrived) / 86400)) THEN
    RAISE EXCEPTION 'a warm-up is on the account day it was taken' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT status, starts_at INTO w_status, w_starts FROM warmup_windows WHERE id = NEW.window_id;
  IF w_status IS DISTINCT FROM 'open' OR NEW.created_at < w_starts OR NEW.created_at >= w_starts + interval '2 minutes' THEN
    RAISE EXCEPTION 'warm-ups are taken in a window''s first 2 minutes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER warmup_calls_insert_guard BEFORE INSERT ON warmup_calls FOR EACH ROW EXECUTE FUNCTION warmup_calls_insert_guard();
--> statement-breakpoint
-- Never edited or deleted. The stamp is written once, and it's the window's
-- result: VOID on a void, CALLED IT on the side that happened, REKT otherwise.
CREATE FUNCTION warmup_calls_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  w_status warmup_window_status;
  w_outcome warmup_side;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'warm-ups are never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.window_id <> OLD.window_id OR NEW.side <> OLD.side
     OR NEW.account_day <> OLD.account_day OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a warm-up is never edited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.stamp IS NOT NULL THEN
    RAISE EXCEPTION 'a warm-up settles once' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.stamp IS NOT NULL THEN
    SELECT status, outcome INTO w_status, w_outcome FROM warmup_windows WHERE id = NEW.window_id;
    IF NEW.stamp IS DISTINCT FROM (CASE
         WHEN w_status = 'void' THEN 'void'
         WHEN w_status = 'resolved' AND w_outcome = NEW.side THEN 'called_it'
         WHEN w_status = 'resolved' THEN 'rekt'
       END)::warmup_stamp THEN
      RAISE EXCEPTION 'a warm-up settles on its window''s result' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER warmup_calls_guard BEFORE UPDATE OR DELETE ON warmup_calls FOR EACH ROW EXECUTE FUNCTION warmup_calls_guard();
