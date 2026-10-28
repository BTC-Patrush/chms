import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors.ts';
import {
  parseActorCategory,
  parseId,
  parseName,
  parseOptionalName,
  parseRowVersion,
  parseScope,
} from '../../src/domain/input.ts';

/*
 * TS-F001-14: boundary schemas for names (PPD-01, ADR-008 decision 3) and the other service
 * inputs. Non-ASCII test strings are built from code points, so this file stays ASCII.
 */

const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const TAB = cp(0x09);
const NBSP = cp(0xa0);
const IDEOGRAPHIC_SPACE = cp(0x3000);
const LINE_SEPARATOR = cp(0x2028);
const NEL = cp(0x85);
const ZWNBSP = cp(0xfeff); // Trimmed by String.prototype.trim(), but not Unicode White_Space.
const E_ACUTE = cp(0xe9);
const COMBINING_ACUTE = cp(0x301);
const LONE_SURROGATE = String.fromCharCode(0xd800);
const TWO_BYTE_LETTER = cp(0x101); // a with macron: one code point, two UTF-8 bytes.

/** The rule a ValidationFailed error reports for `field`, or the parsed value. */
function outcome(parse: () => unknown): unknown {
  try {
    return { value: parse() };
  } catch (error) {
    if (error instanceof DomainError && error.code === 'ValidationFailed') {
      return { rule: error.details.rule };
    }
    throw error;
  }
}

describe('name boundary schema (TS-F001-14)', () => {
  const cases: [string, unknown, unknown][] = [
    ['missing', undefined, { rule: 'required' }],
    ['null', null, { rule: 'required' }],
    ['not a string', 42, { rule: 'not a string' }],
    ['empty', '', { rule: 'empty' }],
    ['spaces only', '   ', { rule: 'empty' }],
    [
      'tab, NBSP and ideographic space only',
      `${TAB}${NBSP}${IDEOGRAPHIC_SPACE}`,
      { rule: 'empty' },
    ],
    ['lone surrogate', `Ada${LONE_SURROGATE}`, { rule: 'not well-formed Unicode' }],
    ['internal control character', `Ada${cp(0x01)}Lovelace`, { rule: 'control character' }],
    ['internal tab', `Ada${TAB}Lovelace`, { rule: 'control character' }],
    ['internal DEL', `Ada${cp(0x7f)}`, { rule: 'control character' }],
    ['internal NUL', `Ada${cp(0x00)}Lovelace`, { rule: 'control character' }],
    ['internal NEL (C1)', `Ada${NEL}Lovelace`, { rule: 'control character' }],
    ['101 characters', 'x'.repeat(101), { rule: 'longer than 100 characters' }],
    [
      '101 characters after NFC (202 before)',
      `e${COMBINING_ACUTE}`.repeat(101),
      {
        rule: 'longer than 100 characters',
      },
    ],
    ['100 characters', 'x'.repeat(100), { value: 'x'.repeat(100) }],
    [
      '100 two-byte characters',
      TWO_BYTE_LETTER.repeat(100),
      { value: TWO_BYTE_LETTER.repeat(100) },
    ],
    ['100 characters once trimmed', ` ${'x'.repeat(100)} `, { value: 'x'.repeat(100) }],
    ['leading and trailing spaces', '  Ada  ', { value: 'Ada' }],
    ['leading tab, trailing NBSP', `${TAB}Ada${NBSP}`, { value: 'Ada' }],
    [
      'ideographic space and line separator',
      `${IDEOGRAPHIC_SPACE}Ada${LINE_SEPARATOR}`,
      {
        value: 'Ada',
      },
    ],
    ['trailing NEL is White_Space, so trimmed', `Ada${NEL}`, { value: 'Ada' }],
    ['ZWNBSP is not White_Space, so kept', `${ZWNBSP}Ada`, { value: `${ZWNBSP}Ada` }],
    ['internal double space kept', 'Ada  Lovelace', { value: 'Ada  Lovelace' }],
    ['internal NBSP kept', `Ada${NBSP}Lovelace`, { value: `Ada${NBSP}Lovelace` }],
    ['NFD normalized to NFC', `Jose${COMBINING_ACUTE}`, { value: `Jos${E_ACUTE}` }],
    ['capitalization kept', 'mcDONALD', { value: 'mcDONALD' }],
  ];

  it.each(cases)('%s', (_label, input, expected) => {
    expect(outcome(() => parseName('displayName', input))).toEqual(expected);
  });

  it('names the field and rule in the error, never the value', () => {
    const marker = `Marker${cp(0x01)}Value`;
    const error = outcome(() => parseName('givenName', marker));
    expect(error).toEqual({ rule: 'control character' });
    try {
      parseName('givenName', marker);
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(DomainError);
      const text = `${String(thrown)} ${JSON.stringify(thrown)} ${(thrown as Error).stack ?? ''}`;
      expect(text).toContain('givenName');
      expect(text).not.toContain('Marker');
    }
  });

  it('treats an omitted or null component as NULL and rejects an empty one (BR-08)', () => {
    expect(parseOptionalName('givenName', undefined)).toBeNull();
    expect(parseOptionalName('givenName', null)).toBeNull();
    expect(outcome(() => parseOptionalName('givenName', ''))).toEqual({ rule: 'empty' });
    expect(outcome(() => parseOptionalName('familyName', ' '))).toEqual({ rule: 'empty' });
    expect(parseOptionalName('familyName', ` Lovelace${TAB}`)).toBe('Lovelace');
  });
});

describe('other service inputs', () => {
  it('accepts canonical UUIDs only, returned in lower case', () => {
    const id = '019A2B3C-4D5E-7F60-8A9B-0C1D2E3F4A5B';
    expect(parseId('id', id)).toBe(id.toLowerCase());
    for (const bad of ['', 'not-a-uuid', `${id} `, `{${id}}`, 42, null]) {
      expect(outcome(() => parseId('id', bad))).toEqual({ rule: 'not a UUID' });
    }
  });

  it('accepts positive 32-bit integer row versions only', () => {
    expect(parseRowVersion(1)).toBe(1);
    expect(parseRowVersion(2_147_483_647)).toBe(2_147_483_647);
    for (const bad of [0, -1, 1.5, 2_147_483_648, Number.NaN, '1', undefined]) {
      expect(outcome(() => parseRowVersion(bad))).toEqual({ rule: 'not a positive integer' });
    }
  });

  it('accepts actor categories in the database format only', () => {
    expect(parseActorCategory('maintenance')).toBe('maintenance');
    for (const bad of ['', 'M', 'Maintenance', 'main tenance', `x${'y'.repeat(41)}`, null]) {
      expect(outcome(() => parseActorCategory(bad))).toEqual({
        rule: 'not a system actor category',
      });
    }
  });

  it('accepts a church scope or a campus scope, deduplicating campus ids', () => {
    const id = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b';
    expect(parseScope({ kind: 'church' })).toEqual({ kind: 'church' });
    expect(parseScope({ kind: 'campuses', campusIds: [id, id.toUpperCase()] })).toEqual({
      kind: 'campuses',
      campusIds: [id],
    });
    expect(parseScope({ kind: 'campuses', campusIds: [] })).toEqual({
      kind: 'campuses',
      campusIds: [],
    });
    for (const bad of [null, {}, { kind: 'campus' }, { kind: 'campuses' }, 'church']) {
      expect(outcome(() => parseScope(bad))).toEqual({ rule: 'not a church or campus scope' });
    }
    expect(outcome(() => parseScope({ kind: 'campuses', campusIds: ['x'] }))).toEqual({
      rule: 'not a UUID',
    });
  });
});
