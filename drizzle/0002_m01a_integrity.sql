-- M01a integrity: identity and history immutability, audit triggers and chms_app privileges
-- (ADR-003, ADR-004, ADR-005, ADR-006; database design sections 2, 3 and 5).
-- Applied explicitly by an operator connected as chms_owner, after 0001_m01a_tables.

-- Every audit event belongs to the installation's church (database design section 2).
ALTER TABLE chms.audit_events
  ADD CONSTRAINT audit_church_fk FOREIGN KEY (church_id)
  REFERENCES chms.churches (id) ON UPDATE RESTRICT ON DELETE RESTRICT;
--> statement-breakpoint

-- Identity columns never change, for any role, the owner included (ADR-003 decision 4).
-- Trigger arguments name the identity columns of each table.
CREATE FUNCTION chms.forbid_identity_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_old jsonb := pg_catalog.to_jsonb(OLD);
  v_new jsonb := pg_catalog.to_jsonb(NEW);
  v_column text;
BEGIN
  FOREACH v_column IN ARRAY TG_ARGV LOOP
    IF NOT v_old ? v_column THEN
      RAISE EXCEPTION 'identity trigger on %.% names unknown column %',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, v_column;
    END IF;
    IF v_new -> v_column IS DISTINCT FROM v_old -> v_column THEN
      RAISE EXCEPTION 'identity column %.%.% cannot change', TG_TABLE_SCHEMA, TG_TABLE_NAME, v_column
        USING ERRCODE = 'CHI01';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION chms.forbid_identity_change() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER churches_identity
  BEFORE UPDATE ON chms.churches
  FOR EACH ROW EXECUTE FUNCTION chms.forbid_identity_change('id');
--> statement-breakpoint
CREATE TRIGGER campuses_identity
  BEFORE UPDATE ON chms.campuses
  FOR EACH ROW EXECUTE FUNCTION chms.forbid_identity_change('id', 'church_id');
--> statement-breakpoint
CREATE TRIGGER people_identity
  BEFORE UPDATE ON chms.people
  FOR EACH ROW EXECUTE FUNCTION chms.forbid_identity_change('id', 'church_id');
--> statement-breakpoint
CREATE TRIGGER pca_identity
  BEFORE UPDATE ON chms.person_campus_affiliations
  FOR EACH ROW EXECUTE FUNCTION chms.forbid_identity_change('id', 'church_id', 'person_id', 'campus_id');
--> statement-breakpoint

-- Ended affiliations are history and never change (ADR-004 decision 7).
CREATE FUNCTION chms.forbid_history_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'ended affiliation % is history and cannot change', OLD.id
    USING ERRCODE = 'CHH01';
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION chms.forbid_history_change() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER pca_history
  BEFORE UPDATE ON chms.person_campus_affiliations
  FOR EACH ROW WHEN (OLD.ended_at IS NOT NULL)
  EXECUTE FUNCTION chms.forbid_history_change();
--> statement-breakpoint

-- Every committed insert or update is audited with a declared system actor (ADR-005 decision 2).
CREATE TRIGGER churches_audit
  AFTER INSERT OR UPDATE ON chms.churches
  FOR EACH ROW EXECUTE FUNCTION chms.audit_row_change('church');
--> statement-breakpoint
CREATE TRIGGER campuses_audit
  AFTER INSERT OR UPDATE ON chms.campuses
  FOR EACH ROW EXECUTE FUNCTION chms.audit_row_change('campus');
--> statement-breakpoint
CREATE TRIGGER people_audit
  AFTER INSERT OR UPDATE ON chms.people
  FOR EACH ROW EXECUTE FUNCTION chms.audit_row_change('person');
--> statement-breakpoint
CREATE TRIGGER pca_audit
  AFTER INSERT OR UPDATE ON chms.person_campus_affiliations
  FOR EACH ROW EXECUTE FUNCTION chms.audit_row_change('person_campus_affiliation');
--> statement-breakpoint

-- chms_app privileges, exactly as in database design section 5. Column-level INSERT and UPDATE
-- only: ids are never insertable and identity columns never updatable. No DELETE, TRUNCATE,
-- REFERENCES, TRIGGER or MAINTAIN on any table. chms_app cannot insert a church: bootstrap runs
-- as chms_owner (ADR-003 decision 3).
REVOKE ALL ON chms.churches, chms.campuses, chms.people, chms.person_campus_affiliations FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON chms.churches, chms.campuses, chms.people, chms.person_campus_affiliations TO chms_app;
--> statement-breakpoint
GRANT UPDATE (name, row_version, updated_at) ON chms.churches TO chms_app;
--> statement-breakpoint
GRANT INSERT (church_id, name),
      UPDATE (name, status, archived_at, row_version, updated_at)
   ON chms.campuses TO chms_app;
--> statement-breakpoint
GRANT INSERT (church_id, display_name, given_name, family_name),
      UPDATE (display_name, given_name, family_name, status, archived_at, row_version, updated_at)
   ON chms.people TO chms_app;
--> statement-breakpoint
GRANT INSERT (church_id, person_id, campus_id, is_primary),
      UPDATE (is_primary, ended_at, end_reason, person_status, campus_status, row_version, updated_at)
   ON chms.person_campus_affiliations TO chms_app;
