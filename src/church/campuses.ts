import { and, eq, sql, type SQL } from 'drizzle-orm';
import type pg from 'pg';
import { campuses } from '../db/schema.ts';
import { nextVersion, runService, single } from '../db/service.ts';
import type { TransactionDatabase } from '../db/transaction.ts';
import { DomainError, unmatched, type DomainErrorCode } from '../domain/errors.ts';
import { parseActorCategory, parseId, parseName, parseRowVersion } from '../domain/input.ts';

/*
 * Campus services (BR-01, BR-06, BR-07). Each write takes a system actor category and runs as
 * chms_app; each update checks the caller's row_version.
 */

export type Campus = typeof campuses.$inferSelect;

export interface CampusVersion {
  readonly id: string;
  readonly rowVersion: number;
}

/**
 * Creates an active campus. A name equal to another campus's under casefold(), archived
 * campuses included, fails with CampusNameTaken (BR-07).
 */
export async function createCampus(
  pool: pg.Pool,
  actorCategory: string,
  input: { readonly name: string },
): Promise<Campus> {
  const actor = parseActorCategory(actorCategory);
  const name = parseName('name', input.name);
  return runService(pool, { actorCategory: actor }, async (tx) => {
    // Column-level grants: name only the granted columns (database design section 5).
    const { rows } = await tx.execute<{ id: string }>(
      sql`INSERT INTO chms.campuses (church_id, name)
          SELECT id, ${name}::text FROM chms.churches
          RETURNING id`,
    );
    const [created] = rows;
    if (created === undefined) throw new DomainError('ChurchNotFound');
    return single(await tx.select().from(campuses).where(eq(campuses.id, created.id)));
  });
}

export async function renameCampus(
  pool: pg.Pool,
  actorCategory: string,
  input: CampusVersion & { readonly name: string },
): Promise<Campus> {
  const name = parseName('name', input.name);
  return updateCampus(pool, actorCategory, input, { name });
}

/** Archives a campus; CampusHasActiveAffiliations while any link is active (BR-06). */
export async function archiveCampus(
  pool: pg.Pool,
  actorCategory: string,
  input: CampusVersion,
): Promise<Campus> {
  return updateCampus(
    pool,
    actorCategory,
    input,
    { status: 'archived', archivedAt: sql`now()` },
    { status: 'active', otherwise: 'CampusArchived' },
  );
}

/** Unarchives a campus. Ended affiliations stay ended. */
export async function unarchiveCampus(
  pool: pg.Pool,
  actorCategory: string,
  input: CampusVersion,
): Promise<Campus> {
  return updateCampus(
    pool,
    actorCategory,
    input,
    { status: 'active', archivedAt: null },
    { status: 'archived', otherwise: 'CampusNotArchived' },
  );
}

interface StatusGuard {
  readonly status: 'active' | 'archived';
  readonly otherwise: DomainErrorCode;
}

async function updateCampus(
  pool: pg.Pool,
  actorCategory: string,
  input: CampusVersion,
  values: { name?: string; status?: string; archivedAt?: SQL | null },
  guard?: StatusGuard,
): Promise<Campus> {
  const actor = parseActorCategory(actorCategory);
  const id = parseId('id', input.id);
  const rowVersion = parseRowVersion(input.rowVersion);
  return runService(pool, { actorCategory: actor }, async (tx) => {
    const [campus] = await tx
      .update(campuses)
      .set({ ...values, ...nextVersion(campuses.rowVersion) })
      .where(
        and(
          eq(campuses.id, id),
          eq(campuses.rowVersion, rowVersion),
          guard && eq(campuses.status, guard.status),
        ),
      )
      .returning();
    return campus ?? failUnmatched(tx, id, rowVersion, guard?.otherwise);
  });
}

async function failUnmatched(
  tx: TransactionDatabase,
  id: string,
  rowVersion: number,
  wrongState?: DomainErrorCode,
): Promise<never> {
  const [current] = await tx
    .select({ rowVersion: campuses.rowVersion })
    .from(campuses)
    .where(eq(campuses.id, id));
  throw unmatched(current, rowVersion, 'CampusNotFound', wrongState);
}
