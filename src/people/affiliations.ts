import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type pg from 'pg';
import { people, personCampusAffiliations as affiliations } from '../db/schema.ts';
import { nextVersion, runService, single } from '../db/service.ts';
import type { TransactionDatabase } from '../db/transaction.ts';
import { DomainError, unmatched } from '../domain/errors.ts';
import { parseActorCategory, parseBoolean, parseId, parseRowVersion } from '../domain/input.ts';

/*
 * Person-campus affiliation services (BR-03 to BR-06). Ended affiliations are history and
 * never change; re-linking creates a new row.
 */

export type Affiliation = typeof affiliations.$inferSelect;

export interface AffiliationVersion {
  readonly id: string;
  readonly rowVersion: number;
}

export interface SetPrimaryResult {
  readonly affiliation: Affiliation;
  /** The person's previous active primary affiliation, now no longer primary. */
  readonly previousPrimaryId: string | null;
}

/**
 * Links an active person to an active campus. Fails with CampusArchived or PersonArchived
 * (23503), AffiliationExists or PrimaryAffiliationExists (23505); use setPrimaryAffiliation to
 * move the primary.
 */
export async function linkPersonToCampus(
  pool: pg.Pool,
  actorCategory: string,
  input: { readonly personId: string; readonly campusId: string; readonly isPrimary?: boolean },
): Promise<Affiliation> {
  const actor = parseActorCategory(actorCategory);
  const personId = parseId('personId', input.personId);
  const campusId = parseId('campusId', input.campusId);
  const isPrimary = parseBoolean('isPrimary', input.isPrimary ?? false);
  return runService(pool, { actorCategory: actor }, async (tx) => {
    // Column-level grants: name only the granted columns. The join supplies the shared
    // church_id; the status-carrying foreign keys reject archived people and campuses.
    const { rows } = await tx.execute<{ id: string }>(
      sql`INSERT INTO chms.person_campus_affiliations (church_id, person_id, campus_id, is_primary)
          SELECT p.church_id, p.id, c.id, ${isPrimary}::boolean
            FROM chms.people p JOIN chms.campuses c ON c.church_id = p.church_id
           WHERE p.id = ${personId} AND c.id = ${campusId}
          RETURNING id`,
    );
    const [created] = rows;
    if (created === undefined) {
      const [person] = await tx
        .select({ id: people.id })
        .from(people)
        .where(eq(people.id, personId));
      throw new DomainError(person === undefined ? 'PersonNotFound' : 'CampusNotFound');
    }
    return affiliationById(tx, created.id);
  });
}

/** Ends an active affiliation with reason `ended`. The row is kept, with its is_primary. */
export async function endAffiliation(
  pool: pg.Pool,
  actorCategory: string,
  input: AffiliationVersion,
): Promise<Affiliation> {
  const actor = parseActorCategory(actorCategory);
  const id = parseId('id', input.id);
  const rowVersion = parseRowVersion(input.rowVersion);
  return runService(pool, { actorCategory: actor }, async (tx) => {
    const [ended] = await tx
      .update(affiliations)
      .set({
        endedAt: sql`now()`,
        endReason: 'ended',
        personStatus: null,
        campusStatus: null,
        ...nextVersion(affiliations.rowVersion),
      })
      .where(
        and(
          eq(affiliations.id, id),
          eq(affiliations.rowVersion, rowVersion),
          isNull(affiliations.endedAt),
        ),
      )
      .returning();
    return ended ?? failUnmatched(tx, id, rowVersion);
  });
}

/**
 * Makes an active affiliation the person's primary one, in one transaction: (1) the person's
 * current primary, if it is another affiliation, stops being primary; (2) this affiliation
 * becomes primary, if its row_version still matches. A concurrent change of primary for the
 * same person makes one of the two fail with PrimaryAffiliationExists (23505).
 */
export async function setPrimaryAffiliation(
  pool: pg.Pool,
  actorCategory: string,
  input: AffiliationVersion,
): Promise<SetPrimaryResult> {
  const actor = parseActorCategory(actorCategory);
  const id = parseId('id', input.id);
  const rowVersion = parseRowVersion(input.rowVersion);
  return runService(pool, { actorCategory: actor }, async (tx) => {
    const [target] = await tx
      .select({ personId: affiliations.personId })
      .from(affiliations)
      .where(eq(affiliations.id, id));
    if (target === undefined) throw new DomainError('AffiliationNotFound');
    const cleared = await tx
      .update(affiliations)
      .set({ isPrimary: false, ...nextVersion(affiliations.rowVersion) })
      .where(
        and(
          eq(affiliations.personId, target.personId),
          eq(affiliations.isPrimary, true),
          isNull(affiliations.endedAt),
          ne(affiliations.id, id),
        ),
      )
      .returning({ id: affiliations.id });
    const [affiliation] = await tx
      .update(affiliations)
      .set({ isPrimary: true, ...nextVersion(affiliations.rowVersion) })
      .where(
        and(
          eq(affiliations.id, id),
          eq(affiliations.rowVersion, rowVersion),
          isNull(affiliations.endedAt),
        ),
      )
      .returning();
    if (affiliation === undefined) return failUnmatched(tx, id, rowVersion);
    return { affiliation, previousPrimaryId: cleared[0]?.id ?? null };
  });
}

async function affiliationById(tx: TransactionDatabase, id: string): Promise<Affiliation> {
  return single(await tx.select().from(affiliations).where(eq(affiliations.id, id)));
}

async function failUnmatched(
  tx: TransactionDatabase,
  id: string,
  rowVersion: number,
): Promise<never> {
  const [current] = await tx
    .select({ rowVersion: affiliations.rowVersion })
    .from(affiliations)
    .where(eq(affiliations.id, id));
  throw unmatched(current, rowVersion, 'AffiliationNotFound', 'AffiliationEnded');
}
