import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type pg from 'pg';
import { people, personCampusAffiliations as affiliations } from '../db/schema.ts';
import { runService } from '../db/service.ts';
import { DomainError } from '../domain/errors.ts';
import { parseBoolean, parseId, parseScope, type Scope } from '../domain/input.ts';
import type { Affiliation } from './affiliations.ts';
import type { Person } from './people.ts';

/*
 * Scoped reads of people (AC-F001-17, PPD-02). Every read takes an explicit scope. Under a
 * campus scope a person is visible only through an active affiliation to a campus in scope,
 * so unlinked and archived people never are. Under the whole-church scope everyone is, but
 * archived people only when `includeArchived` is requested, for lists and lookups by id
 * alike. Deciding who may hold which scope belongs to D-01 and F002.
 */

export interface PersonDetail {
  readonly person: Person;
  /**
   * Campus scope: the active affiliations to campuses in scope only. Whole church: every
   * affiliation, ended ones included.
   */
  readonly affiliations: readonly Affiliation[];
}

/** People visible in `scope`, ordered by display name. */
export async function listPeople(
  pool: pg.Pool,
  scope: Scope,
  includeArchived = false,
): Promise<Person[]> {
  const visible = visibleIn(parseScope(scope), parseBoolean('includeArchived', includeArchived));
  return runService(pool, {}, (tx) =>
    tx.select().from(people).where(visible).orderBy(people.displayName, people.id),
  );
}

/**
 * One person, if visible in `scope`; otherwise PersonNotFound, so a caller cannot tell a
 * person outside its scope, or an archived person it did not ask for, from one that does not
 * exist.
 */
export async function getPerson(
  pool: pg.Pool,
  scope: Scope,
  id: string,
  includeArchived = false,
): Promise<PersonDetail> {
  const parsedScope = parseScope(scope);
  const personId = parseId('id', id);
  const visible = visibleIn(parsedScope, parseBoolean('includeArchived', includeArchived));
  return runService(pool, {}, async (tx) => {
    const [person] = await tx
      .select()
      .from(people)
      .where(and(eq(people.id, personId), visible));
    if (person === undefined) throw new DomainError('PersonNotFound');
    const links = await tx
      .select()
      .from(affiliations)
      .where(and(eq(affiliations.personId, personId), activeInScope(parsedScope)))
      .orderBy(affiliations.createdAt, affiliations.id);
    return { person, affiliations: links };
  });
}

function visibleIn(scope: Scope, includeArchived: boolean): SQL | undefined {
  if (scope.kind === 'church') return includeArchived ? undefined : eq(people.status, 'active');
  const linked = sql`EXISTS (SELECT 1 FROM ${affiliations} WHERE ${and(
    eq(affiliations.personId, people.id),
    activeInScope(scope),
  )})`;
  return and(eq(people.status, 'active'), linked);
}

/** Active affiliations to campuses in a campus scope; no restriction for the whole church. */
function activeInScope(scope: Scope): SQL | undefined {
  if (scope.kind === 'church') return undefined;
  // An empty campus set sees nothing; it never widens to the whole church.
  if (scope.campusIds.length === 0) return sql`false`;
  return and(isNull(affiliations.endedAt), inArray(affiliations.campusId, [...scope.campusIds]));
}
