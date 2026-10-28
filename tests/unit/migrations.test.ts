import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { f001Ddl } from '../support/f001-schema.ts';

/*
 * The committed migration chain (TS-F001-35 static part): ordered, additive only, and the
 * generated M01a tables migration still matches src/db/schema.ts. The compatibility proofs
 * run on that same generated DDL, so they apply to the committed migration.
 */
const migration = (tag: string) => readFileSync(`drizzle/${tag}.sql`, 'utf8');
const statements = (sql: string) =>
  sql
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter(Boolean);

interface Journal {
  entries: { idx: number; tag: string }[];
}
const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as Journal;

describe('migration chain', () => {
  it('orders M00, then the M01a tables, then M01a integrity', () => {
    expect(journal.entries.map((e) => [e.idx, e.tag])).toEqual([
      [0, '0000_m00_foundation'],
      [1, '0001_m01a_tables'],
      [2, '0002_m01a_integrity'],
    ]);
  });

  it('keeps 0001_m01a_tables equal to the schema, minus CREATE SCHEMA (owned by M00)', async () => {
    const generated = (await f001Ddl())
      .map((s) => s.trim())
      .filter((s) => s !== 'CREATE SCHEMA "chms";');
    // Same statements; the CLI orders CREATE TABLE alphabetically, the API by export order.
    // Foreign keys are added afterwards by ALTER TABLE in both, so table order does not matter.
    expect(statements(migration('0001_m01a_tables')).sort()).toEqual(generated.sort());
  });

  it('is additive: no migration drops, deletes or truncates', () => {
    for (const { tag } of journal.entries) {
      const destructive = statements(migration(tag)).filter((s) =>
        /^\s*(DROP|TRUNCATE|DELETE)\b|\bDROP\s+(TABLE|COLUMN|SCHEMA|CONSTRAINT|INDEX)\b/i.test(s),
      );
      expect({ tag, destructive }).toEqual({ tag, destructive: [] });
    }
  });

  it('stays plain ASCII', () => {
    for (const { tag } of journal.entries) {
      expect({ tag, offending: migration(tag).match(/[^ -~\n\t]/gu) ?? [] }).toEqual({
        tag,
        offending: [],
      });
    }
  });
});
