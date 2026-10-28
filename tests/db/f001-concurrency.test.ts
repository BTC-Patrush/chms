import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archiveCampus, createCampus, renameCampus } from '../../src/church/campuses.ts';
import { bootstrapChurch } from '../../src/church/church.ts';
import {
  linkPersonToCampus,
  setPrimaryAffiliation,
  type Affiliation,
} from '../../src/people/affiliations.ts';
import { archivePerson, createPerson, type Person } from '../../src/people/people.ts';
import { backendPid, waitUntilBlocked } from '../support/pg-assert.ts';
import {
  auditEvents,
  createServiceFixture,
  domainFailure,
  invariantProbes,
  MAINTENANCE,
  type ServiceFixture,
} from '../support/services.ts';
import { firstRow } from '../support/sql.ts';

/*
 * Service-level concurrency (ADR-004; TS-F001-10, 11, 17, 20, 21, 32 and the deadlock retry).
 * The service call runs on a one-connection pool whose backend PID is read first; the other
 * side is a raw SQL session holding an open transaction. Every interleaving is confirmed with
 * pg_blocking_pids() before the blocker moves on, and the invariant probes run afterwards.
 */

const INSERT_LINK =
  'INSERT INTO chms.person_campus_affiliations (church_id, person_id, campus_id, is_primary) VALUES ($1, $2, $3, $4) RETURNING id';
const ARCHIVE_CAMPUS =
  "UPDATE chms.campuses SET status = 'archived', archived_at = now(), row_version = row_version + 1, updated_at = now() WHERE id = $1";
const END_PERSON_LINKS = `UPDATE chms.person_campus_affiliations
    SET ended_at = now(), end_reason = 'person_archived', person_status = NULL, campus_status = NULL,
        row_version = row_version + 1, updated_at = now()
  WHERE person_id = $1 AND ended_at IS NULL`;
const ARCHIVE_PERSON =
  "UPDATE chms.people SET status = 'archived', archived_at = now(), row_version = row_version + 1, updated_at = now() WHERE id = $1";

interface Session {
  readonly client: pg.Client;
  readonly pid: number;
}

