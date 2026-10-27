import { beforeAll, describe, expect, it } from 'vitest';
import { f001Ddl } from '../support/f001-schema.ts';

/*
 * CP-03 regression: the SQL drizzle-kit generates from src/db/schema.ts matches the
 * CHMS-F001 database design (section 2) and stays reviewable.
 */
describe('CP-03 generated F001 DDL', () => {
  let ddl: string;

  beforeAll(async () => {
    ddl = (await f001Ddl()).join('\n');
  });

  it('is plain ASCII, so no invisible character can hide in a reviewed migration', () => {
    // Anything outside printable ASCII (space to tilde), newline and tab.
    expect(ddl.match(/[^ -~\n\t]/gu) ?? []).toEqual([]);
  });

  it('generates every id with uuidv7() (ADR-001) and never with gen_random_uuid()', () => {
    expect(ddl.match(/"id" uuid PRIMARY KEY DEFAULT uuidv7\(\) NOT NULL/g)).toHaveLength(4);
    expect(ddl).not.toMatch(/gen_random_uuid|uuidv4/);
  });

  it('declares every named constraint and index from the design', () => {
    const names = [
      'churches_singleton_ck',
      'churches_singleton_uq',
      'churches_name_ck',
      'campuses_church_fk',
      'campuses_name_ck',
      'campuses_status_ck',
      'campuses_archive_state_ck',
      'campuses_church_id_uq',
      'campuses_church_id_status_uq',
      'campuses_name_ci_uq',
      'people_church_fk',
      'people_display_name_ck',
      'people_given_name_ck',
      'people_family_name_ck',
      'people_status_ck',
      'people_archive_state_ck',
      'people_church_id_uq',
      'people_church_id_status_uq',
      'pca_person_status_ck',
      'pca_campus_status_ck',
      'pca_end_reason_ck',
      'pca_lifecycle_ck',
      'pca_person_fk',
      'pca_campus_fk',
      'pca_person_active_fk',
      'pca_campus_active_fk',
      'pca_active_pair_uq',
      'pca_active_primary_uq',
      'pca_person_ix',
      'pca_campus_ix',
    ];
    for (const name of names) expect(ddl).toContain(`"${name}"`);
  });

  it('makes every foreign key ON DELETE RESTRICT ON UPDATE RESTRICT', () => {
    const fks = ddl.split('\n').filter((line) => line.includes('FOREIGN KEY'));
    expect(fks).toHaveLength(6);
    for (const fk of fks) expect(fk).toContain('ON DELETE restrict ON UPDATE restrict');
  });

  it('carries status in the archive foreign keys (ADR-004)', () => {
    expect(ddl).toContain(
      'ADD CONSTRAINT "pca_person_active_fk" FOREIGN KEY ("church_id","person_id","person_status") REFERENCES "chms"."people"("church_id","id","status")',
    );
    expect(ddl).toContain(
      'ADD CONSTRAINT "pca_campus_active_fk" FOREIGN KEY ("church_id","campus_id","campus_status") REFERENCES "chms"."campuses"("church_id","id","status")',
    );
  });

  it('builds the partial and expression unique indexes', () => {
    expect(ddl).toMatch(
      /"campuses_name_ci_uq" ON "chms"\."campuses" USING btree \("church_id",casefold\("name"\)\)/,
    );
    expect(ddl).toMatch(
      /"pca_active_pair_uq" .*\("person_id","campus_id"\) WHERE .*"ended_at" IS NULL/,
    );
    expect(ddl).toMatch(
      /"pca_active_primary_uq" .*\("person_id"\) WHERE .*"is_primary" AND .*"ended_at" IS NULL/,
    );
  });

  it('applies the approved name rules to all five name columns (PPD-01)', () => {
    expect(ddl.match(/IS NFC NORMALIZED AND char_length\([^)]+\) BETWEEN 1 AND 100/g)).toHaveLength(
      5,
    );
    // Expected patterns written as hex code points; the backslash is added explicitly.
    const esc = (hex: string) => `${String.fromCodePoint(0x5c)}u${hex}`;
    const whiteSpace = `[${esc('0009')}-${esc('000D')}${esc('0020')}${esc('0085')}${esc('00A0')}${esc('1680')}${esc('2000')}-${esc('200A')}${esc('2028')}${esc('2029')}${esc('202F')}${esc('205F')}${esc('3000')}]`;
    const control = `[${esc('0001')}-${esc('001F')}${esc('007F')}-${esc('009F')}]`;
    expect(ddl.split(`'^${whiteSpace}|${whiteSpace}$'`)).toHaveLength(6);
    expect(ddl.split(`!~ '${control}'`)).toHaveLength(6);
  });
});
