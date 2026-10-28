import type pg from 'pg';

/** Transaction-local system actor declarations (ADR-005). */
export const BOOTSTRAP = { 'chms.actor_category': 'bootstrap' };
export const MAINTENANCE = { 'chms.actor_category': 'maintenance' };

/**
 * Runs `work` in one transaction on `client`, first declaring each setting with
 * set_config(..., true), as services will. Rolls back and rethrows on failure.
 */
export async function inTransaction<T>(
  client: pg.Client,
  settings: Record<string, string>,
  work: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    for (const [name, value] of Object.entries(settings)) {
      await client.query('SELECT set_config($1, $2, true)', [name, value]);
    }
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** Runs a query that must return at least one row and returns the first. */
export async function firstRow<T extends pg.QueryResultRow>(
  client: pg.Client,
  text: string,
  values: unknown[] = [],
): Promise<T> {
  const { rows } = await client.query<T>(text, values);
  const row = rows[0];
  if (row === undefined) throw new Error(`Query returned no row: ${text}`);
  return row;
}
