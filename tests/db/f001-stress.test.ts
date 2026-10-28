import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  archiveCampus,
  createCampus,
  renameCampus,
  unarchiveCampus,
} from '../../src/church/campuses.ts';
import { bootstrapChurch } from '../../src/church/church.ts';
import { DomainError, type DomainErrorCode } from '../../src/domain/errors.ts';
import {
  endAffiliation,
  linkPersonToCampus,
  setPrimaryAffiliation,
} from '../../src/people/affiliations.ts';
import { listPeople } from '../../src/people/directory.ts';
import {
  archivePerson,
  createPerson,
  unarchivePerson,
  updatePersonNames,
} from '../../src/people/people.ts';
import {
  auditEventCount,
  createServiceFixture,
  invariantProbes,
  MAINTENANCE,
  type ServiceFixture,
} from '../support/services.ts';
import { pickWith, seededRandom } from '../support/random.ts';
import { firstRow } from '../support/sql.ts';

/*
 * TS-F001-38: fixed seed, 8 workers x 500 random service operations at READ COMMITTED, under
 * 60 s. Workers share people, campuses and affiliations and read row versions that may be
 * stale by the time they write, so conflicts are real. Afterwards the invariant probes return
 * 0 and the audit trail holds exactly one event per committed row change.
 */

const SEED = 20261028;
const WORKERS = 8;
const OPERATIONS_PER_WORKER = 500;
const TIME_LIMIT_MS = 60_000;

/** Outcomes a racing operation may legitimately meet. Anything else fails the test. */
const EXPECTED_CONFLICTS: ReadonlySet<DomainErrorCode> = new Set([
  'CampusNameTaken',
  'CampusArchived',
  'CampusNotArchived',
  'CampusHasActiveAffiliations',
  'PersonArchived',
  'PersonNotArchived',
  'AffiliationEnded',
  'AffiliationExists',
  'PrimaryAffiliationExists',
  'ConcurrentAffiliationChange',
  'ConcurrentModification',
]);

