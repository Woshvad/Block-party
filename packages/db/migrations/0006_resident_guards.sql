-- Exactly 3 different traits from the MVP list. COALESCE matters: a CHECK
-- passes on NULL, and array_length('{}') is NULL.
CREATE FUNCTION resident_traits_ok(t text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
         array_length(t, 1) = 3
     AND array_ndims(t) = 1
     AND array_position(t, NULL) IS NULL
     AND (SELECT count(DISTINCT x) FROM unnest(t) x) = 3
     AND t <@ ARRAY['contrarian','night_owl','early_bird','diamond_hands','copium_regular','roof_rat',
                    'bunker_lawyer','touch_grasser','builder','lurker','hype_man','ape']::text[],
         false)
$$;
--> statement-breakpoint
ALTER TABLE residents ADD CONSTRAINT residents_traits_ok CHECK (resident_traits_ok(traits));
--> statement-breakpoint

-- What the city deals once, and the @handle (fixed at MVP), never change.
CREATE FUNCTION resident_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.handle IS DISTINCT FROM OLD.handle THEN
    RAISE EXCEPTION 'resident handle is fixed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.backstory IS DISTINCT FROM OLD.backstory OR NEW.starter_item IS DISTINCT FROM OLD.starter_item THEN
    RAISE EXCEPTION 'resident backstory is dealt once' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'resident identity is fixed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER residents_immutable BEFORE UPDATE ON residents
  FOR EACH ROW EXECUTE FUNCTION resident_immutable();
--> statement-breakpoint
CREATE TRIGGER residents_no_delete BEFORE DELETE ON residents
  FOR EACH ROW EXECUTE FUNCTION gm_append_only();
