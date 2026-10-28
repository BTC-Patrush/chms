import { DrizzleQueryError } from 'drizzle-orm';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { MAX_SERIALIZATION_RETRIES, retrying } from '../../src/db/service.ts';
import {
  DatabaseFailureError,
  DomainError,
  toDomainError,
  toServiceError,
  unmatched,
} from '../../src/domain/errors.ts';

/*
 * Error mapping and retry policy of the service runner (database design section 4; ADR-004
 * decision 8). The real PostgreSQL errors behind each mapping are produced by the database
 * tests; here the mapping table and the retry bounds are checked on constructed errors.
 */

function databaseError(code: string, constraint?: string, detail?: string): pg.DatabaseError {
  const error = new pg.DatabaseError('constructed for a unit test', 0, 'error');
  error.code = code;
  error.constraint = constraint;
  error.detail = detail;
  return error;
}

describe('mapping PostgreSQL errors to domain errors', () => {
  const cases: [string, string, string][] = [
    ['23505', 'churches_singleton_uq', 'ChurchAlreadyExists'],
    ['23505', 'campuses_name_ci_uq', 'CampusNameTaken'],
    ['23505', 'pca_active_pair_uq', 'AffiliationExists'],
    ['23505', 'pca_active_primary_uq', 'PrimaryAffiliationExists'],
    ['23503', 'pca_campus_active_fk', 'CampusArchived'],
    ['23503', 'pca_person_active_fk', 'PersonArchived'],
    ['23001', 'pca_campus_active_fk', 'CampusHasActiveAffiliations'],
    ['23001', 'pca_person_active_fk', 'ConcurrentAffiliationChange'],
  ];

  it.each(cases)('maps %s on %s to %s', (sqlstate, constraint, code) => {
    expect(toDomainError(databaseError(sqlstate, constraint))).toMatchObject({
      code,
      details: { sqlstate, constraint },
    });
  });

  it('maps by SQLSTATE and constraint together, and leaves everything else unmapped', () => {
    for (const [sqlstate, constraint] of [
      ['23503', 'campuses_name_ci_uq'], // known constraint, other SQLSTATE
      ['23505', 'audit_actor_category_fk'],
      ['23503', 'audit_actor_category_fk'], // unknown actor category: a programming error
      ['23514', 'people_display_name_ck'], // the boundary should have rejected it
      ['CHA01', undefined],
      ['42501', undefined],
      ['40P01', undefined],
    ] as const) {
      expect(toDomainError(databaseError(sqlstate, constraint))).toBeUndefined();
    }
    expect(toDomainError(new Error('not a database error'))).toBeUndefined();
  });

  it('keeps no value from the PostgreSQL error detail (AC-F001-25)', () => {
    const detail = 'Key (church_id, casefold(name))=(x, marker north) already exists.';
    const error = toDomainError(databaseError('23505', 'campuses_name_ci_uq', detail));
    const text = `${String(error)} ${JSON.stringify(error)} ${error?.stack ?? ''}`;
    expect(text).not.toContain('marker');
    expect(error?.cause).toBeUndefined();
  });

  it("unwraps Drizzle's query error, which repeats the query parameters", () => {
    const wrapped = new DrizzleQueryError(
      'INSERT INTO chms.people (display_name) VALUES ($1)',
      ['Marker Name'],
      databaseError('23503', 'pca_person_active_fk'),
    );
    expect(wrapped.message).toContain('Marker Name'); // why it must never be rethrown
    expect(toDomainError(wrapped)).toMatchObject({ code: 'PersonArchived' });
  });

  it('rethrows unmapped database failures with SQLSTATE and constraint only', () => {
    const detail = 'Failing row contains (x, Marker Name).';
    for (const error of [
      databaseError('23514', 'people_display_name_ck', detail),
      new DrizzleQueryError('UPDATE ...', ['Marker Name'], databaseError('CHA01')),
    ]) {
      const thrown = toServiceError(error);
      expect(thrown).toBeInstanceOf(DatabaseFailureError);
      const text = `${String(thrown)} ${JSON.stringify(thrown)} ${(thrown as Error).stack ?? ''}`;
      expect(text).not.toContain('Marker');
      expect((thrown as Error).cause).toBeUndefined();
    }
    expect(toServiceError(databaseError('23514', 'people_display_name_ck'))).toMatchObject({
      sqlstate: '23514',
      constraint: 'people_display_name_ck',
    });
  });

  it('passes other errors through, but never the Drizzle wrapper', () => {
    const application = new Error('application error');
    expect(toServiceError(application)).toBe(application);
    const connection = new Error('connection terminated');
    const wrapped = new DrizzleQueryError('SELECT $1', ['Marker Name'], connection);
    expect(toServiceError(wrapped)).toBe(connection);
    expect(toServiceError(databaseError('23505', 'campuses_name_ci_uq'))).toBeInstanceOf(
      DomainError,
    );
  });

  it('classifies an UPDATE that matched no row', () => {
    expect(unmatched(undefined, 3, 'CampusNotFound').code).toBe('CampusNotFound');
    expect(unmatched({ rowVersion: 4 }, 3, 'CampusNotFound').code).toBe('ConcurrentModification');
    expect(unmatched({ rowVersion: 3 }, 3, 'CampusNotFound', 'CampusArchived').code).toBe(
      'CampusArchived',
    );
  });
});

