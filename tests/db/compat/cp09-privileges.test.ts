import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectAdmin,
  createTestDatabase,
  roleConfig,
  uniqueSuffix,
  type TestDatabase,
} from '../../support/cluster.ts';
import { pgFailure } from '../../support/pg-assert.ts';

/*
 * CP-09: PostgreSQL 18 privilege behaviour that ADR-005 and ADR-006 rely on, proven with
 * throwaway probe roles. The full privilege matrix (TS-F001-29 to TS-F001-31) runs against
 * the real roles once M00 exists.
 */
describe('CP-09 privilege behaviour', () => {
  const suffix = uniqueSuffix();
  const owner = `cp09_owner_${suffix}`;
  const app = `cp09_app_${suffix}`;
  const appPassword = uniqueSuffix() + uniqueSuffix();
  let db: TestDatabase;
  let admin: pg.Client;
  let asApp: pg.Client | undefined;

  const appClient = () => {
    if (!asApp) throw new Error('application role connection not established');
    return asApp;
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = await db.connectAdmin();
    await admin.query(`CREATE ROLE ${owner} NOLOGIN`);
    await admin.query(
      `CREATE ROLE ${app} LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    await admin.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${db.name} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${db.name} TO ${app}`);
    await admin.query(`CREATE SCHEMA app AUTHORIZATION ${owner}`);
    await admin.query(`SET ROLE ${owner}`);
    await admin.query('CREATE TABLE app.t (id int PRIMARY KEY, a text, b text)');
    await admin.query('CREATE TABLE app.audit (note text)');
    await admin.query(
      'CREATE FUNCTION app.trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
    );
    await admin.query(
      'CREATE TRIGGER t_trg BEFORE INSERT ON app.t FOR EACH ROW EXECUTE FUNCTION app.trg()',
    );
    // Definer functions that read an unqualified catalog name and an unqualified schema name.
    // Bodies are not validated at creation: `audit` is deliberately unresolvable until shadowed.
    await admin.query('SET check_function_bodies = off');
    for (const [name, searchPath, from] of [
      ['catalog_without_pg_temp', 'pg_catalog', 'pg_class'],
      ['catalog_with_pg_temp_last', 'pg_catalog, pg_temp', 'pg_class'],
      ['unqualified_with_pg_temp_last', 'pg_catalog, pg_temp', 'audit'],
      ['qualified_with_pg_temp_last', 'pg_catalog, pg_temp', 'app.audit'],
    ] as const) {
      const column = from === 'pg_class' ? 'relname' : 'note';
      await admin.query(
        `CREATE FUNCTION app.${name}() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = ${searchPath} AS $$ SELECT string_agg(${column}::text, ',') FROM ${from} WHERE ${column}::text = 'shadowed' $$`,
      );
    }
    await admin.query('RESET check_function_bodies');
    await admin.query(`GRANT USAGE ON SCHEMA app TO ${app}`);
    await admin.query(`GRANT SELECT ON app.t TO ${app}`);
    await admin.query(`GRANT INSERT (id, a), UPDATE (a, b) ON app.t TO ${app}`);
    await admin.query('RESET ROLE');
    asApp = new pg.Client(roleConfig(db.name, app, appPassword));
    await asApp.connect();
  });

  afterAll(async () => {
    await asApp?.end();
    await admin.end();
    await db.drop();
    const cluster = await connectAdmin();
    try {
      await cluster.query(`DROP ROLE IF EXISTS ${app}`);
      await cluster.query(`DROP ROLE IF EXISTS ${owner}`);
    } finally {
      await cluster.end();
    }
  });

  it('allows only ACCESS SHARE to a role with SELECT plus column-level INSERT and UPDATE grants', async () => {
    const modes = [
      'ACCESS SHARE',
      'ROW SHARE',
      'ROW EXCLUSIVE',
      'SHARE UPDATE EXCLUSIVE',
      'SHARE',
      'SHARE ROW EXCLUSIVE',
      'EXCLUSIVE',
      'ACCESS EXCLUSIVE',
    ];
    const observed: Record<string, string> = {};
    for (const mode of modes) {
      await appClient().query('BEGIN');
      try {
        await appClient().query(`LOCK TABLE app.t IN ${mode} MODE NOWAIT`);
        observed[mode] = 'granted';
      } catch (error) {
        observed[mode] = error instanceof pg.DatabaseError ? (error.code ?? '?') : String(error);
      } finally {
        await appClient().query('ROLLBACK');
      }
    }
    expect(observed).toEqual({
      'ACCESS SHARE': 'granted',
      'ROW SHARE': '42501',
      'ROW EXCLUSIVE': '42501',
      'SHARE UPDATE EXCLUSIVE': '42501',
      SHARE: '42501',
      'SHARE ROW EXCLUSIVE': '42501',
      EXCLUSIVE: '42501',
      'ACCESS EXCLUSIVE': '42501',
    });
  });

  it('denies the trigger-bypass, truncate and delete paths to the application role', async () => {
    const attempts = {
      'SET session_replication_role': "SET session_replication_role = 'replica'",
      'ALTER TABLE DISABLE TRIGGER': 'ALTER TABLE app.t DISABLE TRIGGER ALL',
      'CREATE TRIGGER':
        'CREATE TRIGGER x BEFORE INSERT ON app.t FOR EACH ROW EXECUTE FUNCTION app.trg()',
      'DROP TRIGGER': 'DROP TRIGGER t_trg ON app.t',
      TRUNCATE: 'TRUNCATE app.t',
      DELETE: 'DELETE FROM app.t',
      'CREATE TEMP TABLE (TEMPORARY revoked from PUBLIC)': 'CREATE TEMP TABLE x (i int)',
      'INSERT a column without a grant': "INSERT INTO app.t (id, b) VALUES (1, 'x')",
    };
    const observed: Record<string, string | undefined> = {};
    for (const [label, statement] of Object.entries(attempts)) {
      observed[label] = (await pgFailure(appClient().query(statement))).code;
    }
    expect(observed).toEqual(Object.fromEntries(Object.keys(attempts).map((k) => [k, '42501'])));
  });

  it('rejects a direct call of a trigger function', async () => {
    expect(await pgFailure(appClient().query('SELECT app.trg()'))).toMatchObject({ code: '0A000' });
  });

  it('denies EXECUTE once it is revoked from PUBLIC', async () => {
    await admin.query('REVOKE EXECUTE ON FUNCTION app.qualified_with_pg_temp_last() FROM PUBLIC');
    expect(
      await pgFailure(appClient().query('SELECT app.qualified_with_pg_temp_last()')),
    ).toMatchObject({ code: '42501' });
    await admin.query('GRANT EXECUTE ON FUNCTION app.qualified_with_pg_temp_last() TO PUBLIC');
  });

  it('control run with TEMPORARY granted: pg_temp listed last protects catalog names; only schema qualification protects other names', async () => {
    await admin.query(`GRANT TEMPORARY ON DATABASE ${db.name} TO ${app}`);
    const shadowing = new pg.Client(roleConfig(db.name, app, appPassword));
    await shadowing.connect();
    try {
      // An attacker makes its temporary tables readable to the definer.
      await shadowing.query('CREATE TEMP TABLE pg_class (relname text)');
      await shadowing.query("INSERT INTO pg_temp.pg_class VALUES ('shadowed')");
      await shadowing.query('GRANT SELECT ON pg_temp.pg_class TO PUBLIC');
      await shadowing.query('CREATE TEMP TABLE audit (note text)');
      await shadowing.query("INSERT INTO pg_temp.audit VALUES ('shadowed')");
      await shadowing.query('GRANT SELECT ON pg_temp.audit TO PUBLIC');
      const call = async (fn: string) =>
        (await shadowing.query<{ r: string | null }>(`SELECT app.${fn}() AS r`)).rows[0]?.r;
      expect({
        catalog_without_pg_temp: await call('catalog_without_pg_temp'),
        catalog_with_pg_temp_last: await call('catalog_with_pg_temp_last'),
        unqualified_with_pg_temp_last: await call('unqualified_with_pg_temp_last'),
        qualified_with_pg_temp_last: await call('qualified_with_pg_temp_last'),
      }).toEqual({
        catalog_without_pg_temp: 'shadowed', // revision 2's setting (SR-01): hijacked
        catalog_with_pg_temp_last: null, // ADR-005 setting protects catalog names
        unqualified_with_pg_temp_last: 'shadowed', // search_path alone is not enough
        qualified_with_pg_temp_last: null, // ADR-005 also requires schema qualification
      });
    } finally {
      await shadowing.end();
      await admin.query(`REVOKE TEMPORARY ON DATABASE ${db.name} FROM ${app}`);
    }
  });

  it('refuses a role-level actor default to an ordinary role; a session-level SET still persists (ADR-005)', async () => {
    // Role-level defaults for placeholder parameters such as chms.* need superuser.
    expect(
      await pgFailure(
        appClient().query(`ALTER ROLE ${app} SET chms.actor_category = 'maintenance'`),
      ),
    ).toMatchObject({ code: '42501' });
    const { rows } = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_db_role_setting WHERE setrole = $1::regrole',
      [app],
    );
    expect(rows[0]?.n).toBe(0);

    const session = new pg.Client(roleConfig(db.name, app, appPassword));
    await session.connect();
    const actor = async () =>
      (
        await session.query<{ v: string | null }>(
          "SELECT current_setting('chms.actor_category', true) AS v",
        )
      ).rows[0]?.v;
    try {
      // set_config(..., true) works for the ordinary role and stays transaction-local.
      await session.query('BEGIN');
      await session.query("SELECT set_config('chms.actor_category', 'bootstrap', true)");
      const declared = await actor();
      await session.query('COMMIT');
      expect({ declared, after: await actor() }).toEqual({ declared: 'bootstrap', after: '' });
      // A session-level SET survives into later transactions: the documented limitation.
      await session.query("SET chms.actor_category = 'maintenance'");
      await session.query('BEGIN');
      const inherited = await actor();
      await session.query('COMMIT');
      expect(inherited).toBe('maintenance');
    } finally {
      await session.end();
    }
  });
});
