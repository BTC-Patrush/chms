import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../support/cluster.ts';

// CP-02: functions required by ADR-001, ADR-005 and ADR-008 exist on PostgreSQL 18.
describe('CP-02 required PostgreSQL 18 functions', () => {
  let db: TestDatabase;
  let client: pg.Client;

  beforeAll(async () => {
    db = await createTestDatabase();
    client = await db.connectAdmin();
  });

  afterAll(async () => {
    await client.end();
    await db.drop();
  });

  it('runs PostgreSQL 18 with UTF8 and the builtin locale provider', async () => {
    const { rows } = await client.query<{
      version: number;
      encoding: string;
      provider: string;
      locale: string;
    }>(
      `SELECT current_setting('server_version_num')::int AS version,
              current_setting('server_encoding') AS encoding,
              datlocprovider AS provider, datlocale AS locale
         FROM pg_database WHERE datname = current_database()`,
    );
    expect(rows[0]?.version).toBeGreaterThanOrEqual(180000);
    expect(rows[0]?.version).toBeLessThan(190000);
    expect(rows[0]).toMatchObject({ encoding: 'UTF8', provider: 'b', locale: 'PG_UNICODE_FAST' });
  });

  it('generates version-7 UUIDs with uuidv7(), including as a column default (ADR-001)', async () => {
    await client.query('CREATE TABLE cp02_ids (id uuid PRIMARY KEY DEFAULT uuidv7(), n int)');
    await client.query('INSERT INTO cp02_ids (n) SELECT g FROM generate_series(1, 50) AS g');
    const { rows } = await client.query<{ versions: number[]; age_seconds: number }>(
      `SELECT array_agg(DISTINCT uuid_extract_version(id)) AS versions,
              max(extract(epoch FROM now() - uuid_extract_timestamp(id))) AS age_seconds
         FROM cp02_ids`,
    );
    expect(rows[0]?.versions).toEqual([7]);
    expect(Math.abs(rows[0]?.age_seconds ?? Infinity)).toBeLessThan(60);
  });

  it('returns xid8 from pg_current_xact_id() (ADR-005 audit xact_id)', async () => {
    const { rows } = await client.query<{ type: string }>(
      'SELECT pg_typeof(pg_current_xact_id())::text AS type',
    );
    expect(rows[0]?.type).toBe('xid8');
  });

  it('provides casefold() (ADR-008)', async () => {
    const { rows } = await client.query<{ folded: string }>(
      "SELECT casefold('North CAMPUS') AS folded",
    );
    expect(rows[0]?.folded).toBe('north campus');
  });
});
