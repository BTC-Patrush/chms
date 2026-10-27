import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

/** A Drizzle handle bound to one open transaction. Nested transactions are not available. */
export type TransactionDatabase = Omit<NodePgDatabase<typeof schema>, 'transaction' | '$client'>;

export interface TransactionOptions {
  /** System actor category for the audit trail; set with set_config(…, true) (ADR-005). */
  readonly actorCategory?: string;
}

/**
 * PostgreSQL answered COMMIT with ROLLBACK: a statement inside the transaction failed and
 * the failure was swallowed inside the callback (drizzle-orm #6572 pattern, TS-F001-33).
 */
export class TransactionRolledBackError extends Error {
  constructor() {
    super('PostgreSQL rolled the transaction back because a statement inside it failed');
    this.name = 'TransactionRolledBackError';
  }
}

export class NestedTransactionError extends Error {
  constructor() {
    super('Nested transactions are not supported inside withTransaction (ADR-004)');
    this.name = 'NestedTransactionError';
  }
}

/**
 * Runs `work` in one READ COMMITTED transaction on a dedicated pooled connection
 * (ADR-004). Unlike Drizzle's db.transaction(), the result of COMMIT is checked, so a
 * transaction that PostgreSQL rolled back is never reported as successful. Errors are
 * rethrown unchanged; callers map them to domain errors outside the transaction.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  options: TransactionOptions,
  work: (tx: TransactionDatabase) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discardConnection = false;
  // BEGIN or COMMIT failing without a PostgreSQL error means the connection is suspect.
  const control = async (statement: string) => {
    try {
      return await client.query(statement);
    } catch (error) {
      if (!(error instanceof pg.DatabaseError)) discardConnection = true;
      throw error;
    }
  };
  try {
    await control('BEGIN ISOLATION LEVEL READ COMMITTED');
    let result: T;
    try {
      if (options.actorCategory !== undefined) {
        await client.query("SELECT set_config('chms.actor_category', $1, true)", [
          options.actorCategory,
        ]);
      }
      result = await work(transactionDatabase(client));
    } catch (error) {
      discardConnection = !(await rollbackQuietly(client));
      throw error;
    }
    const commit = await control('COMMIT');
    if (commit.command !== 'COMMIT') throw new TransactionRolledBackError();
    return result;
  } finally {
    client.release(discardConnection);
  }
}

function transactionDatabase(client: pg.PoolClient): TransactionDatabase {
  const db = drizzle(client, { schema });
  // Drizzle would otherwise issue BEGIN/COMMIT on this same connection and commit early.
  Object.defineProperty(db, 'transaction', {
    value: () => Promise.reject(new NestedTransactionError()),
  });
  return db;
}

async function rollbackQuietly(client: pg.PoolClient): Promise<boolean> {
  try {
    await client.query('ROLLBACK');
    return true;
  } catch {
    return false;
  }
}
