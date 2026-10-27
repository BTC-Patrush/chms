-- CHMS-F001 database roles (ADR-006 decision 1).
--
-- PRIVILEGED: run as a superuser, once per cluster, and only with explicit human
-- authorization (CLAUDE.md; ADR-006 decision 5). Safe to re-run: missing roles are
-- created and every role's attributes are re-asserted.
--
-- Sets no passwords. Operators set login passwords separately, for example with
-- psql's \password command, and keep them out of files and shell history.

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['chms_owner', 'chms_app', 'chms_audit_writer', 'chms_audit_reader'] LOOP
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = r) THEN
      EXECUTE pg_catalog.format('CREATE ROLE %I', r);
    END IF;
  END LOOP;
END
$$;

-- Owns schema chms and every object in it; runs migrations and bootstrap. Operator use only.
ALTER ROLE chms_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
-- Runtime role for services and maintenance commands.
ALTER ROLE chms_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
-- Owns chms.audit_row_change(); holds INSERT on chms.audit_events only.
ALTER ROLE chms_audit_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
-- SELECT on audit tables; granted only to explicitly authorized operator logins (POL-03).
ALTER ROLE chms_audit_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- M00 creates chms.audit_row_change() as chms_audit_writer, so chms_owner must be able to
-- SET ROLE to it. INHERIT FALSE: chms_owner does not gain the writer's privileges otherwise.
GRANT chms_audit_writer TO chms_owner WITH INHERIT FALSE, SET TRUE;
