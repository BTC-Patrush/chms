import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../../support/cluster.ts';
import { applyF001Schema } from '../../support/f001-schema.ts';

const { churches } = schema;

// CP-05: pg 8.x and Drizzle transaction behaviour that ADR-004 and ADR-005 rely on.
describe('CP-05 driver and Drizzle transactions', () => {
  let db: TestDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    db = await createTestDatabase();
    const admin = await db.connectAdmin();
    await applyF001Schema(admin);
    await admin.end();
    pool = new pg.Pool({ ...db.adminConfig, max: 2 });
  });

  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE chms.churches CASCADE');
  });

  const churchCount = async () => {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM chms.churches',
    );
    return rows[0]?.n;
  };

  it('keeps set_config(…, true) transaction-local on a reused connection', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('chms.actor_category', 'maintenance', true)");
      const inside = await client.query<{ v: string }>(
        "SELECT current_setting('chms.actor_category', true) AS v",
      );
      await client.query('COMMIT');
      const after = await client.query<{ v: string | null }>(
        "SELECT current_setting('chms.actor_category', true) AS v",
      );
      expect(inside.rows[0]?.v).toBe('maintenance');
      // Once defined in the session, the placeholder reads as an empty string, not NULL.
      expect(after.rows[0]?.v).toBe('');
    } finally {
      client.release();
    }
  });

  it('keeps a session-level SET across transactions (documented ADR-005 limitation)', async () => {
    const client = await pool.connect();
    try {
      await client.query("SET chms.actor_category = 'maintenance'");
      await client.query('BEGIN');
      const inside = await client.query<{ v: string }>(
        "SELECT current_setting('chms.actor_category', true) AS v",
      );
      await client.query('COMMIT');
      expect(inside.rows[0]?.v).toBe('maintenance');
    } finally {
      client.release(true); // discard: the connection now carries a session setting
    }
  });

  it('drizzle-orm #6572: db.transaction() resolves although PostgreSQL rolled back', async () => {
    const orm = drizzle(pool, { schema });
    const outcome = await orm
      .transaction(async (tx) => {
        await tx.insert(churches).values({ name: 'Grace Fellowship' });
        try {
          await tx.execute(sql`SELECT 1 / 0`);
        } catch {
          // Deliberately breaks the ADR-004 rule: catch inside the callback and continue.
        }
      })
      .then(
        () => 'resolved',
        (error: unknown) => `rejected: ${String(error)}`,
      );
    // Reproduced on drizzle-orm 0.45.4, pg 8.23.1, PostgreSQL 18.6: the call resolves,
    // but nothing was committed. withTransaction() detects this (TS-F001-33).
    expect(outcome).toBe('resolved');
    expect(await churchCount()).toBe(0);
  });

  it('records PostgreSQL answering COMMIT with ROLLBACK after a failed statement', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 / 0').catch(() => undefined);
      const commit = await client.query('COMMIT');
      expect(commit.command).toBe('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('nested tx.transaction() uses a savepoint: a rethrown inner error rolls back only the inner work', async () => {
    const orm = drizzle(pool, { schema });
    await orm.transaction(async (tx) => {
      await tx.insert(churches).values({ name: 'Outer Church' });
      await tx
        .transaction(async (inner) => {
          await inner.execute(sql`UPDATE chms.churches SET name = 'Inner Name'`);
          throw new Error('inner failure');
        })
        .catch(() => undefined);
    });
    const { rows } = await pool.query<{ name: string }>('SELECT name FROM chms.churches');
    expect(rows).toEqual([{ name: 'Outer Church' }]);
  });

  it('nested tx.transaction(): a database error swallowed inside the inner callback fails at RELEASE SAVEPOINT', async () => {
    const orm = drizzle(pool, { schema });
    const outcome = await orm
      .transaction(async (tx) => {
        await tx.insert(churches).values({ name: 'Outer Church' });
        await tx.transaction(async (inner) => {
          try {
            await inner.execute(sql`SELECT 1 / 0`);
          } catch {
            // swallowed
          }
        });
      })
      .then(
        () => ({ resolved: true }),
        (error: unknown) => ({
          resolved: false,
          message: error instanceof Error ? error.message : String(error),
          causeCode:
            error instanceof Error && error.cause instanceof pg.DatabaseError
              ? error.cause.code
              : undefined,
        }),
      );
    // Drizzle wraps the failure; the cause is 25P02 (in_failed_sql_transaction).
    expect(outcome).toEqual({
      resolved: false,
      message: expect.stringContaining('release savepoint') as unknown,
      causeCode: '25P02',
    });
    expect(await churchCount()).toBe(0);
  });

  it('a Drizzle handle on a single checked-out connection opens no real nested transaction', async () => {
    // Drizzle's transaction() on a PoolClient issues BEGIN/COMMIT on that same connection.
    // Inside an outer transaction this would commit early, so withTransaction() blocks it.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orm = drizzle(client, { schema });
      await orm.transaction(async (tx) => {
        await tx.insert(churches).values({ name: 'Committed Early' });
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    // The outer ROLLBACK could not undo the insert: the inner COMMIT had ended the transaction.
    expect(await churchCount()).toBe(1);
  });
});