describe('retry policy', () => {
  /** An attempt that fails with each error in turn, then succeeds. */
  function failingWith(...errors: Error[]) {
    let attempts = 0;
    const attempt = () => {
      const error = errors[attempts];
      attempts += 1;
      return error === undefined ? Promise.resolve('done') : Promise.reject(error);
    };
    return { attempt, attempts: () => attempts };
  }
  const deadlock = () => databaseError('40P01');
  const serialization = () => databaseError('40001');
  const archiveRace = () => databaseError('23001', 'pca_person_active_fk');
  const ARCHIVE_RACE = { sqlstate: '23001', constraint: 'pca_person_active_fk' };

  it('retries 40001 and 40P01 up to three times', async () => {
    expect(MAX_SERIALIZATION_RETRIES).toBe(3);
    const run = failingWith(deadlock(), serialization(), deadlock());
    await expect(retrying(run.attempt)).resolves.toBe('done');
    expect(run.attempts()).toBe(4);
  });

  it('rethrows the fourth consecutive serialization failure', async () => {
    const fourth = deadlock();
    const run = failingWith(serialization(), deadlock(), serialization(), fourth);
    await expect(retrying(run.attempt)).rejects.toBe(fourth);
    expect(run.attempts()).toBe(4);
  });

  it('retries the person-archive race exactly once', async () => {
    const once = failingWith(archiveRace());
    await expect(retrying(once.attempt, ARCHIVE_RACE)).resolves.toBe('done');
    expect(once.attempts()).toBe(2);
    const second = archiveRace();
    const twice = failingWith(archiveRace(), second);
    await expect(retrying(twice.attempt, ARCHIVE_RACE)).rejects.toBe(second);
    expect(twice.attempts()).toBe(2);
    expect(toDomainError(second)?.code).toBe('ConcurrentAffiliationChange');
  });

  it('recognizes retryable failures inside Drizzle query errors', async () => {
    const wrappedDeadlock = new DrizzleQueryError('UPDATE ...', [], deadlock());
    const run = failingWith(wrappedDeadlock);
    await expect(retrying(run.attempt)).resolves.toBe('done');
    expect(run.attempts()).toBe(2);
  });

  it('keeps the two budgets separate', async () => {
    const run = failingWith(deadlock(), archiveRace(), deadlock(), deadlock());
    await expect(retrying(run.attempt, ARCHIVE_RACE)).resolves.toBe('done');
    expect(run.attempts()).toBe(5);
  });

  it('never retries other errors, domain errors or the race without opting in', async () => {
    for (const error of [
      databaseError('23505', 'campuses_name_ci_uq'),
      databaseError('CHA01'),
      new DomainError('ConcurrentModification'),
      new Error('application error'),
      archiveRace(),
    ]) {
      const run = failingWith(error);
      await expect(retrying(run.attempt)).rejects.toBe(error);
      expect(run.attempts()).toBe(1);
    }
  });
});
