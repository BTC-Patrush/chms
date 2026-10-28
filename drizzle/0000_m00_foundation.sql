-- M00 foundation: schema, system actor categories and the audit trail (ADR-005, ADR-006).
-- Applied explicitly by an operator connected as chms_owner, after db/provision/*.sql.
-- The migrator runs this file in one transaction.

-- Schema chms is owned by chms_owner; nobody else may create objects in it (ADR-006 decision 3).
CREATE SCHEMA chms;
--> statement-breakpoint
GRANT USAGE ON SCHEMA chms TO chms_app, chms_audit_writer, chms_audit_reader;
--> statement-breakpoint

-- Functions chms_owner creates get no EXECUTE for PUBLIC. Schema-scoped default privileges can
-- only add to the global defaults, so the revocation must not be limited to schema chms.
ALTER DEFAULT PRIVILEGES FOR ROLE chms_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint

-- System actor categories (ADR-005 decision 3). Production holds only bootstrap and
-- maintenance (POL-01); test categories are added only by test setup (POL-02).
CREATE TABLE chms.system_actor_categories (
  category text NOT NULL,
  CONSTRAINT system_actor_categories_pkey PRIMARY KEY (category),
  CONSTRAINT system_actor_categories_format_ck CHECK (category ~ '^[a-z][a-z0-9_-]{1,40}$')
);
--> statement-breakpoint
INSERT INTO chms.system_actor_categories (category) VALUES ('bootstrap'), ('maintenance');
--> statement-breakpoint

-- Append-only audit trail (ADR-005 decisions 1, 4 and 5). Column names only, never values.
-- church_id gets its foreign key to chms.churches in M01a, once that table exists.
CREATE TABLE chms.audit_events (
  id uuid NOT NULL DEFAULT uuidv7(),
  church_id uuid NOT NULL,
  xact_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_kind text NOT NULL,
  actor_category text NOT NULL,
  actor_user_id uuid,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  changed_fields text[] NOT NULL DEFAULT '{}',
  CONSTRAINT audit_events_pkey PRIMARY KEY (id),
  -- Widened only by CHMS-F002, with human actors bound to authenticated accounts.
  CONSTRAINT audit_actor_kind_ck CHECK (actor_kind = 'system'),
  CONSTRAINT audit_actor_user_ck CHECK (actor_user_id IS NULL),
  CONSTRAINT audit_action_ck
    CHECK (action IN ('create', 'update', 'archive', 'unarchive', 'end_affiliation')),
  CONSTRAINT audit_entity_type_ck
    CHECK (entity_type IN ('church', 'campus', 'person', 'person_campus_affiliation')),
  CONSTRAINT audit_actor_category_fk FOREIGN KEY (actor_category)
    REFERENCES chms.system_actor_categories (category) ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX audit_events_entity_ix ON chms.audit_events (entity_type, entity_id, occurred_at);
--> statement-breakpoint
CREATE INDEX audit_events_xact_ix ON chms.audit_events (xact_id);
--> statement-breakpoint

-- Privileges (ADR-005 decision 6, ADR-006 decision 4). chms_app gets nothing on audit tables.
REVOKE ALL ON chms.audit_events, chms.system_actor_categories FROM PUBLIC;
--> statement-breakpoint
GRANT INSERT ON chms.audit_events TO chms_audit_writer;
--> statement-breakpoint
GRANT SELECT ON chms.audit_events, chms.system_actor_categories TO chms_audit_reader;
--> statement-breakpoint

-- Audit events cannot be changed or removed by any role, the owner included (ADR-005 decision 5).
CREATE FUNCTION chms.forbid_audit_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only' USING ERRCODE = 'CHA02';
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION chms.forbid_audit_change() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON chms.audit_events
  FOR EACH ROW EXECUTE FUNCTION chms.forbid_audit_change();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON chms.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION chms.forbid_audit_change();
--> statement-breakpoint

-- The audit writer (ADR-005 decisions 2 to 4). It is owned by chms_audit_writer, a NOLOGIN role
-- whose only table privilege is INSERT on chms.audit_events, so the function is created as that
-- role. The writer holds CREATE on the schema for the rest of this transaction only.
GRANT CREATE ON SCHEMA chms TO chms_audit_writer;
--> statement-breakpoint
SET LOCAL ROLE chms_audit_writer;
--> statement-breakpoint
-- Row trigger: AFTER INSERT OR UPDATE ... EXECUTE FUNCTION chms.audit_row_change('<entity type>').
-- Fails closed (CHA01) when the transaction declared no actor. Uses no dynamic SQL; every
-- relation and function is schema-qualified, and pg_temp is searched last.
CREATE FUNCTION chms.audit_row_change() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_entity_type text := TG_ARGV[0];
  v_new jsonb := pg_catalog.to_jsonb(NEW);
  v_old jsonb;
  v_category text := NULLIF(pg_catalog.current_setting('chms.actor_category', true), '');
  v_action text;
  v_fields text[];
BEGIN
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'no system actor category declared for this transaction'
      USING ERRCODE = 'CHA01',
            HINT = 'Declare it with set_config(''chms.actor_category'', <category>, true).';
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_action := 'create';
    SELECT COALESCE(pg_catalog.array_agg(n.key ORDER BY n.key), '{}')
      INTO v_fields
      FROM pg_catalog.jsonb_each(v_new) AS n
     WHERE n.value <> 'null'::jsonb
       AND n.key NOT IN ('row_version', 'updated_at');
  ELSE
    v_old := pg_catalog.to_jsonb(OLD);
    SELECT COALESCE(pg_catalog.array_agg(n.key ORDER BY n.key), '{}')
      INTO v_fields
      FROM pg_catalog.jsonb_each(v_new) AS n
     WHERE n.key NOT IN ('row_version', 'updated_at')
       AND n.value IS DISTINCT FROM v_old -> n.key;
    v_action := CASE
      WHEN v_new ? 'status' AND v_new -> 'status' IS DISTINCT FROM v_old -> 'status' THEN
        CASE WHEN v_new ->> 'status' = 'archived' THEN 'archive' ELSE 'unarchive' END
      WHEN v_new ? 'ended_at' AND v_old -> 'ended_at' = 'null'::jsonb
           AND v_new -> 'ended_at' <> 'null'::jsonb THEN
        'end_affiliation'
      ELSE 'update'
    END;
  END IF;

  INSERT INTO chms.audit_events
    (church_id, actor_kind, actor_category, actor_user_id, action, entity_type, entity_id, changed_fields)
  VALUES (
    CASE WHEN v_entity_type = 'church' THEN (v_new ->> 'id')::uuid ELSE (v_new ->> 'church_id')::uuid END,
    COALESCE(NULLIF(pg_catalog.current_setting('chms.actor_kind', true), ''), 'system'),
    v_category,
    NULLIF(pg_catalog.current_setting('chms.actor_user_id', true), '')::uuid,
    v_action,
    v_entity_type,
    (v_new ->> 'id')::uuid,
    v_fields
  );
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION chms.audit_row_change() FROM PUBLIC;
--> statement-breakpoint
-- chms_owner creates the audit triggers on F001 tables (M01a), which requires EXECUTE.
GRANT EXECUTE ON FUNCTION chms.audit_row_change() TO chms_owner;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA chms FROM chms_audit_writer;