describe('service concurrency (ADR-004)', () => {
  let f: ServiceFixture;
  let churchId: string;
  let seq = 0;
  const sessions: pg.Client[] = [];

  beforeAll(async () => {
    f = await createServiceFixture();
    churchId = (await bootstrapChurch(f.ownerPool, { name: 'Grace Fellowship' })).church.id;
  });

  afterAll(async () => {
    await Promise.all(sessions.map((s) => s.end()));
    await f.close();
  });

  const campus = () => createCampus(f.appPool, MAINTENANCE, { name: `Campus ${String(++seq)}` });
  const person = () =>
    createPerson(f.appPool, MAINTENANCE, { displayName: `Person ${String(++seq)}` });
  const link = (p: Person, campusId: string, isPrimary = false) =>
    linkPersonToCampus(f.appPool, MAINTENANCE, { personId: p.id, campusId, isPrimary });
  /** A raw session with its PID read before it can block. */
  const session = async (role: 'app' | 'admin' = 'app'): Promise<Session> => {
    const client =
      role === 'app' ? await f.db.connectAs(f.db.appConfig) : await f.db.connectAdmin();
    sessions.push(client);
    return { client, pid: await backendPid(client) };
  };
  /** BEGIN with the maintenance actor declared, as a raw chms_app writer would. */
  const begin = async (s: Session) => {
    await s.client.query('BEGIN');
    await s.client.query("SELECT set_config('chms.actor_category', 'maintenance', true)");
  };
  const currentQuery = async (pid: number) =>
    (
      await firstRow<{ query: string }>(
        f.admin,
        'SELECT query FROM pg_stat_activity WHERE pid = $1',
        [pid],
      )
    ).query;
  const linkState = async (personId: string) =>
    firstRow<{ active: number; person_archived: number }>(
      f.admin,
      `SELECT count(*) FILTER (WHERE ended_at IS NULL)::int AS active,
              count(*) FILTER (WHERE end_reason = 'person_archived')::int AS person_archived
         FROM chms.person_campus_affiliations WHERE person_id = $1`,
      [personId],
    );
  const personStatus = async (personId: string) =>
    (
      await firstRow<{ status: string }>(f.admin, 'SELECT status FROM chms.people WHERE id = $1', [
        personId,
      ])
    ).status;

  it('TS-F001-10: a link blocked by an uncommitted campus archive fails with CampusArchived (23503)', async () => {
    const c = await campus();
    const p = await person();
    const t1 = await session();
    const { pool, pid } = await f.singleConnection();
    await begin(t1);
    await t1.client.query(ARCHIVE_CAMPUS, [c.id]);
    const insert = domainFailure(
      linkPersonToCampus(pool, MAINTENANCE, { personId: p.id, campusId: c.id }),
    );
    await waitUntilBlocked(f.admin, pid, t1.pid);
    await t1.client.query('COMMIT');
    expect(await insert).toMatchObject({
      code: 'CampusArchived',
      details: { sqlstate: '23503', constraint: 'pca_campus_active_fk' },
    });
    expect(await invariantProbes(f.admin)).toEqual({ campus: 0, person: 0 });
  });

  for (const outcome of ['COMMIT', 'ROLLBACK'] as const) {
    it(`TS-F001-11: a campus archive blocked by an uncommitted link, which then runs ${outcome}`, async () => {
      const c = await campus();
      const p = await person();
      const t2 = await session();
      const { pool, pid } = await f.singleConnection();
      await begin(t2);
      await t2.client.query(INSERT_LINK, [churchId, p.id, c.id, false]);
      const archive = archiveCampus(pool, MAINTENANCE, c).then(
        (archived) => archived.status,
        (error: unknown) => error,
      );
      await waitUntilBlocked(f.admin, pid, t2.pid);
      await t2.client.query(outcome);
      if (outcome === 'COMMIT') {
        expect(await archive).toMatchObject({
          code: 'CampusHasActiveAffiliations',
          details: { sqlstate: '23001', constraint: 'pca_campus_active_fk' },
        });
      } else {
        expect(await archive).toBe('archived');
      }
      expect(await invariantProbes(f.admin)).toEqual({ campus: 0, person: 0 });
    });
  }

  for (const variant of ['moving an existing primary', 'with no primary before'] as const) {
    it(`TS-F001-17: two concurrent "set primary" operations, ${variant}: one wins, the other fails with 23505`, async () => {
      const p = await person();
      const existing = variant === 'moving an existing primary';
      const a = await link(p, (await campus()).id, existing);
      const b = await link(p, (await campus()).id);
      const c = await link(p, (await campus()).id);
      const t1 = await session();
      const { pool, pid } = await f.singleConnection();
      await begin(t1);
      // The same two steps as setPrimaryAffiliation, for b, left uncommitted.
      await t1.client.query(
        'UPDATE chms.person_campus_affiliations SET is_primary = false WHERE id = $1',
        [a.id],
      );
      await t1.client.query(
        'UPDATE chms.person_campus_affiliations SET is_primary = true WHERE id = $1',
        [b.id],
      );
      const second = domainFailure(setPrimaryAffiliation(pool, MAINTENANCE, c));
      await waitUntilBlocked(f.admin, pid, t1.pid);
      await t1.client.query('COMMIT');
      expect(await second).toMatchObject({
        code: 'PrimaryAffiliationExists',
        details: { sqlstate: '23505', constraint: 'pca_active_primary_uq' },
      });
      const { rows } = await f.admin.query<{ id: string }>(
        'SELECT id FROM chms.person_campus_affiliations WHERE person_id = $1 AND is_primary AND ended_at IS NULL',
        [p.id],
      );
      expect(rows).toEqual([{ id: b.id }]);
    });
  }

  it('TS-F001-20: a link committed between the archive steps fails step 2 (23001); the one retry ends all three links', async () => {
    const p = await person();
    await link(p, (await campus()).id, true);
    await link(p, (await campus()).id);
    const lateCampus = await campus();
    const t2 = await session();
    const { pool, pid } = await f.singleConnection();
    await begin(t2);
    const { rows } = await t2.client.query<{ id: string }>(INSERT_LINK, [
      churchId,
      p.id,
      lateCampus.id,
      false,
    ]);
    const archive = archivePerson(pool, MAINTENANCE, p);
    // Step 1 cannot see the uncommitted link, so step 2 waits for its key-share lock.
    await waitUntilBlocked(f.admin, pid, t2.pid);
    expect(await currentQuery(pid)).toMatch(/^update "chms"\."people"/);
    await t2.client.query('COMMIT');
    const { person: archived, endedAffiliationIds } = await archive;
    expect(archived.status).toBe('archived');
    expect(endedAffiliationIds).toHaveLength(3);
    expect(endedAffiliationIds).toContain(rows[0]?.id);
    expect(await linkState(p.id)).toEqual({ active: 0, person_archived: 3 });
    // The failed first attempt left nothing behind: one archive and three ends, one xact_id.
    const events = (
      await Promise.all([p.id, ...endedAffiliationIds].map((id) => auditEvents(f.admin, id)))
    )
      .flat()
      .filter((e) => e.action !== 'create');
    expect(events.map((e) => e.action).sort()).toEqual([
      'archive',
      'end_affiliation',
      'end_affiliation',
      'end_affiliation',
    ]);
    expect(new Set(events.map((e) => e.xact_id)).size).toBe(1);
    expect(await invariantProbes(f.admin)).toEqual({ campus: 0, person: 0 });
  });

  it('AC-F001-14: a second race after the one retry fails with ConcurrentAffiliationChange and changes nothing', async () => {
    const p = await person();
    const l1 = await link(p, (await campus()).id);
    await link(p, (await campus()).id);
    const [c3, c4] = [await campus(), await campus()];
    const [t2, t3, t4] = [await session(), await session(), await session()];
    const { pool, pid } = await f.singleConnection();
    // Attempt 1: step 2 waits for T2's uncommitted link, as in TS-F001-20.
    await begin(t2);
    await t2.client.query(INSERT_LINK, [churchId, p.id, c3.id, false]);
    const archive = domainFailure(archivePerson(pool, MAINTENANCE, p));
    await waitUntilBlocked(f.admin, pid, t2.pid);
    // T3 queues for l1, which attempt 1's step 1 has locked.
    await t3.client.query('BEGIN');
    const t3Lock = t3.client.query(
      'SELECT id FROM chms.person_campus_affiliations WHERE id = $1 FOR UPDATE',
      [l1.id],
    );
    await waitUntilBlocked(f.admin, t3.pid, pid);
    // Attempt 1 fails with 23001 and releases its locks; T3 gets l1 at that moment. The
    // retry needs four more client round trips to reach l1, so it then waits for T3. (Were
    // it ever first, the next check would time out: this test cannot pass by accident.)
    await t2.client.query('COMMIT');
    await t3Lock;
    await waitUntilBlocked(f.admin, pid, t3.pid);
    expect(await currentQuery(pid)).toMatch(/^update "chms"\."person_campus_affiliations"/);
    // A link committed after the retry's step 1 took its snapshot: step 1 cannot end it.
    await begin(t4);
    await t4.client.query(INSERT_LINK, [churchId, p.id, c4.id, false]);
    await t4.client.query('COMMIT');
    await t3.client.query('COMMIT');
    expect(await archive).toMatchObject({
      code: 'ConcurrentAffiliationChange',
      details: { sqlstate: '23001', constraint: 'pca_person_active_fk' },
    });
    expect(await personStatus(p.id)).toBe('active');
    expect(await linkState(p.id)).toEqual({ active: 4, person_archived: 0 });
    expect(await invariantProbes(f.admin)).toEqual({ campus: 0, person: 0 });
  });

  it('TS-F001-21: a link blocked by an uncommitted person archive fails with PersonArchived (23503)', async () => {
    const p = await person();
    await link(p, (await campus()).id);
    const c = await campus();
    const t1 = await session();
    const { pool, pid } = await f.singleConnection();
    await begin(t1);
    await t1.client.query(END_PERSON_LINKS, [p.id]);
    await t1.client.query(ARCHIVE_PERSON, [p.id]);
    const insert = domainFailure(
      linkPersonToCampus(pool, MAINTENANCE, { personId: p.id, campusId: c.id }),
    );
    await waitUntilBlocked(f.admin, pid, t1.pid);
    await t1.client.query('COMMIT');
    expect(await insert).toMatchObject({
      code: 'PersonArchived',
      details: { sqlstate: '23503', constraint: 'pca_person_active_fk' },
    });
    expect(await invariantProbes(f.admin)).toEqual({ campus: 0, person: 0 });
  });

  it('TS-F001-32: of two updates with the same row_version, one wins and the other fails with ConcurrentModification', async () => {
    const c = await campus();
    const t1 = await session();
    const { pool, pid } = await f.singleConnection();
    await begin(t1);
    await t1.client.query(
      "UPDATE chms.campuses SET name = name || ' A', row_version = row_version + 1, updated_at = now() WHERE id = $1 AND row_version = $2",
      [c.id, c.rowVersion],
    );
    const second = domainFailure(
      renameCampus(pool, MAINTENANCE, { id: c.id, rowVersion: c.rowVersion, name: 'Second' }),
    );
    await waitUntilBlocked(f.admin, pid, t1.pid);
    await t1.client.query('COMMIT');
    expect((await second).code).toBe('ConcurrentModification');
    expect(
      await firstRow(f.admin, 'SELECT name, row_version FROM chms.campuses WHERE id = $1', [c.id]),
    ).toEqual({ name: `${c.name} A`, row_version: 2 });
    expect((await auditEvents(f.admin, c.id)).map((e) => e.action)).toEqual(['create', 'update']);
  });

  it('retries a deadlock (40P01) in a new transaction, which then succeeds', async () => {
    const p = await person();
    const a: Affiliation = await link(p, (await campus()).id, true);
    const b = await link(p, (await campus()).id);
    // A superuser session that never detects the deadlock itself, so the service does.
    const t1 = await session('admin');
    const { pool, pid } = await f.singleConnection();
    await t1.client.query('BEGIN');
    await t1.client.query("SET LOCAL deadlock_timeout = '60s'");
    const lockRow = 'SELECT id FROM chms.person_campus_affiliations WHERE id = $1 FOR UPDATE';
    await t1.client.query(lockRow, [b.id]);
    // Attempt 1: step 1 locks a (the old primary), step 2 waits for b.
    const moved = setPrimaryAffiliation(pool, MAINTENANCE, b);
    await waitUntilBlocked(f.admin, pid, t1.pid);
    // T1 now waits for a: a deadlock. After deadlock_timeout (1 s) the service's backend
    // detects it, attempt 1 fails with 40P01 and releases a, so T1 gets it.
    await t1.client.query(lockRow, [a.id]);
    // Attempt 2, in a new transaction, waits for T1 at step 1 and succeeds once T1 commits.
    await waitUntilBlocked(f.admin, pid, t1.pid);
    await t1.client.query('COMMIT');
    expect(await moved).toMatchObject({
      previousPrimaryId: a.id,
      affiliation: { isPrimary: true },
    });
    const { rows } = await f.admin.query<{ id: string }>(
      'SELECT id FROM chms.person_campus_affiliations WHERE person_id = $1 AND is_primary AND ended_at IS NULL',
      [p.id],
    );
    expect(rows).toEqual([{ id: b.id }]);
  });
});