describe('stress (TS-F001-38)', () => {
  let f: ServiceFixture;

  beforeAll(async () => {
    f = await createServiceFixture();
    await bootstrapChurch(f.ownerPool, { name: 'Grace Fellowship' });
  });

  afterAll(async () => {
    await f.close();
  });

  it(`${String(WORKERS)} workers x ${String(OPERATIONS_PER_WORKER)} operations keep every invariant`, async () => {
    const pool = f.appPool;
    const campusIds: string[] = [];
    const personIds: string[] = [];
    const affiliationIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      campusIds.push(
        (await createCampus(pool, MAINTENANCE, { name: `Seed Campus ${String(i)}` })).id,
      );
    }
    for (let i = 0; i < 40; i += 1) {
      personIds.push(
        (await createPerson(pool, MAINTENANCE, { displayName: `Seed Person ${String(i)}` })).id,
      );
    }
    // Every worker can pick an affiliation from its first operation on.
    for (const [i, personId] of personIds.entries()) {
      const campusId = campusIds[i % campusIds.length] ?? '';
      affiliationIds.push((await linkPersonToCampus(pool, MAINTENANCE, { personId, campusId })).id);
    }
    let expectedEvents = await auditEventCount(f.admin);
    const outcomes = new Map<string, number>();
    const unexpected: string[] = [];
    const count = (key: string) => outcomes.set(key, (outcomes.get(key) ?? 0) + 1);

    const version = async (table: string, id: string) =>
      (
        await pool.query<{ row_version: number }>(
          `SELECT row_version FROM chms.${table} WHERE id = $1`,
          [id],
        )
      ).rows[0]?.row_version ?? 1;

    const worker = async (index: number) => {
      const random = seededRandom(SEED + index);
      const pick = pickWith(random);
      const operations: [number, string, () => Promise<number>][] = [
        [
          25,
          'link',
          async () => {
            const a = await linkPersonToCampus(pool, MAINTENANCE, {
              personId: pick(personIds),
              campusId: pick(campusIds),
              isPrimary: random() < 0.2,
            });
            affiliationIds.push(a.id);
            return 1;
          },
        ],
        [
          14,
          'endAffiliation',
          async () => {
            const id = pick(affiliationIds);
            await endAffiliation(pool, MAINTENANCE, {
              id,
              rowVersion: await version('person_campus_affiliations', id),
            });
            return 1;
          },
        ],
        [
          10,
          'setPrimary',
          async () => {
            const id = pick(affiliationIds);
            const result = await setPrimaryAffiliation(pool, MAINTENANCE, {
              id,
              rowVersion: await version('person_campus_affiliations', id),
            });
            return result.previousPrimaryId === null ? 1 : 2;
          },
        ],
        [
          8,
          'archivePerson',
          async () => {
            const id = pick(personIds);
            const result = await archivePerson(pool, MAINTENANCE, {
              id,
              rowVersion: await version('people', id),
            });
            return 1 + result.endedAffiliationIds.length;
          },
        ],
        [
          7,
          'unarchivePerson',
          async () => {
            const id = pick(personIds);
            await unarchivePerson(pool, MAINTENANCE, {
              id,
              rowVersion: await version('people', id),
            });
            return 1;
          },
        ],
        [
          5,
          'archiveCampus',
          async () => {
            const id = pick(campusIds);
            await archiveCampus(pool, MAINTENANCE, {
              id,
              rowVersion: await version('campuses', id),
            });
            return 1;
          },
        ],
        [
          5,
          'unarchiveCampus',
          async () => {
            const id = pick(campusIds);
            await unarchiveCampus(pool, MAINTENANCE, {
              id,
              rowVersion: await version('campuses', id),
            });
            return 1;
          },
        ],
        [
          5,
          'renameCampus',
          async () => {
            const id = pick(campusIds);
            await renameCampus(pool, MAINTENANCE, {
              id,
              rowVersion: await version('campuses', id),
              name: `Campus ${String(Math.floor(random() * 40))}`,
            });
            return 1;
          },
        ],
        [
          10,
          'updatePersonNames',
          async () => {
            const id = pick(personIds);
            await updatePersonNames(pool, MAINTENANCE, {
              id,
              rowVersion: await version('people', id),
              displayName: `Person ${String(index)}-${String(Math.floor(random() * 1000))}`,
              givenName: random() < 0.5 ? null : 'Given',
            });
            return 1;
          },
        ],
        [
          5,
          'createPerson',
          async () => {
            const p = await createPerson(pool, MAINTENANCE, {
              displayName: `Worker ${String(index)} Person`,
            });
            personIds.push(p.id);
            return 1;
          },
        ],
        [
          2,
          'createCampus',
          async () => {
            const c = await createCampus(pool, MAINTENANCE, {
              name: `Campus ${String(Math.floor(random() * 40))}`,
            });
            campusIds.push(c.id);
            return 1;
          },
        ],
        [
          4,
          'listPeople',
          async () => {
            await listPeople(pool, { kind: 'campuses', campusIds: [pick(campusIds)] });
            return 0;
          },
        ],
      ];
      const totalWeight = operations.reduce((sum, [weight]) => sum + weight, 0);
      for (let i = 0; i < OPERATIONS_PER_WORKER; i += 1) {
        let roll = random() * totalWeight;
        const operation = operations.find(([weight]) => (roll -= weight) < 0) ?? operations[0];
        if (operation === undefined) throw new Error('no operations');
        const [, name, run] = operation;
        try {
          // Await first: `expectedEvents += await run()` would read the total before the
          // await and lose the other workers' increments.
          const events = await run();
          expectedEvents += events;
          count(`${name}: ok`);
        } catch (error) {
          if (error instanceof DomainError && EXPECTED_CONFLICTS.has(error.code)) {
            count(`${name}: ${error.code}`);
          } else {
            unexpected.push(`${name}: ${String(error)}`);
          }
        }
      }
    };

    const started = performance.now();
    await Promise.all(Array.from({ length: WORKERS }, (_, index) => worker(index)));
    const elapsedMs = performance.now() - started;

    console.info(
      `TS-F001-38: ${String(WORKERS * OPERATIONS_PER_WORKER)} operations in ${elapsedMs.toFixed(0)} ms`,
      Object.fromEntries([...outcomes].sort()),
    );
    expect(unexpected).toEqual([]);
    expect(elapsedMs).toBeLessThan(TIME_LIMIT_MS);
    expect(await invariantProbes(f.admin)).toEqual({ campus: 0, person: 0 });
    // Audit events equal successful changes, in total and per row: every insert writes
    // row_version 1 and every update adds exactly 1, each with exactly one event.
    expect(await auditEventCount(f.admin)).toBe(expectedEvents);
    const { mismatched } = await firstRow<{ mismatched: number }>(
      f.admin,
      `SELECT count(*)::int AS mismatched
           FROM (SELECT id, row_version FROM chms.churches
                 UNION ALL SELECT id, row_version FROM chms.campuses
                 UNION ALL SELECT id, row_version FROM chms.people
                 UNION ALL SELECT id, row_version FROM chms.person_campus_affiliations) AS r
           LEFT JOIN (SELECT entity_id, count(*)::int AS n FROM chms.audit_events GROUP BY 1) AS e
             ON e.entity_id = r.id
          WHERE COALESCE(e.n, 0) <> r.row_version`,
    );
    expect(mismatched).toBe(0);
    // The run must contain real conflicts and real successes, not only one kind.
    const total = (suffix: string) =>
      [...outcomes].filter(([key]) => key.endsWith(suffix)).reduce((sum, [, n]) => sum + n, 0);
    expect(total(': ok')).toBeGreaterThan(1000);
    expect(total(': ConcurrentModification')).toBeGreaterThan(0);
    expect(total(': CampusHasActiveAffiliations')).toBeGreaterThan(0);
  }, 120_000);
});
