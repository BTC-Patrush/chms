import { CONTROL_CODE_POINTS, NAME_MAX_LENGTH, WHITE_SPACE_CODE_POINTS } from '../db/schema.ts';
import { DomainError } from './errors.ts';

/*
 * Boundary schemas for the CHMS-F001 services. Every service parses its input here before
 * opening a transaction; the database checks the same rules again (ADR-008, PPD-01). Errors
 * name the field and the rule, never the value.
 */

const invalid = (field: string, rule: string) =>
  new DomainError('ValidationFailed', { field, rule });

type CodePointRanges = readonly (readonly [number] | readonly [number, number])[];
const inRanges = (ranges: CodePointRanges, codePoint: number) =>
  ranges.some((r) => codePoint >= r[0] && codePoint <= (r.length === 2 ? r[1] : r[0]));
const codePointOf = (char: string) => char.codePointAt(0) ?? 0;
const isWhiteSpace = (char: string) => inRanges(WHITE_SPACE_CODE_POINTS, codePointOf(char));
// U+0000 is Cc too. PostgreSQL text cannot hold it, so only the database check omits it.
const isControl = (char: string) =>
  codePointOf(char) === 0 || inRanges(CONTROL_CODE_POINTS, codePointOf(char));

/**
 * A required name under the approved rules (PPD-01, ADR-008 decision 3), in this order: reject
 * strings that are not well-formed Unicode, normalize to NFC, trim Unicode White_Space at both
 * ends, then require 1-100 code points and no control character. Internal whitespace and
 * capitalization are kept.
 */
export function parseName(field: string, value: unknown): string {
  if (value === undefined || value === null) throw invalid(field, 'required');
  if (typeof value !== 'string') throw invalid(field, 'not a string');
  if (!value.isWellFormed()) throw invalid(field, 'not well-formed Unicode');
  const chars = Array.from(value.normalize('NFC'));
  const first = chars.findIndex((c) => !isWhiteSpace(c));
  if (first === -1) throw invalid(field, 'empty');
  const name = chars.slice(first, chars.findLastIndex((c) => !isWhiteSpace(c)) + 1);
  if (name.some(isControl)) throw invalid(field, 'control character');
  if (name.length > NAME_MAX_LENGTH) throw invalid(field, 'longer than 100 characters');
  return name.join('');
}

/** An optional name component: absent or null means NULL; an empty string is rejected (BR-08). */
export function parseOptionalName(field: string, value: unknown): string | null {
  return value === undefined || value === null ? null : parseName(field, value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A row id in canonical UUID text form, returned in lower case. */
export function parseId(field: string, value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(field, 'not a UUID');
  return value.toLowerCase();
}

const INTEGER_MAX = 2_147_483_647;

/** The row_version a caller last read; every update checks it (ADR-004 decision 8). */
export function parseRowVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > INTEGER_MAX) {
    throw invalid('rowVersion', 'not a positive integer');
  }
  return value;
}

/** Same format as system_actor_categories_format_ck; the database allowlist decides the rest. */
const ACTOR_CATEGORY = /^[a-z][a-z0-9_-]{1,40}$/;

export function parseActorCategory(value: unknown): string {
  if (typeof value !== 'string' || !ACTOR_CATEGORY.test(value)) {
    throw invalid('actorCategory', 'not a system actor category');
  }
  return value;
}

/**
 * The explicit scope of every read: the whole church, or a set of campuses. An empty set of
 * campuses is valid and sees nobody.
 */
export type Scope =
  | { readonly kind: 'church' }
  | { readonly kind: 'campuses'; readonly campusIds: readonly string[] };

export function parseScope(value: unknown): Scope {
  if (typeof value === 'object' && value !== null && 'kind' in value) {
    if (value.kind === 'church') return { kind: 'church' };
    if (value.kind === 'campuses' && 'campusIds' in value && Array.isArray(value.campusIds)) {
      const ids = value.campusIds.map((id: unknown) => parseId('scope.campusIds', id));
      return { kind: 'campuses', campusIds: [...new Set(ids)] };
    }
  }
  throw invalid('scope', 'not a church or campus scope');
}

export function parseBoolean(field: string, value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid(field, 'not a boolean');
  return value;
}
