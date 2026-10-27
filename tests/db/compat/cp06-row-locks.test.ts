import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../support/cluster.ts';
import { applyF001Schema } from '../../support/f001-schema.ts';
import { backendPid, pgFailure, waitUntilBlocked } from '../../support/pg-assert.ts';

/*
 * CP-06: the row-lock behaviour that ADR-004's status-carrying foreign keys rely on, at the
 * SQL level (no services exist yet). Each interleaving is confirmed with pg_blocking_pids().
 * Test cases TS-F001-10, 11, 12, 20 and 21 from the test matrix.
 *
 * Observed SQLSTATEs: an INSERT referencing an archived row fails with 23503
 * (foreign_key_violation); an UPDATE archiving a still-referenced row fails with 23001
 * (restrict_violation, from ON UPDATE RESTRICT). The design predicted 23503 for both.
 */

const INSERT_LINK =
  'INSERT INTO chms.person_campus_affiliations (church_id, person_id, campus_id) VALUES ($1, $2, $3)';
const ARCHIVE_CAMPUS =
  "UPDATE chms.campuses SET status = 'archived', archived_at = now(), row_version = row_version + 1 WHERE id = $1";
const END_PERSON_LINKS =
  "UPDATE chms.person_campus_affiliations SET ended_at = now(), end_reason = 'person_archived', person_status = NULL, campus_status = NULL, row_version = row_version + 1 WHERE person_id = $1 AND ended_at IS NULL";
const ARCHIVE_PERSON =
  "UPDATE chms.people SET status = 'archived', archived_at = now(), row_version = row_version + 1 WHERE id = $1";

