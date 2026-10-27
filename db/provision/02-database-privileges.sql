-- CHMS-F001 database-level privileges (ADR-006 decision 2).
--
-- PRIVILEGED: run as a superuser connected to the target database, after
-- 01-cluster-roles.sql and before the first migration, only with explicit human
-- authorization (CLAUDE.md). Safe to re-run.
--
-- PostgreSQL grants CONNECT and TEMPORARY on every database to PUBLIC by default. Here
-- PUBLIC loses both, chms_owner may connect and create schemas (chms, and drizzle for
-- migration bookkeeping), and chms_app may only connect. No role but the database owner
-- gets TEMPORARY.
--
-- Authorized operator logins are added separately, per login:
--   GRANT CONNECT ON DATABASE <database> TO <operator_login>;
--   GRANT chms_audit_reader TO <operator_login>;   -- only if authorized to read audit (POL-03)

DO $$
DECLARE
  db text := pg_catalog.current_database();
BEGIN
  EXECUTE pg_catalog.format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', db);
  EXECUTE pg_catalog.format('GRANT CONNECT, CREATE ON DATABASE %I TO chms_owner', db);
  EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO chms_app', db);
END
$$;
