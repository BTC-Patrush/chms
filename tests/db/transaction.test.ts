import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { churches } from '../../src/db/schema.ts';
import {
  NestedTransactionError,
  TransactionRolledBackError,
  withTransaction,
} from '../../src/db/transaction.ts';
import { createTestDatabase, type TestDatabase } from '../support/cluster.ts';
import { applyF001Schema } from '../support/f001-schema.ts';

describe('withTransaction (ADR-004 service transaction wrapper)', () => {
  let db: TestDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    db = await createTestDatabase();
    const admin = await db.connectAdmin();
    await applyF001Schema(admin);
    await admin.end();
    pool = new pg.Pool({ ...db.adminConfig, max: 1 });
  });

  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE chms.churches CASCADE');
  });

  const churchNames = async () =>
    (await pool.query<{ name: string }>('SELECT name FROM chms.churches ORDER BY name')).rows.map(
      (r) => r.name,
    );

  it('TS-F001-33: an error caught inside the callback makes the call reject and leaves the database unchanged', async () => {
    const call = withTransaction(pool, { actorCategory: 'maintenance' }, async (tx) => {
      await tx.insert(churches).values({ name: 'Grace Fellowship' });
      try {
        await tx.execute(sql`SELECT 1 / 0`);
      } catch {
        // Deliberately breaks the ADR-004 rule to reproduce drizzle-orm #6572.
      }
      return 'reported success';
    });
    await expect(call).rejects.toBeInstanceOf(TransactionRolledBackError);
    expect(await churchNames()).toEqual([]);
  });

  it('commits successful work and returns its result', async () => {
    const result = await withTransaction(pool, {}, async (tx) => {
      await tx.insert(churches).values({ name: 'Grace Fellowship' });
      return 42;
    });
    expect(result).toBe(42);
    expect(await churchNames()).toEqual(['Grace Fellowship']);
  });

  it('rolls back and rethrows the original database error unchanged', async () => {
    const call = withTransaction(pool, {}, async (tx) => {
      await tx.insert(churches).values({ name: 'First' });
      await tx.insert(churches).values({ name: 'Second' }); // churches_singleton_uq
    });
    await expect(call).rejects.toMatchObject({
      cause: { code: '23505', constraint: 'churches_singleton_uq' },
    });
    expect(await churchNames()).toEqual([]);
  });

  it('rolls back on an application error and keeps the connection usable', async () => {
    const call = withTransaction(pool, {}, async (tx) => {
      await tx.insert(churches).values({ name: 'Grace Fellowship' });
      throw new Error('domain rule violated');
    });
    await expect(call).rejects.toThrow('domain rule violated');
    expect(await churchNames()).toEqual([]);
    expect(pool.totalCount).toBe(1); // the single pooled connection was kept, not discarded
  });

  it('rejects nested transactions instead of committing the outer transaction early', async () => {
    const call = withTransaction(pool, {}, async (tx) => {
      await tx.insert(churches).values({ name: 'Grace Fellowship' });
      const nested = (tx as unknown as { transaction: () => Promise<void> }).transaction;
      await nested();
    });
    await expect(call).rejects.toBeInstanceOf(NestedTransactionError);
    expect(await churchNames()).toEqual([]);
  });

  it('declares the actor category for one transaction only (ADR-005)', async () => {
    const inside = await withTransaction(pool, { actorCategory: 'bootstrap' }, async (tx) => {
      const { rows } = await tx.execute<{ v: string }>(
        sql`SELECT current_setting('chms.actor_category', true) AS v`,
      );
      return rows[0]?.v;
    });
    const after = await withTransaction(pool, {}, async (tx) => {
      const { rows } = await tx.execute<{ v: string | null }>(
        sql`SELECT current_setting('chms.actor_category', true) AS v`,
      );
      return rows[0]?.v;
    });
    expect(inside).toBe('bootstrap');
    expect(after).toBe(''); // same pooled connection; the declaration did not persist
  });
});
