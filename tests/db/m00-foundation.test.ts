import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAdmin, roleConfig, uniqueSuffix } from '../support/cluster.ts';
import { createFoundationDatabase, type FoundationDatabase } from '../support/foundation.ts';
import { pgFailure } from '../support/pg-assert.ts';

/*
 * M00 foundation: roles, database, schema and table privileges, and the audit trail
 * (ADR-005, ADR-006; TS-F001-26 to TS-F001-31 and TS-F001-34 at the M00 level). The F001
 * tables arrive in M01a, so the audit writer is exercised through a test-only fixture table
 * (chms_test.audited) that carries the same trigger the F001 tables will use.
 */

const ROLES = ['chms_app', 'chms_audit_reader', 'chms_audit_writer', 'chms_owner'];
const ACTOR = { 'chms.actor_category': 'maintenance' };

describe('M00 foundation', () => {
  const operator = `m00_operator_${uniqueSuffix()}`;
  const operatorPassword = randomBytes(24).toString('hex');
  let db: FoundationDatabase;
  let admin: pg.Client;
  let owner: pg.Client;
  let app: pg.Client;
  let reader: pg.Client;

  beforeAll(async () => {
    db = await createFoundationDatabase();
    admin = await db.connectAdmin();
    owner = await db.connectAs(db.ownerConfig);
    app = await db.connectAs(db.appConfig);
    // A test-only authorized operator login with audit-reader membership (POL-03).
    await admin.query(`CREATE ROLE ${operator} LOGIN PASSWORD '${operatorPassword}'`);
    await admin.query(`GRANT CONNECT ON DATABASE ${db.name} TO ${operator}`);
    await admin.query(`GRANT chms_audit_reader TO ${operator}`);
    reader = await db.connectAs(roleConfig(db.name, operator, operatorPassword));
    // Test-only fixture, audited exactly like an F001 table.
    await owner.query('CREATE SCHEMA chms_test');
    await owner.query(
      `CREATE TABLE chms_test.audited (
         id uuid PRIMARY KEY DEFAULT uuidv7(),
         church_id uuid NOT NULL,
         name text NOT NULL,
         status text NOT NULL DEFAULT 'active',
         ended_at timestamptz,
         row_version integer NOT NULL DEFAULT 1,
         updated_at timestamptz NOT NULL DEFAULT now())`,
    );
    await owner.query(
      "CREATE TRIGGER audited_audit AFTER INSERT OR UPDATE ON chms_test.audited FOR EACH ROW EXECUTE FUNCTION chms.audit_row_change('campus')",
    );
    await owner.query('GRANT USAGE ON SCHEMA chms_test TO chms_app');
    await owner.query('GRANT SELECT, INSERT, UPDATE ON chms_test.audited TO chms_app');
  });

  afterAll(async () => {
    for (const client of [reader, app, owner, admin] as (pg.Client | undefined)[]) {
      await client?.end();
    }
    await db.drop();
    const cluster = await connectAdmin();
    try {
      await cluster.query(`DROP ROLE IF EXISTS ${operator}`);
    } finally {
      await cluster.end();
    }
  });

  /** Runs `work` in one transaction with transaction-local settings, as services will. */
  const inTransaction = async <T>(
    client: pg.Client,
    settings: Record<string, string>,
    work: () => Promise<T>,
  ): Promise<T> => {
    await client.query('BEGIN');
    try {
      for (const [name, value] of Object.entries(settings)) {
        await client.query('SELECT set_config($1, $2, true)', [name, value]);
      }
      const result = await work();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  };

  const insertAudited = async (client: pg.Client, name: string, churchId = randomUUID()) => {
    const { rows } = await client.query<{ id: string }>(
      'INSERT INTO chms_test.audited (church_id, name) VALUES ($1, $2) RETURNING id',
      [churchId, name],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('INSERT returned no id');
    return id;
  };

  interface AuditEvent {
    church_id: string;
    actor_kind: string;
    actor_category: string;
    actor_user_id: string | null;
    action: string;
    entity_type: string;
    entity_id: string;
    changed_fields: string[];
    xact_id: string;
  }

  const eventsFor = async (entityId: string) =>
    (
      await admin.query<AuditEvent>(
        `SELECT church_id, actor_kind, actor_category, actor_user_id, action, entity_type,
                entity_id, changed_fields, xact_id::text AS xact_id
           FROM chms.audit_events WHERE entity_id = $1 ORDER BY occurred_at, id`,
        [entityId],
      )
    ).rows;

  const auditedCount = async () =>
    (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM chms_test.audited')).rows[0]
      ?.n;

  describe('roles and provisioning (ADR-006; TS-F001-31)', () => {
    it('gives the four roles exactly the ADR-006 attributes', async () => {
      const { rows } = await admin.query(
        `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
           FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
        [ROLES],
      );
      const flags = { rolsuper: false, rolcreatedb: false, rolcreaterole: false };
      const more = { rolreplication: false, rolbypassrls: false };
      expect(rows).toEqual([
        { rolname: 'chms_app', rolcanlogin: true, ...flags, ...more },
        { rolname: 'chms_audit_reader', rolcanlogin: false, ...flags, ...more },
        { rolname: 'chms_audit_writer', rolcanlogin: false, ...flags, ...more },
        { rolname: 'chms_owner', rolcanlogin: true, ...flags, ...more },
      ]);
    });

    it('lets chms_owner only SET ROLE to the writer, and grants no predefined roles', async () => {
      const { rows } = await admin.query(
        `SELECT r.rolname AS role, m.rolname AS member, am.admin_option, am.inherit_option, am.set_option
           FROM pg_auth_members am
           JOIN pg_roles r ON r.oid = am.roleid
           JOIN pg_roles m ON m.oid = am.member
          WHERE r.rolname = ANY($1) OR m.rolname = ANY($1)
          ORDER BY 1, 2`,
        [ROLES],
      );
      expect(rows).toEqual([
        {
          role: 'chms_audit_reader',
          member: operator,
          admin_option: false,
          inherit_option: true,
          set_option: true,
        },
        {
          role: 'chms_audit_writer',
          member: 'chms_owner',
          admin_option: false,
          inherit_option: false,
          set_option: true,
        },
      ]);
    });

    it('denies PUBLIC CONNECT and TEMPORARY; chms_app may only connect', async () => {
      const { rows } = await admin.query(
        `SELECT r.role, p.priv
           FROM unnest($1::text[]) AS r(role), unnest(ARRAY['CONNECT', 'CREATE', 'TEMPORARY']) AS p(priv)
          WHERE has_database_privilege(r.role, current_database(), p.priv)
          ORDER BY 1, 2`,
        [['public', ...ROLES]],
      );
      expect(rows).toEqual([
        { role: 'chms_app', priv: 'CONNECT' },
        { role: 'chms_owner', priv: 'CONNECT' },
        { role: 'chms_owner', priv: 'CREATE' },
      ]);
      expect(await pgFailure(app.query('CREATE TEMP TABLE x (i int)'))).toMatchObject({
        code: '42501',
      });
    });

    it('holds no chms.* role or database defaults (TS-F001-28)', async () => {
      const { rows } = await admin.query(
        "SELECT setrole, setdatabase FROM pg_db_role_setting, unnest(setconfig) AS c WHERE c LIKE 'chms.%'",
      );
      expect(rows).toEqual([]);
    });
  });

  describe('schema chms and default privileges (ADR-006 decision 3)', () => {
    it('gives USAGE to the three roles and CREATE to nobody but the owner', async () => {
      const { rows } = await admin.query(
        `SELECT r.role, p.priv
           FROM unnest($1::text[]) AS r(role), unnest(ARRAY['USAGE', 'CREATE']) AS p(priv)
          WHERE has_schema_privilege(r.role, 'chms', p.priv)
          ORDER BY 1, 2`,
        [['public', ...ROLES]],
      );
      expect(rows).toEqual([
        { role: 'chms_app', priv: 'USAGE' },
        { role: 'chms_audit_reader', priv: 'USAGE' },
        { role: 'chms_audit_writer', priv: 'USAGE' },
        { role: 'chms_owner', priv: 'CREATE' },
        { role: 'chms_owner', priv: 'USAGE' },
      ]);
    });

    it('creates chms_owner functions without EXECUTE for PUBLIC', async () => {
      await owner.query("CREATE FUNCTION chms_test.probe() RETURNS int LANGUAGE sql AS 'SELECT 1'");
      const { rows } = await admin.query<{ fn: string; public_execute: boolean }>(
        `SELECT p.oid::regprocedure::text AS fn, has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
           FROM pg_proc p WHERE p.pronamespace IN ('chms'::regnamespace, 'chms_test'::regnamespace)
          ORDER BY 1`,
      );
      expect(rows).toEqual([
        { fn: 'chms.audit_row_change()', public_execute: false },
        { fn: 'chms.forbid_audit_change()', public_execute: false },
        { fn: 'chms_test.probe()', public_execute: false },
      ]);
    });

    it('control: a schema-scoped ALTER DEFAULT PRIVILEGES cannot revoke PUBLIC EXECUTE', async () => {
      // Why M00 uses the database-wide form instead of "... IN SCHEMA chms REVOKE ...".
      const probe = `m00_probe_${uniqueSuffix()}`;
      await admin.query(`CREATE ROLE ${probe} NOLOGIN`);
      try {
        await admin.query(`CREATE SCHEMA ${probe} AUTHORIZATION ${probe}`);
        await admin.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${probe} IN SCHEMA ${probe} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
        );
        await admin.query(`SET ROLE ${probe}`);
        await admin.query(`CREATE FUNCTION ${probe}.f() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
        await admin.query('RESET ROLE');
        const { rows } = await admin.query<{ public_execute: boolean }>(
          `SELECT has_function_privilege('public', '${probe}.f()', 'EXECUTE') AS public_execute`,
        );
        expect(rows[0]?.public_execute).toBe(true);
      } finally {
        await admin.query('RESET ROLE');
        await admin.query(`DROP SCHEMA IF EXISTS ${probe} CASCADE`);
        await admin.query(`DROP OWNED BY ${probe}`);
        await admin.query(`DROP ROLE ${probe}`);
      }
    });
  });

  describe('audit table privileges (ADR-005 decision 6; TS-F001-29, TS-F001-31)', () => {
    it('matches the privilege matrix exactly', async () => {
      const { rows } = await admin.query(
        `SELECT r.role, t.tbl, p.priv
           FROM unnest($1::text[]) AS r(role),
                unnest(ARRAY['chms.audit_events', 'chms.system_actor_categories']) AS t(tbl),
                unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) AS p(priv)
          WHERE has_table_privilege(r.role, t.tbl, p.priv)
          ORDER BY 1, 2, 3`,
        [['public', 'chms_app', 'chms_audit_reader', 'chms_audit_writer', operator]],
      );
      expect(rows).toEqual([
        { role: 'chms_audit_reader', tbl: 'chms.audit_events', priv: 'SELECT' },
        { role: 'chms_audit_reader', tbl: 'chms.system_actor_categories', priv: 'SELECT' },
        { role: 'chms_audit_writer', tbl: 'chms.audit_events', priv: 'INSERT' },
        { role: operator, tbl: 'chms.audit_events', priv: 'SELECT' },
        { role: operator, tbl: 'chms.system_actor_categories', priv: 'SELECT' },
      ]);
    });

    it('denies chms_app every operation on audit events and actor categories', async () => {
      const attempts = [
        'SELECT * FROM chms.audit_events',
        "INSERT INTO chms.audit_events (church_id, actor_kind, actor_category, action, entity_type, entity_id) VALUES (gen_random_uuid(), 'system', 'maintenance', 'create', 'campus', gen_random_uuid())",
        "UPDATE chms.audit_events SET action = 'update'",
        'DELETE FROM chms.audit_events',
        'TRUNCATE chms.audit_events',
        'SELECT * FROM chms.system_actor_categories',
        "INSERT INTO chms.system_actor_categories VALUES ('forged')",
      ];
      for (const statement of attempts) {
        expect({ statement, code: (await pgFailure(app.query(statement))).code }).toEqual({
          statement,
          code: '42501',
        });
      }
    });

    it('denies chms_app every way to bypass or disable the audit triggers', async () => {
      const attempts = [
        "SET session_replication_role = 'replica'",
        'ALTER TABLE chms.audit_events DISABLE TRIGGER ALL',
        'DROP TRIGGER audit_events_append_only ON chms.audit_events',
        'ALTER TABLE chms_test.audited DISABLE TRIGGER audited_audit',
        'DROP TRIGGER audited_audit ON chms_test.audited',
        'CREATE TRIGGER x BEFORE INSERT ON chms_test.audited FOR EACH ROW EXECUTE FUNCTION chms.forbid_audit_change()',
        'LOCK TABLE chms.audit_events IN ACCESS SHARE MODE',
      ];
      for (const statement of attempts) {
        const code = (await pgFailure(inTransaction(app, {}, () => app.query(statement)))).code;
        expect({ statement, code }).toEqual({ statement, code: '42501' });
      }
    });

    it('lets an authorized audit reader only read', async () => {
      await inTransaction(app, ACTOR, () => insertAudited(app, 'Reader Check'));
      const { rows } = await reader.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM chms.audit_events',
      );
      expect(rows[0]?.n).toBeGreaterThan(0);
      for (const statement of [
        "UPDATE chms.audit_events SET action = 'update'",
        'DELETE FROM chms.audit_events',
        'TRUNCATE chms.audit_events',
        "INSERT INTO chms.system_actor_categories VALUES ('forged')",
      ]) {
        expect((await pgFailure(reader.query(statement))).code).toBe('42501');
      }
    });

    it('blocks the owner from changing or removing audit events (CHA02)', async () => {
      await inTransaction(app, ACTOR, () => insertAudited(app, 'Owner Check'));
      for (const statement of [
        "UPDATE chms.audit_events SET action = 'update'",
        'DELETE FROM chms.audit_events',
        'TRUNCATE chms.audit_events',
      ]) {
        expect({ statement, code: (await pgFailure(owner.query(statement))).code }).toEqual({
          statement,
          code: 'CHA02',
        });
      }
    });

    it('installs only the production actor categories (POL-01)', async () => {
      const { rows } = await admin.query<{ category: string }>(
        'SELECT category FROM chms.system_actor_categories ORDER BY category',
      );
      expect(rows.map((r) => r.category)).toEqual(['bootstrap', 'maintenance']);
    });
  });

  describe('audit writer function (ADR-005 decision 2; TS-F001-30)', () => {
    it('is SECURITY DEFINER, owned by NOLOGIN chms_audit_writer, with a pinned search_path', async () => {
      const { rows } = await admin.query(
        `SELECT p.prosecdef, o.rolname AS owner, o.rolcanlogin AS owner_can_login, p.proconfig,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
                has_function_privilege('chms_app', p.oid, 'EXECUTE') AS app_execute,
                has_function_privilege('chms_owner', p.oid, 'EXECUTE') AS owner_execute,
                has_schema_privilege('chms_audit_writer', 'chms', 'CREATE') AS writer_can_create
           FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
          WHERE p.oid = 'chms.audit_row_change()'::regprocedure`,
      );
      expect(rows).toEqual([
        {
          prosecdef: true,
          owner: 'chms_audit_writer',
          owner_can_login: false,
          proconfig: ['search_path=pg_catalog, pg_temp'],
          public_execute: false,
          app_execute: false,
          owner_execute: true,
          writer_can_create: false,
        },
      ]);
    });

    it('cannot be called directly: 42501 for chms_app, 0A000 even for the owner', async () => {
      expect((await pgFailure(app.query('SELECT chms.audit_row_change()'))).code).toBe('42501');
      expect((await pgFailure(owner.query('SELECT chms.audit_row_change()'))).code).toBe('0A000');
    });

    it('fires for chms_app, which holds no EXECUTE on it', async () => {
      const id = await inTransaction(app, ACTOR, () => insertAudited(app, 'Fires For App'));
      expect(await eventsFor(id)).toHaveLength(1);
    });

    it('control run with TEMPORARY granted: a temporary audit_events table cannot capture events', async () => {
      await admin.query(`GRANT TEMPORARY ON DATABASE ${db.name} TO chms_app`);
      const attacker = await db.connectAs(db.appConfig);
      try {
        await attacker.query(
          `CREATE TEMP TABLE audit_events (church_id uuid, actor_kind text, actor_category text,
             actor_user_id uuid, action text, entity_type text, entity_id uuid, changed_fields text[])`,
        );
        await attacker.query('GRANT INSERT ON pg_temp.audit_events TO PUBLIC');
        const id = await inTransaction(attacker, ACTOR, () => insertAudited(attacker, 'Shadow'));
        const shadow = await attacker.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_temp.audit_events',
        );
        expect({ shadowed: shadow.rows[0]?.n, recorded: (await eventsFor(id)).length }).toEqual({
          shadowed: 0,
          recorded: 1,
        });
      } finally {
        await attacker.end();
        await admin.query(`REVOKE TEMPORARY ON DATABASE ${db.name} FROM chms_app`);
      }
    });
  });

  describe('audit events (ADR-005 decisions 3 and 4; TS-F001-26, TS-F001-27, TS-F001-34)', () => {
    it('records a create with a system actor, column names and no values', async () => {
      const churchId = randomUUID();
      const marker = `MARKER-${uniqueSuffix()}`;
      const id = await inTransaction(app, ACTOR, () => insertAudited(app, marker, churchId));
      const events = await eventsFor(id);
      expect(events).toEqual([
        {
          church_id: churchId,
          actor_kind: 'system',
          actor_category: 'maintenance',
          actor_user_id: null,
          action: 'create',
          entity_type: 'campus',
          entity_id: id,
          changed_fields: ['church_id', 'id', 'name', 'status'],
          xact_id: expect.any(String) as unknown,
        },
      ]);
      const { rows } = await admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM chms.audit_events e WHERE e::text LIKE $1',
        [`%${marker}%`],
      );
      expect(rows[0]?.n).toBe(0);
    });

    it('derives update, archive, unarchive and end_affiliation from the changed row', async () => {
      const id = await inTransaction(app, ACTOR, () => insertAudited(app, 'Lifecycle'));
      const update = (assignments: string) =>
        inTransaction(app, ACTOR, () =>
          app.query(
            `UPDATE chms_test.audited SET ${assignments}, row_version = row_version + 1, updated_at = now() WHERE id = $1`,
            [id],
          ),
        );
      await update("name = 'Lifecycle Renamed'");
      await update("status = 'archived'");
      await update("status = 'active'");
      await update('ended_at = now()');
      expect((await eventsFor(id)).map((e) => [e.action, e.changed_fields])).toEqual([
        ['create', ['church_id', 'id', 'name', 'status']],
        ['update', ['name']],
        ['archive', ['status']],
        ['unarchive', ['status']],
        ['end_affiliation', ['ended_at']],
      ]);
    });

    it('shares one xact_id per transaction and writes nothing on rollback', async () => {
      const [a, b] = await inTransaction(app, ACTOR, async () => [
        await insertAudited(app, 'Same Transaction A'),
        await insertAudited(app, 'Same Transaction B'),
      ]);
      const c = await inTransaction(app, ACTOR, () => insertAudited(app, 'Other Transaction'));
      const xact = async (id: string | undefined) => (await eventsFor(id ?? ''))[0]?.xact_id;
      expect(await xact(a)).toBe(await xact(b));
      expect(await xact(c)).not.toBe(await xact(a));

      const before = await auditedCount();
      await app.query('BEGIN');
      await app.query("SELECT set_config('chms.actor_category', 'maintenance', true)");
      const rolledBack = await insertAudited(app, 'Rolled Back');
      await app.query('ROLLBACK');
      expect(await eventsFor(rolledBack)).toEqual([]);
      expect(await auditedCount()).toBe(before);
    });

    it('fails closed and writes nothing without a declared actor (CHA01)', async () => {
      const before = await auditedCount();
      for (const settings of [{}, { 'chms.actor_category': '' }]) {
        const failure = await pgFailure(
          inTransaction(app, settings, () => insertAudited(app, 'No Actor')),
        );
        expect(failure.code).toBe('CHA01');
      }
      expect(await auditedCount()).toBe(before);
    });

    it('does not carry an actor into the next transaction on the same connection (TS-F001-28)', async () => {
      await inTransaction(app, ACTOR, () => insertAudited(app, 'Declared'));
      expect(
        (await pgFailure(inTransaction(app, {}, () => insertAudited(app, 'Undeclared')))).code,
      ).toBe('CHA01');
    });

    it('rejects an unknown category, a human actor kind and an actor user id', async () => {
      const cases: [Record<string, string>, string, string][] = [
        [{ 'chms.actor_category': 'forged' }, '23503', 'audit_actor_category_fk'],
        [{ ...ACTOR, 'chms.actor_kind': 'human' }, '23514', 'audit_actor_kind_ck'],
        [{ ...ACTOR, 'chms.actor_user_id': randomUUID() }, '23514', 'audit_actor_user_ck'],
      ];
      const before = await auditedCount();
      for (const [settings, code, constraint] of cases) {
        const failure = await pgFailure(
          inTransaction(app, settings, () => insertAudited(app, 'Rejected Actor')),
        );
        expect({ code: failure.code, constraint: failure.constraint }).toEqual({
          code,
          constraint,
        });
      }
      expect(await auditedCount()).toBe(before);
    });

    it('rejects a test category in a production-profile database and accepts it once test setup adds it (POL-02)', async () => {
      const testActor = { 'chms.actor_category': 'test' };
      const rejected = await pgFailure(
        inTransaction(app, testActor, () => insertAudited(app, 'Test Actor')),
      );
      expect(rejected).toMatchObject({ code: '23503', constraint: 'audit_actor_category_fk' });
      // Test-environment setup, never part of the migration chain.
      await owner.query("INSERT INTO chms.system_actor_categories VALUES ('test')");
      const id = await inTransaction(app, testActor, () => insertAudited(app, 'Test Actor'));
      expect((await eventsFor(id))[0]?.actor_category).toBe('test');
    });
  });
});
