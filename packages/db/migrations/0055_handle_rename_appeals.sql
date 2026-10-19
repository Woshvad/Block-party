CREATE TABLE "handle_rename_appeals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rename_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"status" "appeal_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	CONSTRAINT "handle_rename_appeals_rename_id_unique" UNIQUE("rename_id"),
	CONSTRAINT "handle_rename_appeals_text" CHECK (char_length("handle_rename_appeals"."text") BETWEEN 10 AND 1000),
	CONSTRAINT "handle_rename_appeals_decided" CHECK (("handle_rename_appeals"."status" = 'open') = ("handle_rename_appeals"."decided_at" IS NULL) AND ("handle_rename_appeals"."decided_at" IS NULL) = ("handle_rename_appeals"."decided_by" IS NULL) AND ("handle_rename_appeals"."decided_at" IS NULL) = ("handle_rename_appeals"."decision_note" IS NULL)),
	CONSTRAINT "handle_rename_appeals_note" CHECK ("handle_rename_appeals"."decision_note" IS NULL OR char_length("handle_rename_appeals"."decision_note") BETWEEN 20 AND 200)
);
--> statement-breakpoint
ALTER TABLE "handle_renames" ADD COLUMN "appeal_id" uuid;--> statement-breakpoint
ALTER TABLE "handle_rename_appeals" ADD CONSTRAINT "handle_rename_appeals_rename_id_handle_renames_id_fk" FOREIGN KEY ("rename_id") REFERENCES "public"."handle_renames"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_rename_appeals" ADD CONSTRAINT "handle_rename_appeals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_rename_appeals" ADD CONSTRAINT "handle_rename_appeals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handle_rename_appeals_open" ON "handle_rename_appeals" USING btree ("created_at") WHERE "handle_rename_appeals"."status" = 'open';--> statement-breakpoint
ALTER TABLE "handle_renames" ADD CONSTRAINT "handle_renames_appeal_id_handle_rename_appeals_id_fk" FOREIGN KEY ("appeal_id") REFERENCES "public"."handle_rename_appeals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "handle_renames_appeal" ON "handle_renames" USING btree ("appeal_id");--> statement-breakpoint
-- custom (keep on regenerate)
-- Whether a handle rests after a staff rename, for anyone but `for_user`:
-- until that rename's held_until, and for as long as an appeal against it is
-- open, so overturning one can always give the handle back. The trigger
-- below, isHandleAvailable and renameHandle's neutral picks all ask this.
CREATE FUNCTION handle_resting(h text, for_user uuid, as_of timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM handle_renames r
    WHERE lower(r.old_handle) = lower(h) AND r.user_id IS DISTINCT FROM for_user
      AND (r.held_until > as_of
           OR EXISTS (SELECT 1 FROM handle_rename_appeals a WHERE a.rename_id = r.id AND a.status = 'open')))
$$;
--> statement-breakpoint
-- As in 0054, with the resting check now asked of handle_resting.
CREATE OR REPLACE FUNCTION resident_handle_resting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  k text := lower(NEW.handle);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.handle IS NOT DISTINCT FROM OLD.handle THEN
      RETURN NEW;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('resident_handle:' || least(k, lower(OLD.handle))));
    PERFORM pg_advisory_xact_lock(hashtext('resident_handle:' || greatest(k, lower(OLD.handle))));
  ELSE
    PERFORM pg_advisory_xact_lock(hashtext('resident_handle:' || k));
  END IF;
  IF handle_resting(NEW.handle, NEW.user_id, now()) THEN
    RAISE EXCEPTION 'that handle is resting after a rename'
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'residents_handle_held';
  END IF;
  RETURN NEW;
END $$;
