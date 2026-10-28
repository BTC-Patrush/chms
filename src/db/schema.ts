import { sql, type SQL } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/*
 * CHMS-F001 schema: docs/database/CHMS-F001-database-design.md §2, ADR-001, ADR-003,
 * ADR-004 and ADR-008. Constraint names are part of the contract, because services map
 * database errors to domain errors by SQLSTATE plus constraint name.
 */

export const chms = pgSchema('chms');

/** Approved name length in Unicode code points after NFC and trimming (PPD-01). */
export const NAME_MAX_LENGTH = 100;

// Regular-expression escapes are built from code points at runtime, so the source stays
// ASCII and no editor or tool can silently turn an escape into an invisible character.
const BACKSLASH = String.fromCodePoint(0x5c);
const escapeCodePoint = (codePoint: number) =>
  `${BACKSLASH}u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
const escapeRange = (from: number, to: number) => `${escapeCodePoint(from)}-${escapeCodePoint(to)}`;

/** Unicode White_Space. btrim() removes only spaces, so trimming is enforced by pattern. */
export const WHITE_SPACE_CODE_POINTS = [
  [0x09, 0x0d],
  [0x20],
  [0x85],
  [0xa0],
  [0x1680],
  [0x2000, 0x200a],
  [0x2028],
  [0x2029],
  [0x202f],
  [0x205f],
  [0x3000],
] as const;
/** Unicode general category Cc. PostgreSQL text cannot contain U+0000. */
export const CONTROL_CODE_POINTS = [
  [0x01, 0x1f],
  [0x7f, 0x9f],
] as const;

const characterClass = (ranges: readonly (readonly [number] | readonly [number, number])[]) =>
  `[${ranges.map((r) => (r.length === 2 ? escapeRange(r[0], r[1]) : escapeCodePoint(r[0]))).join('')}]`;
const WHITE_SPACE = characterClass(WHITE_SPACE_CODE_POINTS);
const CONTROL = characterClass(CONTROL_CODE_POINTS);

/** Approved name rules (PPD-01, ADR-008): NFC, trimmed, no control characters, 1–100 code points. */
function nameRules(column: AnyPgColumn): SQL {
  return sql`${column} IS NFC NORMALIZED AND char_length(${column}) BETWEEN 1 AND ${sql.raw(String(NAME_MAX_LENGTH))} AND ${column} !~ ${sql.raw(`'^${WHITE_SPACE}|${WHITE_SPACE}$'`)} AND ${column} !~ ${sql.raw(`'${CONTROL}'`)}`;
}

function optionalNameRules(column: AnyPgColumn): SQL {
  return sql`${column} IS NULL OR (${nameRules(column)})`;
}

// Ids are generated only by the database (ADR-001: UUIDv7).
const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`);
const rowVersion = () => integer('row_version').notNull().default(1);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const churches = chms.table(
  'churches',
  {
    id: id(),
    singleton: boolean('singleton').notNull().default(true),
    name: text('name').notNull(),
    rowVersion: rowVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('churches_singleton_ck', sql`${t.singleton}`),
    unique('churches_singleton_uq').on(t.singleton),
    check('churches_name_ck', nameRules(t.name)),
    check('churches_row_version_ck', sql`${t.rowVersion} >= 1`),
  ],
);

export const campuses = chms.table(
  'campuses',
  {
    id: id(),
    churchId: uuid('church_id').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    rowVersion: rowVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ name: 'campuses_church_fk', columns: [t.churchId], foreignColumns: [churches.id] })
      .onUpdate('restrict')
      .onDelete('restrict'),
    check('campuses_name_ck', nameRules(t.name)),
    check('campuses_status_ck', sql`${t.status} IN ('active', 'archived')`),
    check(
      'campuses_archive_state_ck',
      sql`(${t.status} = 'archived') = (${t.archivedAt} IS NOT NULL)`,
    ),
    check('campuses_row_version_ck', sql`${t.rowVersion} >= 1`),
    unique('campuses_church_id_uq').on(t.churchId, t.id),
    unique('campuses_church_id_status_uq').on(t.churchId, t.id, t.status),
    // Case-insensitive, archived rows included (BR-07). casefold() or lower() per CP-08.
    uniqueIndex('campuses_name_ci_uq').on(t.churchId, sql`casefold(${t.name})`),
  ],
);

