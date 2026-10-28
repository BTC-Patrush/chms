import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type pg from 'pg';
import { people, personCampusAffiliations as affiliations } from '../db/schema.ts';
import { nextVersion, runService, single } from '../db/service.ts';
import type { TransactionDatabase } from '../db/transaction.ts';
import { DomainError, unmatched, type DomainErrorCode } from '../domain/errors.ts';
import {
  parseActorCategory,
  parseId,
  parseName,
  parseOptionalName,
  parseRowVersion,
} from '../domain/input.ts';

/*
 * Person services (BR-02, BR-04, BR-05, BR-08). People never reference accounts. Each write
 * takes a system actor category and runs as chms_app; each update checks row_version.
 */

export type Person = typeof people.$inferSelect;

export interface PersonVersion {
  readonly id: string;
  readonly rowVersion: number;
}

/** The complete set of names. `displayName` is authoritative; components are null when absent. */
export interface PersonNames {
  readonly displayName: string;
  readonly givenName?: string | null;
  readonly familyName?: string | null;
}

export interface ArchivePersonResult {
  readonly person: Person;
  /** Affiliations this archive ended, with reason person_archived. */
  readonly endedAffiliationIds: readonly string[];
}

const parseNames = (input: PersonNames) => ({
  displayName: parseName('displayName', input.displayName),
  givenName: parseOptionalName('givenName', input.givenName),
  familyName: parseOptionalName('familyName', input.familyName),
});

export async function createPerson(
  pool: pg.Pool,
  actorCategory: string,
  input: PersonNames,
): Promise<Person> {
  const actor = parseActorCategory(actorCategory);
  const names = parseNames(input);
  return runService(pool, { actorCategory: actor }, async (tx) => {
    // Column-level grants: name only the granted columns (database design section 5).
    const { rows } = await tx.execute<{ id: string }>(
      sql`INSERT INTO chms.people (church_id, display_name, given_name, family_name)
          SELECT id, ${names.displayName}::text, ${names.givenName}::text, ${names.familyName}::text
            FROM chms.churches
          RETURNING id`,
    );
    const [created] = rows;
    if (created === undefined) throw new DomainError('ChurchNotFound');
    return single(await tx.select().from(people).where(eq(people.id, created.id)));
  });
}

/** Replaces all three names; an omitted component becomes null. */
export async function updatePersonNames(
  pool: pg.Pool,
  actorCategory: string,
  input: PersonVersion & PersonNames,
): Promise<Person> {
  const names = parseNames(input);
  const actor = parseActorCategory(actorCategory);
  const id = parseId('id', input.id);
  const rowVersion = parseRowVersion(input.rowVersion);
  return runService(pool, { actorCategory: actor }, async (tx) => {
    const [person] = await updatePerson(tx, id, rowVersion, names);
    return person ?? failUnmatched(tx, id, rowVersion);
  });
}

/**
 * Archives a person in one transaction (BR-04, ADR-004 decision 4): (1) end every active
 * affiliation with reason person_archived, keeping is_primary; (2) archive the person. If an
 * affiliation commits between the two steps, step 2 fails with 23001 on pca_person_active_fk,
 * everything rolls back, and the whole archive is retried once in a new transaction; a second
 * such failure is ConcurrentAffiliationChange.
 */
export async function archivePerson(
  pool: pg.Pool,
  actorCategory: string,
  input: PersonVersion,
): Promise<ArchivePersonResult> {
  const actor = parseActorCategory(actorCategory);
  const id = parseId('id', input.id);
  const rowVersion = parseRowVersion(input.rowVersion);
  const options = {
    actorCategory: actor,
    retryOnceOn: { sqlstate: '23001', constraint: 'pca_person_active_fk' },
  };
  return runService(pool, options, async (tx) => {
    const ended = await tx
      .update(affiliations)
      .set({
        endedAt: sql`now()`,
        endReason: 'person_archived',
        personStatus: null,
        campusStatus: null,
        ...nextVersion(affiliations.rowVersion),
      })
      .where(and(eq(affiliations.personId, id), isNull(affiliations.endedAt)))
      .returning({ id: affiliations.id });
    const archived = { status: 'archived', archivedAt: sql`now()` };
    const [person] = await updatePerson(tx, id, rowVersion, archived, 'active');
    if (person === undefined) return failUnmatched(tx, id, rowVersion, 'PersonArchived');
    return { person, endedAffiliationIds: ended.map((a) => a.id) };
  });
}

/** Unarchives a person. Affiliations are not restored; re-linking creates new rows (BR-05). */
export async function unarchivePerson(
  pool: pg.Pool,
  actorCategory: string,
  input: PersonVersion,
): Promise<Person> {
  const actor = parseActorCategory(actorCategory);
  const id = parseId('id', input.id);
  const rowVersion = parseRowVersion(input.rowVersion);
  return runService(pool, { actorCategory: actor }, async (tx) => {
    const active = { status: 'active', archivedAt: null };
    const [person] = await updatePerson(tx, id, rowVersion, active, 'archived');
    return person ?? failUnmatched(tx, id, rowVersion, 'PersonNotArchived');
  });
}

function updatePerson(
  tx: TransactionDatabase,
  id: string,
  rowVersion: number,
  values: {
    displayName?: string;
    givenName?: string | null;
    familyName?: string | null;
    status?: string;
    archivedAt?: SQL | null;
  },
  requiredStatus?: 'active' | 'archived',
) {
  return tx
    .update(people)
    .set({ ...values, ...nextVersion(people.rowVersion) })
    .where(
      and(
        eq(people.id, id),
        eq(people.rowVersion, rowVersion),
        requiredStatus && eq(people.status, requiredStatus),
      ),
    )
    .returning();
}

async function failUnmatched(
  tx: TransactionDatabase,
  id: string,
  rowVersion: number,
  wrongState?: DomainErrorCode,
): Promise<never> {
  const [current] = await tx
    .select({ rowVersion: people.rowVersion })
    .from(people)
    .where(eq(people.id, id));
  throw unmatched(current, rowVersion, 'PersonNotFound', wrongState);
}
