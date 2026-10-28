import { eq, sql } from 'drizzle-orm';
import type pg from 'pg';
import { churches } from '../db/schema.ts';
import { nextVersion, runService, single } from '../db/service.ts';
import type { TransactionDatabase } from '../db/transaction.ts';
import { DomainError, unmatched } from '../domain/errors.ts';
import { parseName, parseRowVersion } from '../domain/input.ts';

/*
 * Operator commands for the installation's single church (BR-01, BR-09; ADR-003). There is no
 * path that deletes or replaces the church (POL-05).
 */

export type Church = typeof churches.$inferSelect;

export interface BootstrapResult {
  readonly church: Church;
  /** False when the church already existed with the same name and nothing changed. */
  readonly created: boolean;
}

/**
 * Creates the church once (ADR-003 decision 3). `ownerPool` must connect as chms_owner; the
 * system actor is `bootstrap`. Rerunning with the same name changes nothing and writes no
 * audit event; a different name fails with ChurchMismatch. A concurrent bootstrap that loses
 * the race fails with ChurchAlreadyExists.
 */
export async function bootstrapChurch(
  ownerPool: pg.Pool,
  input: { readonly name: string },
): Promise<BootstrapResult> {
  const name = parseName('name', input.name);
  return runService(ownerPool, { actorCategory: 'bootstrap' }, async (tx) => {
    const [existing] = await tx.select().from(churches);
    if (existing !== undefined) {
      if (existing.name !== name) throw new DomainError('ChurchMismatch');
      return { church: existing, created: false };
    }
    const { rows } = await tx.execute<{ id: string }>(
      sql`INSERT INTO chms.churches (name) VALUES (${name}) RETURNING id`,
    );
    return { church: await churchById(tx, single(rows).id), created: true };
  });
}

/** Renames the church (BR-09, ADR-003 decision 5); the system actor is `maintenance`. */
export async function renameChurch(
  pool: pg.Pool,
  input: { readonly rowVersion: number; readonly name: string },
): Promise<Church> {
  const rowVersion = parseRowVersion(input.rowVersion);
  const name = parseName('name', input.name);
  return runService(pool, { actorCategory: 'maintenance' }, async (tx) => {
    const [church] = await tx
      .update(churches)
      .set({ name, ...nextVersion(churches.rowVersion) })
      .where(eq(churches.rowVersion, rowVersion))
      .returning();
    if (church !== undefined) return church;
    const [current] = await tx.select({ rowVersion: churches.rowVersion }).from(churches);
    throw unmatched(current, rowVersion, 'ChurchNotFound');
  });
}

async function churchById(tx: TransactionDatabase, id: string): Promise<Church> {
  return single(await tx.select().from(churches).where(eq(churches.id, id)));
}
