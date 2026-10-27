import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFoundationDatabase, type FoundationDatabase } from '../support/foundation.ts';
import { backendPid, pgFailure, waitUntilBlocked } from '../support/pg-assert.ts';
import { BOOTSTRAP, firstRow, inTransaction, MAINTENANCE } from '../support/sql.ts';

/*
 * M01a: the F001 tables with identity and history immutability, audit triggers and chms_app
 * privileges, exercised by direct SQL against databases migrated through M00 and M01a
 * (database design sections 2 to 5; ADR-003, ADR-004, ADR-005, ADR-006). Services come next,
 * so these cover the database part of each TS-F001 case named in a test title.
 */

const TABLES = ['churches', 'campuses', 'people', 'person_campus_affiliations'];
const PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
  'MAINTAIN',
];

describe('M01a F001 schema', () => {
  let db: FoundationDatabase;
  let admin: pg.Client;
  let owner: pg.Client;
  let app: pg.Client;
  let churchId: string;
  let seq = 0;

  beforeAll(async () => {
    db = await createFoundationDatabase();
    admin = await db.connectAdmin();
    owner = await db.connectAs(db.ownerConfig);
    app = await db.connectAs(db.appConfig);
    // Bootstrap runs as chms_owner with actor bootstrap (ADR-003 decision 3).
    churchId = await inTransaction(owner, BOOTSTRAP, async () => {
      const church = await firstRow<{ id: string }>(
        owner,
        "INSERT INTO chms.churches (name) VALUES ('Grace Fellowship') RETURNING id",
      );
      return church.id;
    });
  });

  afterAll(async () => {
    for (const client of [app, owner, admin] as (pg.Client | undefined)[]) await client?.end();
    await db.drop();
  });

  const asApp = <T>(work: () => Promise<T>) => inTransaction(app, MAINTENANCE, work);
  const insertId = (client: pg.Client, text: string, values: unknown[]) =>
    firstRow<{ id: string }>(client, `${text} RETURNING id`, values).then((r) => r.id);

  const createCampus = (name = `Campus ${String(++seq)}`) =>
    asApp(() =>
      insertId(app, 'INSERT INTO chms.campuses (church_id, name) VALUES ($1, $2)', [
        churchId,
        name,
      ]),
    );
  const createPerson = (displayName = `Person ${String(++seq)}`) =>
    asApp(() =>
      insertId(app, 'INSERT INTO chms.people (church_id, display_name) VALUES ($1, $2)', [
        churchId,
        displayName,
      ]),
    );
  const INSERT_LINK =
    'INSERT INTO chms.person_campus_affiliations (church_id, person_id, campus_id, is_primary) VALUES ($1, $2, $3, $4)';
  const link = (personId: string, campusId: string, primary = false) =>
    asApp(() => insertId(app, INSERT_LINK, [churchId, personId, campusId, primary]));
  const END_LINK = `UPDATE chms.person_campus_affiliations
       SET ended_at = now(), end_reason = $2, person_status = NULL, campus_status = NULL,
           row_version = row_version + 1, updated_at = now()`;
  const endLink = (id: string) =>
    asApp(() => app.query(`${END_LINK} WHERE id = $1`, [id, 'ended']));
  const ARCHIVE = (table: string) =>
    `UPDATE chms.${table} SET status = 'archived', archived_at = now(), row_version = row_version + 1, updated_at = now() WHERE id = $1`;
  const UNARCHIVE = (table: string) =>
    `UPDATE chms.${table} SET status = 'active', archived_at = NULL, row_version = row_version + 1, updated_at = now() WHERE id = $1`;
  /** Person archive in one transaction (ADR-004 decision 4). */
  const archivePersonSteps = async (client: pg.Client, personId: string) => {
    await client.query(`${END_LINK} WHERE person_id = $1 AND ended_at IS NULL`, [
      personId,
      'person_archived',
    ]);
    await client.query(ARCHIVE('people'), [personId]);
  };

  interface Event {
    action: string;
    entity_type: string;
    changed_fields: string[];
    xact_id: string;
    actor_category: string;
  }
  const eventsFor = async (entityId: string) =>
    (
      await admin.query<Event>(
        `SELECT action, entity_type, changed_fields, xact_id::text AS xact_id, actor_category
           FROM chms.audit_events WHERE entity_id = $1 ORDER BY occurred_at, id`,
        [entityId],
      )
    ).rows;
  const linkRow = (id: string) =>
    firstRow<{ ended_at: Date | null; end_reason: string | null; is_primary: boolean }>(
      admin,
      'SELECT ended_at, end_reason, is_primary FROM chms.person_campus_affiliations WHERE id = $1',
      [id],
    );
  /**
   * Two chms_app sessions, each in an open transaction with the maintenance actor declared.
   * Backend PIDs are read first: a connection queues queries behind a blocked statement.
   */
  const withAppSessions = async (
    run: (t1: pg.Client, t2: pg.Client, pids: { t1: number; t2: number }) => Promise<void>,
  ) => {
    const t1 = await db.connectAs(db.appConfig);
    const t2 = await db.connectAs(db.appConfig);
    try {
      const pids = { t1: await backendPid(t1), t2: await backendPid(t2) };
      for (const t of [t1, t2]) {
        await t.query('BEGIN');
        await t.query("SELECT set_config('chms.actor_category', 'maintenance', true)");
      }
      await run(t1, t2, pids);
    } finally {
      await Promise.all([t1.end(), t2.end()]);
    }
  };
  /** Invariant probes: no active affiliation joins an archived campus or an archived person. */
  const probes = () =>
    firstRow<{ campus: number; person: number }>(
      admin,
      `SELECT
         (SELECT count(*)::int FROM chms.person_campus_affiliations a JOIN chms.campuses c ON c.id = a.campus_id
           WHERE a.ended_at IS NULL AND c.status = 'archived') AS campus,
         (SELECT count(*)::int FROM chms.person_campus_affiliations a JOIN chms.people p ON p.id = a.person_id
           WHERE a.ended_at IS NULL AND p.status = 'archived') AS person`,
    );

  describe('migrations and catalog (TS-F001-35)', () => {
    it('applies M00 and both M01a migrations in order; a second run changes nothing', async () => {
      const applied = async () =>
        (
          await admin.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
          )
        ).rows[0]?.n;
      expect(await applied()).toBe(3);
      const rerun = await db.connectAs(db.ownerConfig);
      try {
        await migrate(drizzle(rerun), { migrationsFolder: 'drizzle' });
      } finally {
        await rerun.end();
      }
      expect(await applied()).toBe(3);
    });

    it('installs exactly the designed triggers', async () => {
      const { rows } = await admin.query<{ def: string }>(
        `SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE c.relnamespace = 'chms'::regnamespace AND NOT t.tgisinternal ORDER BY c.relname, t.tgname`,
      );
      const row = 'FOR EACH ROW EXECUTE FUNCTION chms';
      expect(rows.map((r) => r.def)).toEqual([
        `CREATE TRIGGER audit_events_append_only BEFORE DELETE OR UPDATE ON chms.audit_events ${row}.forbid_audit_change()`,
        'CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON chms.audit_events FOR EACH STATEMENT EXECUTE FUNCTION chms.forbid_audit_change()',
        `CREATE TRIGGER campuses_audit AFTER INSERT OR UPDATE ON chms.campuses ${row}.audit_row_change('campus')`,
        `CREATE TRIGGER campuses_identity BEFORE UPDATE ON chms.campuses ${row}.forbid_identity_change('id', 'church_id')`,
        `CREATE TRIGGER churches_audit AFTER INSERT OR UPDATE ON chms.churches ${row}.audit_row_change('church')`,
        `CREATE TRIGGER churches_identity BEFORE UPDATE ON chms.churches ${row}.forbid_identity_change('id')`,
        `CREATE TRIGGER people_audit AFTER INSERT OR UPDATE ON chms.people ${row}.audit_row_change('person')`,
        `CREATE TRIGGER people_identity BEFORE UPDATE ON chms.people ${row}.forbid_identity_change('id', 'church_id')`,
        `CREATE TRIGGER pca_audit AFTER INSERT OR UPDATE ON chms.person_campus_affiliations ${row}.audit_row_change('person_campus_affiliation')`,
        'CREATE TRIGGER pca_history BEFORE UPDATE ON chms.person_campus_affiliations FOR EACH ROW WHEN ((old.ended_at IS NOT NULL)) EXECUTE FUNCTION chms.forbid_history_change()',
        `CREATE TRIGGER pca_identity BEFORE UPDATE ON chms.person_campus_affiliations ${row}.forbid_identity_change('id', 'church_id', 'person_id', 'campus_id')`,
      ]);
    });

    it('ties every audit event to the church (audit_church_fk)', async () => {
      const { rows } = await admin.query<{ def: string }>(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'audit_church_fk'",
      );
      expect(rows).toEqual([
        {
          def: 'FOREIGN KEY (church_id) REFERENCES chms.churches(id) ON UPDATE RESTRICT ON DELETE RESTRICT',
        },
      ]);
    });
  });

  describe('privileges (database design section 5; TS-F001-31)', () => {
    it('grants chms_app SELECT only at table level, and nothing to PUBLIC, the writer or the reader', async () => {
      const { rows } = await admin.query(
        `SELECT r.role, t.tbl, p.priv
           FROM unnest(ARRAY['public', 'chms_app', 'chms_audit_writer', 'chms_audit_reader']) AS r(role),
                unnest($1::text[]) AS t(tbl), unnest($2::text[]) AS p(priv)
          WHERE has_table_privilege(r.role, 'chms.' || t.tbl, p.priv)
          ORDER BY 1, 2, 3`,
        [TABLES, PRIVILEGES],
      );
      expect(rows).toEqual(
        [...TABLES].sort().map((tbl) => ({ role: 'chms_app', tbl, priv: 'SELECT' })),
      );
    });

    it('grants chms_app exactly the designed column-level INSERT and UPDATE privileges', async () => {
      const { rows } = await admin.query<{ tbl: string; priv: string; columns: string[] }>(
        `SELECT c.table_name AS tbl, p.priv, array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns
           FROM information_schema.columns c, unnest(ARRAY['INSERT', 'UPDATE']) AS p(priv)
          WHERE c.table_schema = 'chms' AND c.table_name = ANY($1)
            AND has_column_privilege('chms_app', 'chms.' || c.table_name, c.column_name, p.priv)
          GROUP BY 1, 2 ORDER BY 1, 2`,
        [TABLES],
      );
      expect(rows).toEqual([
        { tbl: 'campuses', priv: 'INSERT', columns: ['church_id', 'name'] },
        {
          tbl: 'campuses',
          priv: 'UPDATE',
          columns: ['name', 'status', 'archived_at', 'row_version', 'updated_at'],
        },
        { tbl: 'churches', priv: 'UPDATE', columns: ['name', 'row_version', 'updated_at'] },
        {
          tbl: 'people',
          priv: 'INSERT',
          columns: ['church_id', 'display_name', 'given_name', 'family_name'],
        },
        {
          tbl: 'people',
          priv: 'UPDATE',
          columns: [
            'display_name',
            'given_name',
            'family_name',
            'status',
            'archived_at',
            'row_version',
            'updated_at',
          ],
        },
        {
          tbl: 'person_campus_affiliations',
          priv: 'INSERT',
          columns: ['church_id', 'person_id', 'campus_id', 'is_primary'],
        },
        {
          tbl: 'person_campus_affiliations',
          priv: 'UPDATE',
          columns: [
            'is_primary',
            'person_status',
            'campus_status',
            'ended_at',
            'end_reason',
            'row_version',
            'updated_at',
          ],
        },
      ]);
    });

    it('denies chms_app DELETE and TRUNCATE on every F001 table (TS-F001-23)', async () => {
      for (const table of TABLES) {
        for (const statement of [`DELETE FROM chms.${table}`, `TRUNCATE chms.${table}`]) {
          expect({ statement, code: (await pgFailure(app.query(statement))).code }).toEqual({
            statement,
            code: '42501',
          });
        }
      }
    });
  });

  describe('church (BR-01, BR-09; TS-F001-03, TS-F001-04)', () => {
    it('allows one church only: chms_app cannot insert one, and a second fails churches_singleton_uq', async () => {
      expect(
        (
          await pgFailure(
            asApp(() => app.query("INSERT INTO chms.churches (name) VALUES ('Second Church')")),
          )
        ).code,
      ).toBe('42501');
      expect(
        await pgFailure(
          inTransaction(owner, BOOTSTRAP, () =>
            owner.query("INSERT INTO chms.churches (name) VALUES ('Second Church')"),
          ),
        ),
      ).toMatchObject({ code: '23505', constraint: 'churches_singleton_uq' });
    });

    it('audits the bootstrap insert as system/bootstrap/create', async () => {
      expect(await eventsFor(churchId)).toEqual([
        expect.objectContaining({
          action: 'create',
          entity_type: 'church',
          actor_category: 'bootstrap',
        }) as unknown,
      ]);
    });

    it('renames the church with one audit event recording only {name}', async () => {
      await asApp(() =>
        app.query(
          "UPDATE chms.churches SET name = 'Grace Fellowship Church', row_version = row_version + 1, updated_at = now() WHERE id = $1",
          [churchId],
        ),
      );
      const events = await eventsFor(churchId);
      expect(events.at(-1)).toMatchObject({
        action: 'update',
        changed_fields: ['name'],
        actor_category: 'maintenance',
      });
    });
  });

  describe('identity immutability (ADR-003 decision 4; TS-F001-04, TS-F001-05)', () => {
    it('rejects identity changes with 42501 for chms_app and CHI01 for the owner', async () => {
      const campusId = await createCampus();
      const personId = await createPerson();
      const linkId = await link(personId, campusId);
      const other = await createCampus();
      const attempts: [string, string, string][] = [
        ['churches', 'id', churchId],
        ['campuses', 'id', campusId],
        ['campuses', 'church_id', campusId],
        ['people', 'id', personId],
        ['people', 'church_id', personId],
        ['person_campus_affiliations', 'id', linkId],
        ['person_campus_affiliations', 'church_id', linkId],
        ['person_campus_affiliations', 'person_id', linkId],
        ['person_campus_affiliations', 'campus_id', linkId],
      ];
      for (const [table, column, id] of attempts) {
        const value = column === 'campus_id' ? other : 'ffffffff-ffff-7fff-bfff-ffffffffffff';
        const statement = `UPDATE chms.${table} SET ${column} = $2 WHERE id = $1`;
        const asAppCode = (await pgFailure(asApp(() => app.query(statement, [id, value])))).code;
        const asOwnerCode = (
          await pgFailure(
            inTransaction(owner, MAINTENANCE, () => owner.query(statement, [id, value])),
          )
        ).code;
        expect({ table, column, asAppCode, asOwnerCode }).toEqual({
          table,
          column,
          asAppCode: '42501',
          asOwnerCode: 'CHI01',
        });
      }
    });

    it('rejects an id supplied by chms_app and generates UUIDv7 ids (TS-F001-13)', async () => {
      expect(
        (
          await pgFailure(
            asApp(() =>
              app.query(
                'INSERT INTO chms.people (id, church_id, display_name) VALUES (uuidv7(), $1, $2)',
                [churchId, 'Supplied Id'],
              ),
            ),
          )
        ).code,
      ).toBe('42501');
      const personId = await createPerson('Display Name Only');
      const { version } = await firstRow<{ version: number }>(
        admin,
        'SELECT uuid_extract_version(id) AS version FROM chms.people WHERE id = $1',
        [personId],
      );
      expect(version).toBe(7);
    });

    it('keeps people independent of accounts (BR-02; TS-F001-13)', async () => {
      const { rows } = await admin.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'chms' AND table_name = 'people' ORDER BY ordinal_position",
      );
      expect(rows.map((r) => r.column_name)).toEqual([
        'id',
        'church_id',
        'display_name',
        'given_name',
        'family_name',
        'status',
        'archived_at',
        'row_version',
        'created_at',
        'updated_at',
      ]);
    });
  });

  describe('names (BR-07, BR-08, PPD-01; TS-F001-06, TS-F001-15)', () => {
    it('rejects case variants of a campus name, archived names included', async () => {
      const north = await createCampus('North');
      expect(await pgFailure(createCampus('NORTH'))).toMatchObject({
        code: '23505',
        constraint: 'campuses_name_ci_uq',
      });
      await asApp(() => app.query(ARCHIVE('campuses'), [north]));
      expect(await pgFailure(createCampus('north'))).toMatchObject({
        code: '23505',
        constraint: 'campuses_name_ci_uq',
      });
      const south = await createCampus('South');
      expect(
        await pgFailure(
          asApp(() => app.query("UPDATE chms.campuses SET name = 'nOrTh' WHERE id = $1", [south])),
        ),
      ).toMatchObject({ code: '23505', constraint: 'campuses_name_ci_uq' });
    });

    it('enforces the name rules on display names, name parts and the church name', async () => {
      const personId = await createPerson();
      const cases: [string, string, string, string][] = [
        ['people', 'display_name', '', 'people_display_name_ck'],
        ['people', 'display_name', ' Leading', 'people_display_name_ck'],
        ['people', 'display_name', 'x'.repeat(101), 'people_display_name_ck'],
        ['people', 'given_name', '', 'people_given_name_ck'],
        ['people', 'given_name', 'Tab\tInside', 'people_given_name_ck'],
        ['people', 'family_name', 'Trailing ', 'people_family_name_ck'],
        ['churches', 'name', '', 'churches_name_ck'],
      ];
      for (const [table, column, value, constraint] of cases) {
        const id = table === 'churches' ? churchId : personId;
        const failure = await pgFailure(
          asApp(() =>
            app.query(`UPDATE chms.${table} SET ${column} = $2 WHERE id = $1`, [id, value]),
          ),
        );
        expect({ column, value, code: failure.code, constraint: failure.constraint }).toEqual({
          column,
          value,
          code: '23514',
          constraint,
        });
      }
      await asApp(() =>
        app.query('UPDATE chms.people SET given_name = $2, family_name = NULL WHERE id = $1', [
          personId,
          'Ada',
        ]),
      );
    });
  });

  describe('affiliations (BR-03; TS-F001-16, TS-F001-17)', () => {
    it('allows zero or several links, one active pair and one active primary', async () => {
      const personId = await createPerson();
      const [a, b] = [await createCampus(), await createCampus()];
      const primary = await link(personId, a, true);
      await link(personId, b);
      expect(await pgFailure(link(personId, a))).toMatchObject({
        code: '23505',
        constraint: 'pca_active_pair_uq',
      });
      const c = await createCampus();
      expect(await pgFailure(link(personId, c, true))).toMatchObject({
        code: '23505',
        constraint: 'pca_active_primary_uq',
      });
      await endLink(primary);
      const relinked = await link(personId, a, true);
      expect(relinked).not.toBe(primary);
      expect(await linkRow(primary)).toMatchObject({ end_reason: 'ended', is_primary: true });
    });

    it('lets only one of two concurrent "set primary" updates win', async () => {
      const personId = await createPerson();
      const a = await link(personId, await createCampus());
      const b = await link(personId, await createCampus());
      const setPrimary =
        'UPDATE chms.person_campus_affiliations SET is_primary = true WHERE id = $1';
      await withAppSessions(async (t1, t2, pids) => {
        await t1.query(setPrimary, [a]);
        const second = pgFailure(t2.query(setPrimary, [b]));
        await waitUntilBlocked(admin, pids.t2, pids.t1);
        await t1.query('COMMIT');
        expect(await second).toMatchObject({ code: '23505', constraint: 'pca_active_primary_uq' });
        await t2.query('ROLLBACK');
      });
    });
  });

  describe('archiving (BR-04 to BR-06; TS-F001-08, 09, 11, 18, 21, 22, 23)', () => {
    it('blocks campus archival while links are active (23001), then allows it', async () => {
      const campusId = await createCampus();
      const linkId = await link(await createPerson(), campusId);
      expect(
        await pgFailure(asApp(() => app.query(ARCHIVE('campuses'), [campusId]))),
      ).toMatchObject({ code: '23001', constraint: 'pca_campus_active_fk' });
      await endLink(linkId);
      await asApp(() => app.query(ARCHIVE('campuses'), [campusId]));
      expect((await eventsFor(campusId)).map((e) => e.action)).toEqual(['create', 'archive']);
    });

    it('rejects a link to an archived campus (23503)', async () => {
      const campusId = await createCampus();
      await asApp(() => app.query(ARCHIVE('campuses'), [campusId]));
      expect(await pgFailure(link(await createPerson(), campusId))).toMatchObject({
        code: '23503',
        constraint: 'pca_campus_active_fk',
      });
    });

    it('archives a person atomically: links ended, primary kept, three events in one transaction', async () => {
      const personId = await createPerson();
      const l1 = await link(personId, await createCampus(), true);
      const l2 = await link(personId, await createCampus());
      await asApp(() => archivePersonSteps(app, personId));
      expect(await linkRow(l1)).toMatchObject({ end_reason: 'person_archived', is_primary: true });
      expect(await linkRow(l2)).toMatchObject({ end_reason: 'person_archived', is_primary: false });
      const events = [
        ...(await eventsFor(l1)),
        ...(await eventsFor(l2)),
        ...(await eventsFor(personId)),
      ].filter((e) => e.action !== 'create');
      expect(events.map((e) => e.action).sort()).toEqual([
        'archive',
        'end_affiliation',
        'end_affiliation',
      ]);
      expect(new Set(events.map((e) => e.xact_id)).size).toBe(1);
      expect(await probes()).toEqual({ campus: 0, person: 0 });
    });

    it('unarchives a person without restoring links; re-linking creates a new row (TS-F001-22)', async () => {
      const personId = await createPerson();
      const campusId = await createCampus();
      const original = await link(personId, campusId);
      await asApp(() => archivePersonSteps(app, personId));
      await asApp(() => app.query(UNARCHIVE('people'), [personId]));
      const active = await firstRow<{ n: number }>(
        admin,
        'SELECT count(*)::int AS n FROM chms.person_campus_affiliations WHERE person_id = $1 AND ended_at IS NULL',
        [personId],
      );
      expect(active.n).toBe(0);
      expect(await linkRow(original)).toMatchObject({ end_reason: 'person_archived' });
      expect(await link(personId, campusId)).not.toBe(original);
      expect((await eventsFor(personId)).map((e) => e.action)).toEqual([
        'create',
        'archive',
        'unarchive',
      ]);
    });

    it('keeps ended affiliations immutable for every role (CHH01)', async () => {
      const linkId = await link(await createPerson(), await createCampus(), true);
      await endLink(linkId);
      for (const assignment of [
        'is_primary = false',
        "end_reason = 'person_archived'",
        'ended_at = now()',
      ]) {
        const statement = `UPDATE chms.person_campus_affiliations SET ${assignment} WHERE id = $1`;
        expect((await pgFailure(asApp(() => app.query(statement, [linkId])))).code).toBe('CHH01');
        expect(
          (
            await pgFailure(
              inTransaction(owner, MAINTENANCE, () => owner.query(statement, [linkId])),
            )
          ).code,
        ).toBe('CHH01');
      }
    });

    it('TS-F001-11 on the real contract: a blocked campus archive fails with 23001 once the link commits', async () => {
      const campusId = await createCampus();
      const personId = await createPerson();
      await withAppSessions(async (t1, t2, pids) => {
        await t2.query(INSERT_LINK, [churchId, personId, campusId, false]);
        const archive = pgFailure(t1.query(ARCHIVE('campuses'), [campusId]));
        await waitUntilBlocked(admin, pids.t1, pids.t2);
        await t2.query('COMMIT');
        expect(await archive).toMatchObject({ code: '23001', constraint: 'pca_campus_active_fk' });
        await t1.query('ROLLBACK');
      });
      expect(await probes()).toEqual({ campus: 0, person: 0 });
    });

    it('TS-F001-21 on the real contract: a link insert blocked by a person archive fails with 23503', async () => {
      const personId = await createPerson();
      await link(personId, await createCampus());
      const campusId = await createCampus();
      await withAppSessions(async (t1, t2, pids) => {
        await archivePersonSteps(t1, personId);
        const insert = pgFailure(t2.query(INSERT_LINK, [churchId, personId, campusId, false]));
        await waitUntilBlocked(admin, pids.t2, pids.t1);
        await t1.query('COMMIT');
        expect(await insert).toMatchObject({ code: '23503', constraint: 'pca_person_active_fk' });
        await t2.query('ROLLBACK');
      });
      expect(await probes()).toEqual({ campus: 0, person: 0 });
    });
  });

  describe('audit on F001 tables (POL-01; TS-F001-26, TS-F001-27, TS-F001-34)', () => {
    it('writes one event per changed row with names only, and none without an actor or on rollback', async () => {
      const marker = `Marker ${String(++seq)}`;
      const personId = await createPerson(marker);
      await asApp(() =>
        app.query(
          'UPDATE chms.people SET given_name = $2, row_version = row_version + 1, updated_at = now() WHERE id = $1',
          [personId, `${marker} Given`],
        ),
      );
      // Only row_version and updated_at are excluded from changed_fields (design section 7).
      expect((await eventsFor(personId)).map((e) => [e.action, e.changed_fields])).toEqual([
        ['create', ['church_id', 'created_at', 'display_name', 'id', 'status']],
        ['update', ['given_name']],
      ]);
      const leaked = await firstRow<{ n: number }>(
        admin,
        'SELECT count(*)::int AS n FROM chms.audit_events e WHERE e::text LIKE $1',
        [`%${marker}%`],
      );
      expect(leaked.n).toBe(0);
      expect(
        (await pgFailure(inTransaction(app, {}, () => app.query(ARCHIVE('people'), [personId]))))
          .code,
      ).toBe('CHA01');
      await app.query('BEGIN');
      await app.query("SELECT set_config('chms.actor_category', 'maintenance', true)");
      await app.query(ARCHIVE('people'), [personId]);
      await app.query('ROLLBACK');
      expect(await eventsFor(personId)).toHaveLength(2);
    });
  });
});
