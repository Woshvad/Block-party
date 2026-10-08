-- Roster limits, checked at commit so multi-step changes (promote then demote,
-- transfer lead) are judged on their final state.
CREATE FUNCTION crew_roster_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  members int;
  deputies int;
  leads int;
  dissolved timestamptz;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE role = 'deputy'), count(*) FILTER (WHERE role = 'lead')
    INTO members, deputies, leads
    FROM crew_members WHERE crew_id = NEW.crew_id AND left_at IS NULL;
  SELECT dissolved_at INTO dissolved FROM crews WHERE id = NEW.crew_id;
  IF members > 50 THEN
    RAISE EXCEPTION 'crew % has % members (max 50)', NEW.crew_id, members USING ERRCODE = 'check_violation';
  END IF;
  IF deputies > 2 THEN
    RAISE EXCEPTION 'crew % has % deputies (max 2)', NEW.crew_id, deputies USING ERRCODE = 'check_violation';
  END IF;
  IF dissolved IS NULL AND members > 0 AND leads <> 1 THEN
    RAISE EXCEPTION 'crew % has % leads (needs exactly 1)', NEW.crew_id, leads USING ERRCODE = 'check_violation';
  END IF;
  IF dissolved IS NULL AND members = 0 THEN
    RAISE EXCEPTION 'crew % has no members but is not dissolved', NEW.crew_id USING ERRCODE = 'check_violation';
  END IF;
  IF dissolved IS NOT NULL AND members > 0 THEN
    RAISE EXCEPTION 'dissolved crew % still has members', NEW.crew_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER crew_members_roster_check AFTER INSERT OR UPDATE ON crew_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION crew_roster_check();
--> statement-breakpoint

-- Membership history is append-only apart from closing a stint once.
CREATE FUNCTION crew_members_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.left_at IS NOT NULL THEN
    RAISE EXCEPTION 'a closed crew stint is history' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.crew_id <> OLD.crew_id OR NEW.user_id <> OLD.user_id OR NEW.joined_at <> OLD.joined_at THEN
    RAISE EXCEPTION 'crew stint identity is fixed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER crew_members_history BEFORE UPDATE ON crew_members
  FOR EACH ROW EXECUTE FUNCTION crew_members_history();
--> statement-breakpoint
CREATE TRIGGER crew_members_no_delete BEFORE DELETE ON crew_members
  FOR EACH ROW EXECUTE FUNCTION gm_append_only();
--> statement-breakpoint
CREATE TRIGGER crews_no_delete BEFORE DELETE ON crews
  FOR EACH ROW EXECUTE FUNCTION gm_append_only();
--> statement-breakpoint

-- A dissolved crew stays dissolved.
CREATE FUNCTION crews_dissolve_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.dissolved_at IS NOT NULL AND NEW.dissolved_at IS DISTINCT FROM OLD.dissolved_at THEN
    RAISE EXCEPTION 'crew % is dissolved', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER crews_dissolve_once BEFORE UPDATE ON crews
  FOR EACH ROW EXECUTE FUNCTION crews_dissolve_once();