describe('CP-06 row-lock behaviour of status-carrying foreign keys', () => {
  let db: TestDatabase;
  let admin: pg.Client;
  let churchId: string;
  let seq = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = await db.connectAdmin();
    await applyF001Schema(admin);
    const { rows } = await admin.query<{ id: string }>(
      "INSERT INTO chms.churches (name) VALUES ('Grace Fellowship') RETURNING id",
    );
    churchId = rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await admin.end();
    await db.drop();
  });

  const insertReturningId = async (text: string, values: unknown[]) => {
    const { rows } = await admin.query<{ id: string }>(text, values);
    const id = rows[0]?.id;
    if (!id) throw new Error('INSERT returned no id');
    return id;
  };
  const campus = () =>
    insertReturningId('INSERT INTO chms.campuses (church_id, name) VALUES ($1, $2) RETURNING id', [
      churchId,
      `Campus ${String(++seq)}`,
    ]);
  const person = () =>
    insertReturningId(
      'INSERT INTO chms.people (church_id, display_name) VALUES ($1, $2) RETURNING id',
      [churchId, `Person ${String(++seq)}`],
    );
  const link = (personId: string, campusId: string) =>
    insertReturningId(`${INSERT_LINK} RETURNING id`, [churchId, personId, campusId]);

  /** Invariant probes: no active affiliation joins an archived campus or an archived person. */
  const probes = async () => {
    const { rows } = await admin.query<{ campus: number; person: number }>(
      `SELECT
         (SELECT count(*)::int FROM chms.person_campus_affiliations a
            JOIN chms.campuses c ON c.id = a.campus_id
           WHERE a.ended_at IS NULL AND c.status = 'archived') AS campus,
         (SELECT count(*)::int FROM chms.person_campus_affiliations a
            JOIN chms.people p ON p.id = a.person_id
           WHERE a.ended_at IS NULL AND p.status = 'archived') AS person`,
    );
    return rows[0];
  };

  const withSessions = async (
    run: (t1: pg.Client, t2: pg.Client, pids: { t1: number; t2: number }) => Promise<void>,
  ) => {
    const t1 = new pg.Client(db.adminConfig);
    const t2 = new pg.Client(db.adminConfig);
    await Promise.all([t1.connect(), t2.connect()]);
    try {
      await run(t1, t2, { t1: await backendPid(t1), t2: await backendPid(t2) });
    } finally {
      await Promise.all([t1.end(), t2.end()]);
    }
  };

  it('TS-F001-10: archive first; the link insert is blocked and fails with 23503 after the archive commits', async () => {
    const [c, p] = await Promise.all([campus(), person()]);
    await withSessions(async (t1, t2, pids) => {
      await t1.query('BEGIN');
      await t1.query(ARCHIVE_CAMPUS, [c]);
      await t2.query('BEGIN');
      const insert = pgFailure(t2.query(INSERT_LINK, [churchId, p, c]));
      await waitUntilBlocked(admin, pids.t2, pids.t1);
      await t1.query('COMMIT');
      expect(await insert).toMatchObject({ code: '23503', constraint: 'pca_campus_active_fk' });
      await t2.query('ROLLBACK');
    });
    expect(await probes()).toEqual({ campus: 0, person: 0 });
  });

  it('TS-F001-11: link first; the archive is blocked and fails with 23001 after the link commits', async () => {
    const [c, p] = await Promise.all([campus(), person()]);
    await withSessions(async (t1, t2, pids) => {
      await t2.query('BEGIN');
      await t2.query(INSERT_LINK, [churchId, p, c]);
      await t1.query('BEGIN');
      const archive = pgFailure(t1.query(ARCHIVE_CAMPUS, [c]));
      await waitUntilBlocked(admin, pids.t1, pids.t2);
      await t2.query('COMMIT');
      // ON UPDATE RESTRICT raises restrict_violation (23001); the design predicted 23503.
      expect(await archive).toMatchObject({ code: '23001', constraint: 'pca_campus_active_fk' });
      await t1.query('ROLLBACK');
    });
    expect(await probes()).toEqual({ campus: 0, person: 0 });
  });

  it('TS-F001-11 (rollback variant): the blocked archive succeeds when the link insert rolls back', async () => {
    const [c, p] = await Promise.all([campus(), person()]);
    await withSessions(async (t1, t2, pids) => {
      await t2.query('BEGIN');
      await t2.query(INSERT_LINK, [churchId, p, c]);
      await t1.query('BEGIN');
      const archive = t1.query(ARCHIVE_CAMPUS, [c]);
      await waitUntilBlocked(admin, pids.t1, pids.t2);
      await t2.query('ROLLBACK');
      expect((await archive).rowCount).toBe(1);
      await t1.query('COMMIT');
    });
    const { rows } = await admin.query<{ status: string }>(
      'SELECT status FROM chms.campuses WHERE id = $1',
      [c],
    );
    expect(rows[0]?.status).toBe('archived');
    expect(await probes()).toEqual({ campus: 0, person: 0 });
  });

  it('TS-F001-12 (TS-F001-10 at REPEATABLE READ): the blocked insert loses with 40001', async () => {
    const [c, p] = await Promise.all([campus(), person()]);
    await withSessions(async (t1, t2, pids) => {
      await t1.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await t1.query(ARCHIVE_CAMPUS, [c]);
      await t2.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const insert = pgFailure(t2.query(INSERT_LINK, [churchId, p, c]));
      await waitUntilBlocked(admin, pids.t2, pids.t1);
      await t1.query('COMMIT');
      expect((await insert).code).toBe('40001');
      await t2.query('ROLLBACK');
    });
    expect(await probes()).toEqual({ campus: 0, person: 0 });
  });

  it('TS-F001-12 (TS-F001-11 at REPEATABLE READ): the blocked archive loses with 23001', async () => {
    const [c, p] = await Promise.all([campus(), person()]);
    await withSessions(async (t1, t2, pids) => {
      await t2.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await t2.query(INSERT_LINK, [churchId, p, c]);
      await t1.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const archive = pgFailure(t1.query(ARCHIVE_CAMPUS, [c]));
      await waitUntilBlocked(admin, pids.t1, pids.t2);
      await t2.query('COMMIT');
      expect(await archive).toMatchObject({ code: '23001', constraint: 'pca_campus_active_fk' });
      await t1.query('ROLLBACK');
    });
    expect(await probes()).toEqual({ campus: 0, person: 0 });
  });

  it('TS-F001-20: a link committed between the two archive steps makes step 2 fail; the retry ends all three links', async () => {
    const [p, c1, c2, c3] = await Promise.all([person(), campus(), campus(), campus()]);
    await link(p, c1);
    await link(p, c2);
    await withSessions(async (t1, t2) => {
      await t1.query('BEGIN');
      expect((await t1.query(END_PERSON_LINKS, [p])).rowCount).toBe(2); // step 1
      // The concurrent insert is not blocked: step 1 locked only affiliation rows.
      await t2.query('BEGIN');
      await t2.query(INSERT_LINK, [churchId, p, c3]);
      await t2.query('COMMIT');
      const step2 = await pgFailure(t1.query(ARCHIVE_PERSON, [p]));
      expect(step2).toMatchObject({ code: '23001', constraint: 'pca_person_active_fk' });
      await t1.query('ROLLBACK');
      // Retry in a new transaction (ADR-004).
      await t1.query('BEGIN');
      expect((await t1.query(END_PERSON_LINKS, [p])).rowCount).toBe(3);
      expect((await t1.query(ARCHIVE_PERSON, [p])).rowCount).toBe(1);
      await t1.query('COMMIT');
    });
    const { rows } = await admin.query<{ active: number; ended: number }>(
      `SELECT count(*) FILTER (WHERE ended_at IS NULL)::int AS active,
              count(*) FILTER (WHERE end_reason = 'person_archived')::int AS ended
         FROM chms.person_campus_affiliations WHERE person_id = $1`,
      [p],
    );
    expect(rows[0]).toEqual({ active: 0, ended: 3 });
    expect(await probes()).toEqual({ campus: 0, person: 0 });
  });

  it('TS-F001-21: archive complete but uncommitted; the link insert is blocked and fails with 23503', async () => {
    const [p, c1, c2] = await Promise.all([person(), campus(), campus()]);
    await link(p, c1);
    await withSessions(async (t1, t2, pids) => {
      await t1.query('BEGIN');
      await t1.query(END_PERSON_LINKS, [p]);
      await t1.query(ARCHIVE_PERSON, [p]);
      await t2.query('BEGIN');
      const insert = pgFailure(t2.query(INSERT_LINK, [churchId, p, c2]));
      await waitUntilBlocked(admin, pids.t2, pids.t1);
      await t1.query('COMMIT');
      expect(await insert).toMatchObject({ code: '23503', constraint: 'pca_person_active_fk' });
      await t2.query('ROLLBACK');
    });
    expect(await probes()).toEqual({ campus: 0, person: 0 });
  });
});