export const people = chms.table(
  'people',
  {
    id: id(),
    churchId: uuid('church_id').notNull(),
    displayName: text('display_name').notNull(),
    givenName: text('given_name'),
    familyName: text('family_name'),
    status: text('status').notNull().default('active'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    rowVersion: rowVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ name: 'people_church_fk', columns: [t.churchId], foreignColumns: [churches.id] })
      .onUpdate('restrict')
      .onDelete('restrict'),
    check('people_display_name_ck', nameRules(t.displayName)),
    check('people_given_name_ck', optionalNameRules(t.givenName)),
    check('people_family_name_ck', optionalNameRules(t.familyName)),
    check('people_status_ck', sql`${t.status} IN ('active', 'archived')`),
    check(
      'people_archive_state_ck',
      sql`(${t.status} = 'archived') = (${t.archivedAt} IS NOT NULL)`,
    ),
    check('people_row_version_ck', sql`${t.rowVersion} >= 1`),
    unique('people_church_id_uq').on(t.churchId, t.id),
    unique('people_church_id_status_uq').on(t.churchId, t.id, t.status),
  ],
);

export const personCampusAffiliations = chms.table(
  'person_campus_affiliations',
  {
    id: id(),
    churchId: uuid('church_id').notNull(),
    personId: uuid('person_id').notNull(),
    campusId: uuid('campus_id').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    // 'active' while the affiliation is active, NULL once ended (ADR-004).
    personStatus: text('person_status').default('active'),
    campusStatus: text('campus_status').default('active'),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endReason: text('end_reason'),
    rowVersion: rowVersion(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('pca_person_status_ck', sql`${t.personStatus} IS NULL OR ${t.personStatus} = 'active'`),
    check('pca_campus_status_ck', sql`${t.campusStatus} IS NULL OR ${t.campusStatus} = 'active'`),
    check(
      'pca_end_reason_ck',
      sql`${t.endReason} IS NULL OR ${t.endReason} IN ('ended', 'person_archived')`,
    ),
    check(
      'pca_lifecycle_ck',
      sql`(${t.endedAt} IS NULL AND ${t.endReason} IS NULL AND ${t.personStatus} = 'active' AND ${t.campusStatus} = 'active') OR (${t.endedAt} IS NOT NULL AND ${t.endReason} IS NOT NULL AND ${t.personStatus} IS NULL AND ${t.campusStatus} IS NULL)`,
    ),
    check('pca_row_version_ck', sql`${t.rowVersion} >= 1`),
    foreignKey({
      name: 'pca_person_fk',
      columns: [t.churchId, t.personId],
      foreignColumns: [people.churchId, people.id],
    })
      .onUpdate('restrict')
      .onDelete('restrict'),
    foreignKey({
      name: 'pca_campus_fk',
      columns: [t.churchId, t.campusId],
      foreignColumns: [campuses.churchId, campuses.id],
    })
      .onUpdate('restrict')
      .onDelete('restrict'),
    // Status-carrying keys (MATCH SIMPLE: ended rows have NULL status and are not checked).
    foreignKey({
      name: 'pca_person_active_fk',
      columns: [t.churchId, t.personId, t.personStatus],
      foreignColumns: [people.churchId, people.id, people.status],
    })
      .onUpdate('restrict')
      .onDelete('restrict'),
    foreignKey({
      name: 'pca_campus_active_fk',
      columns: [t.churchId, t.campusId, t.campusStatus],
      foreignColumns: [campuses.churchId, campuses.id, campuses.status],
    })
      .onUpdate('restrict')
      .onDelete('restrict'),
    uniqueIndex('pca_active_pair_uq')
      .on(t.personId, t.campusId)
      .where(sql`${t.endedAt} IS NULL`),
    uniqueIndex('pca_active_primary_uq')
      .on(t.personId)
      .where(sql`${t.isPrimary} AND ${t.endedAt} IS NULL`),
    index('pca_person_ix').on(t.personId),
    index('pca_campus_ix').on(t.campusId),
  ],
);
