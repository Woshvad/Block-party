CREATE TABLE "handle_notices" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"rename_id" uuid NOT NULL,
	"from_handle" text NOT NULL,
	"seen_at" timestamp with time zone
);--> statement-breakpoint
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
);--> statement-breakpoint
CREATE TABLE "handle_renames" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"old_handle" text NOT NULL,
	"new_handle" text NOT NULL,
	"staff_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"report_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"held_until" timestamp with time zone NOT NULL,
	"appeal_id" uuid,
	CONSTRAINT "handle_renames_not_self" CHECK ("handle_renames"."staff_id" <> "handle_renames"."user_id"),
	CONSTRAINT "handle_renames_changed" CHECK (lower("handle_renames"."old_handle") <> lower("handle_renames"."new_handle")),
	CONSTRAINT "handle_renames_new_handle" CHECK ("handle_renames"."new_handle" ~ '^[A-Za-z0-9_]{3,15}$'),
	CONSTRAINT "handle_renames_reason" CHECK (char_length("handle_renames"."reason") BETWEEN 20 AND 200),
	CONSTRAINT "handle_renames_held" CHECK ("handle_renames"."held_until" > "handle_renames"."created_at")
);--> statement-breakpoint
ALTER TABLE "handle_notices" ADD CONSTRAINT "handle_notices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_notices" ADD CONSTRAINT "handle_notices_rename_id_handle_renames_id_fk" FOREIGN KEY ("rename_id") REFERENCES "public"."handle_renames"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_rename_appeals" ADD CONSTRAINT "handle_rename_appeals_rename_id_handle_renames_id_fk" FOREIGN KEY ("rename_id") REFERENCES "public"."handle_renames"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_rename_appeals" ADD CONSTRAINT "handle_rename_appeals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_rename_appeals" ADD CONSTRAINT "handle_rename_appeals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_renames" ADD CONSTRAINT "handle_renames_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_renames" ADD CONSTRAINT "handle_renames_staff_id_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_renames" ADD CONSTRAINT "handle_renames_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_renames" ADD CONSTRAINT "handle_renames_appeal_id_handle_rename_appeals_id_fk" FOREIGN KEY ("appeal_id") REFERENCES "public"."handle_rename_appeals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handle_rename_appeals_open" ON "handle_rename_appeals" USING btree ("created_at") WHERE "handle_rename_appeals"."status" = 'open';--> statement-breakpoint
CREATE INDEX "handle_renames_user" ON "handle_renames" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "handle_renames_old_handle" ON "handle_renames" USING btree (lower("old_handle"));--> statement-breakpoint
CREATE UNIQUE INDEX "handle_renames_appeal" ON "handle_renames" USING btree ("appeal_id");--> statement-breakpoint
-- custom (keep on regenerate)
-- A rename is a record of a moderation decision: never edited or deleted.
-- The notice is the resident's to dismiss, so it stays editable.
CREATE TRIGGER handle_renames_append_only BEFORE UPDATE OR DELETE ON handle_renames
  FOR EACH ROW EXECUTE FUNCTION gm_append_only();--> statement-breakpoint
CREATE TRIGGER handle_renames_no_truncate BEFORE TRUNCATE ON handle_renames
  FOR EACH STATEMENT EXECUTE FUNCTION gm_append_only();--> statement-breakpoint
-- The @handle stays fixed, except for a staff rename. The rename says who is
-- doing it with a switch that lasts only for its own transaction
-- (set_config('bp.handle_rename', '<staff id>', true), the same as SET LOCAL),
-- that person must really be staff, the resident must not be (so no staff
-- member renames themselves or another), and the rename's audit row must
-- already be written. A plain UPDATE, with no switch, is refused as before.
CREATE OR REPLACE FUNCTION resident_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  switch text;
  by_staff uuid;
BEGIN
  IF NEW.handle IS DISTINCT FROM OLD.handle THEN
    -- Outside its transaction the switch reads as NULL or '' (once a session
    -- has set it), and neither is a staff id. Checked one step at a time, so
    -- nothing is read as a uuid before it looks like one.
    switch := current_setting('bp.handle_rename', true);
    IF switch IS NULL OR switch !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'resident handle is fixed' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    by_staff := switch::uuid;
    IF NOT EXISTS (SELECT 1 FROM staff WHERE user_id = by_staff) THEN
      RAISE EXCEPTION 'resident handle is fixed' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM staff WHERE user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'staff handles are fixed' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM handle_renames r
                   WHERE r.user_id = NEW.user_id AND r.staff_id = by_staff
                     AND r.old_handle = OLD.handle AND r.new_handle = NEW.handle) THEN
      RAISE EXCEPTION 'a handle rename needs its audit row' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW.backstory IS DISTINCT FROM OLD.backstory OR NEW.starter_item IS DISTINCT FROM OLD.starter_item THEN
    RAISE EXCEPTION 'resident backstory is dealt once' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'resident identity is fixed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
-- A renamed-away handle rests until its held_until: only the resident it was
-- taken from may have it back before then (staff undoing a mistake). Raised
-- as a unique violation on its own name, so callers treat it as taken.
-- One claim on a handle at a time: each insert or rename takes an advisory
-- lock per lowercased handle (a rename both its old and its new one, in a
-- fixed order), so a move-in can't slip into a handle while the rename that
-- frees it commits. It waits, then sees the rename.
CREATE FUNCTION resident_handle_resting() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF EXISTS (SELECT 1 FROM handle_renames
             WHERE lower(old_handle) = k AND user_id <> NEW.user_id AND held_until > now()) THEN
    RAISE EXCEPTION 'that handle is resting after a rename'
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'residents_handle_held';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
-- Named to run after residents_immutable, so a refused rename takes no locks.
CREATE TRIGGER residents_resting_handles BEFORE INSERT OR UPDATE OF handle ON residents
  FOR EACH ROW EXECUTE FUNCTION resident_handle_resting();--> statement-breakpoint
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
$$;--> statement-breakpoint
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
