import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  type BuiltinLocale,
  type TestDatabase,
} from '../../support/cluster.ts';
import { applyF001Schema } from '../../support/f001-schema.ts';
import { pgFailure } from '../../support/pg-assert.ts';

/*
 * CP-08: case comparison, normalization, whitespace and control-character rules (PPD-01,
 * ADR-008) on PostgreSQL 18 with the builtin locale provider. Covers the database part of
 * TS-F001-07; boundary trimming and normalization are service work (TS-F001-14).
 * Non-ASCII characters are built from code points so this file stays ASCII.
 */
const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const SHARP_S = cp(0xdf);
const CAPITAL_I_DOT = cp(0x130);
const CAPITAL_SIGMA = cp(0x3a3);
const SMALL_SIGMA = cp(0x3c3);
const FINAL_SIGMA = cp(0x3c2);
const E_ACUTE = cp(0xe9); // NFC
const E_ACUTE_NFD = `e${cp(0x301)}`;
const NBSP = cp(0xa0);

describe('CP-08 casefold() suitability for the unique index', () => {
  it('declares casefold() and lower() IMMUTABLE, as an index expression requires', async () => {
    const db = await createTestDatabase();
    const client = await db.connectAdmin();
    try {
      const { rows } = await client.query<{ proname: string; provolatile: string }>(
        "SELECT proname, provolatile FROM pg_proc WHERE proname IN ('casefold', 'lower') AND pronamespace = 'pg_catalog'::regnamespace AND prorettype = 'text'::regtype ORDER BY proname",
      );
      expect(rows).toEqual([
        { proname: 'casefold', provolatile: 'i' },
        { proname: 'lower', provolatile: 'i' },
      ]);
    } finally {
      await client.end();
      await db.drop();
    }
  });
});

const locales: BuiltinLocale[] = ['PG_UNICODE_FAST', 'C.UTF-8'];

describe.each(locales)('CP-08 name rules with builtin locale %s', (locale) => {
  let db: TestDatabase;
  let client: pg.Client;
  let churchId: string;

  beforeAll(async () => {
    db = await createTestDatabase(locale);
    client = await db.connectAdmin();
    await applyF001Schema(client); // includes the casefold() unique index
    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO chms.churches (name) VALUES ('Grace Fellowship') RETURNING id",
    );
    churchId = rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await client.end();
    await db.drop();
  });

  const fold = async (fn: 'casefold' | 'lower', a: string, b: string) => {
    const { rows } = await client.query<{ equal: boolean }>(
      `SELECT ${fn}($1) = ${fn}($2) AS equal`,
      [a, b],
    );
    return rows[0]?.equal;
  };

  const insertCampus = (name: string) =>
    client.query('INSERT INTO chms.campuses (church_id, name) VALUES ($1, $2)', [churchId, name]);

  it('creates the casefold() unique index (index-usable)', async () => {
    const { rows } = await client.query<{ def: string }>(
      "SELECT pg_get_indexdef('chms.campuses_name_ci_uq'::regclass) AS def",
    );
    expect(rows[0]?.def).toContain('casefold(name)');
  });

  it('records casefold() and lower() comparisons for the TS-F001-07 strings', async () => {
    const pairs: [string, string, string][] = [
      ['North / NORTH', 'North', 'NORTH'],
      ['sharp s / SS', `Stra${SHARP_S}e`, 'STRASSE'],
      ['capital I with dot / i', `${CAPITAL_I_DOT}zmir`, 'izmir'],
      ['capital / small sigma', `${CAPITAL_SIGMA}A`, `${SMALL_SIGMA}a`],
      ['final / small sigma', `a${FINAL_SIGMA}`, `a${SMALL_SIGMA}`],
    ];
    const observed: Record<string, { casefold: boolean | undefined; lower: boolean | undefined }> =
      {};
    for (const [label, a, b] of pairs) {
      observed[label] = {
        casefold: await fold('casefold', a, b),
        lower: await fold('lower', a, b),
      };
    }
    const fullFolding = locale === 'PG_UNICODE_FAST';
    expect(observed).toEqual({
      'North / NORTH': { casefold: true, lower: true },
      'sharp s / SS': { casefold: fullFolding, lower: false },
      // Simple case folding has no mapping for U+0130; full folding maps it to "i" + U+0307.
      'capital I with dot / i': { casefold: false, lower: !fullFolding },
      'capital / small sigma': { casefold: true, lower: true },
      'final / small sigma': { casefold: true, lower: false },
    });
  });

  it('rejects case variants of an existing campus name, archived names included (BR-07)', async () => {
    await insertCampus('North');
    for (const variant of ['north', 'NORTH', 'nOrTh']) {
      expect(await pgFailure(insertCampus(variant))).toMatchObject({
        code: '23505',
        constraint: 'campuses_name_ci_uq',
      });
    }
    await client.query(
      "UPDATE chms.campuses SET status = 'archived', archived_at = now() WHERE name = 'North'",
    );
    expect(await pgFailure(insertCampus('NORTH'))).toMatchObject({
      code: '23505',
      constraint: 'campuses_name_ci_uq',
    });
    const { rows } = await client.query<{ name: string }>(
      "SELECT name FROM chms.campuses WHERE casefold(name) = 'north'",
    );
    expect(rows).toEqual([{ name: 'North' }]); // capitalization preserved
  });

  it('enforces the approved name rules in the database (PPD-01)', async () => {
    const rejected: [string, string][] = [
      ['empty', ''],
      ['leading space', ' East'],
      ['trailing space', 'East '],
      ['leading tab', '\tEast'],
      ['trailing no-break space', `East${NBSP}`],
      ['trailing ideographic space', `East${cp(0x3000)}`],
      ['leading line separator', `${cp(0x2028)}East`],
      ['internal tab (control)', 'Ea\tst'],
      ['internal U+0001 (control)', `Ea${cp(0x01)}st`],
      ['internal DEL (control)', `Ea${cp(0x7f)}st`],
      ['internal NEL (control)', `Ea${cp(0x85)}st`],
      ['not NFC', `Caf${E_ACUTE_NFD}`],
      ['101 code points', E_ACUTE.repeat(101)],
    ];
    for (const [label, name] of rejected) {
      const failure = await pgFailure(insertCampus(name));
      expect({ label, code: failure.code, constraint: failure.constraint }).toEqual({
        label,
        code: '23514',
        constraint: 'campuses_name_ck',
      });
    }
    const accepted = [
      'East  Campus', // internal double space kept
      `West${NBSP}Campus`, // internal no-break space kept
      `Caf${E_ACUTE}`,
      E_ACUTE.repeat(100), // 100 code points, 200 bytes
      'MiXeD CaSe Campus',
    ];
    for (const name of accepted) await insertCampus(name);
    const { rows } = await client.query<{ name: string }>(
      'SELECT name FROM chms.campuses WHERE name = ANY($1)',
      [accepted],
    );
    expect(rows.map((r) => r.name).sort()).toEqual([...accepted].sort());
  });
});
