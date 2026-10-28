import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  archiveCampus,
  createCampus,
  renameCampus,
  type Campus,
} from '../../src/church/campuses.ts';
import { bootstrapChurch } from '../../src/church/church.ts';
import { DomainError } from '../../src/domain/errors.ts';
import type { Scope } from '../../src/domain/input.ts';
import {
  endAffiliation,
  linkPersonToCampus,
  type Affiliation,
} from '../../src/people/affiliations.ts';
import { getPerson, listPeople } from '../../src/people/directory.ts';
import {
  archivePerson,
  createPerson,
  updatePersonNames,
  type Person,
} from '../../src/people/people.ts';
import {
  auditEventCount,
  createServiceFixture,
  domainFailure,
  failureCode,
  MAINTENANCE,
  unmappedFailure,
  type ServiceFixture,
} from '../support/services.ts';
import { pickWith, seededRandom } from '../support/random.ts';
import { firstRow } from '../support/sql.ts';

/*
 * Scoped reads (AC-F001-17; TS-F001-24, TS-F001-25) and, at service level, actor attribution
 * (TS-F001-27) and the absence of personal data from logs, errors and audit (TS-F001-34).
 */

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id).sort();
const campusScope = (...campuses: Campus[]): Scope => ({
  kind: 'campuses',
  campusIds: campuses.map((c) => c.id),
});
const WHOLE_CHURCH: Scope = { kind: 'church' };

describe('scoped reads (AC-F001-17)', () => {
  let f: ServiceFixture;

  beforeAll(async () => {
    f = await createServiceFixture();
    await bootstrapChurch(f.ownerPool, { name: 'Grace Fellowship' });
  });

  afterAll(async () => {
    await f.close();
  });

  const campus = (name: string) => createCampus(f.appPool, MAINTENANCE, { name });
  const person = (displayName: string) => createPerson(f.appPool, MAINTENANCE, { displayName });
  const link = (p: Person, c: Campus) =>
    linkPersonToCampus(f.appPool, MAINTENANCE, { personId: p.id, campusId: c.id });

  it('TS-F001-24: returns exactly the people visible in each scope', async () => {
    const [x, y] = [await campus('X'), await campus('Y')];
    const [a, b, c, d] = [
      await person('A'),
      await person('B'),
      await person('C'),
      await person('D'),
    ];
    await link(a, x);
    await link(b, y);
    await link(d, x);
    const { person: archivedD } = await archivePerson(f.appPool, MAINTENANCE, d);
    const list = (scope: Scope, includeArchived = false) =>
      listPeople(f.appPool, scope, includeArchived).then((people) =>
        people.map((p) => p.displayName),
      );
    expect(await list(campusScope(x))).toEqual(['A']);
    expect(await list(campusScope(y))).toEqual(['B']);
    expect(await list(campusScope(x, y))).toEqual(['A', 'B']);
    expect(await list(WHOLE_CHURCH)).toEqual(['A', 'B', 'C']);
    expect(await list(WHOLE_CHURCH, true)).toEqual(['A', 'B', 'C', 'D']);
    // Archived people never appear under a campus scope, even when asked for.
    expect(await list(campusScope(x, y), true)).toEqual(['A', 'B']);
    // An empty campus set sees nobody; it never widens to the whole church.
    expect(await list(campusScope())).toEqual([]);

    // getPerson: outside the scope is indistinguishable from missing.
    expect(await failureCode(getPerson(f.appPool, campusScope(y), a.id))).toBe('PersonNotFound');
    expect(await failureCode(getPerson(f.appPool, campusScope(x), c.id))).toBe('PersonNotFound');
    expect(await failureCode(getPerson(f.appPool, campusScope(x), d.id))).toBe('PersonNotFound');
    expect(await failureCode(getPerson(f.appPool, campusScope(x), d.id, true))).toBe(
      'PersonNotFound',
    );
    expect(await failureCode(getPerson(f.appPool, campusScope(), a.id))).toBe('PersonNotFound');
    expect((await getPerson(f.appPool, campusScope(x), a.id)).person.id).toBe(a.id);
    // Archived people only when explicitly requested under whole-church scope (PPD-02).
    expect((await getPerson(f.appPool, WHOLE_CHURCH, c.id)).person.id).toBe(c.id);
    expect(await failureCode(getPerson(f.appPool, WHOLE_CHURCH, d.id))).toBe('PersonNotFound');
    const wholeD = await getPerson(f.appPool, WHOLE_CHURCH, d.id, true);
    expect(wholeD.person).toMatchObject({ id: d.id, status: 'archived' });
    expect(wholeD.person.rowVersion).toBe(archivedD.rowVersion);
    expect(wholeD.affiliations).toEqual([
      expect.objectContaining({ campusId: x.id, endReason: 'person_archived' }) as unknown,
    ]);
  });

  it("TS-F001-24: a scoped getPerson shows only that scope's active affiliations", async () => {
    const [x, y, z] = [await campus('X2'), await campus('Y2'), await campus('Z2')];
    const p = await person('Linked Twice');
    const atX = await link(p, x);
    const atY = await link(p, y);
    const atZ = await link(p, z);
    await endAffiliation(f.appPool, MAINTENANCE, atZ);
    const linkIds = async (scope: Scope) =>
      ids((await getPerson(f.appPool, scope, p.id)).affiliations);
    expect(await linkIds(campusScope(x))).toEqual([atX.id]);
    expect(await linkIds(campusScope(y, z))).toEqual([atY.id]);
    expect(await linkIds(WHOLE_CHURCH)).toEqual(ids([atX, atY, atZ]));
    expect(await failureCode(getPerson(f.appPool, campusScope(z), p.id))).toBe('PersonNotFound');
  });

  it('TS-F001-25: property, with fixed seed 20261028: every scope returns exactly its linked people', async () => {
    const random = seededRandom(20261028);
    const pick = pickWith(random);
    const campuses: Campus[] = [];
    for (let i = 0; i < 6; i += 1) campuses.push(await campus(`Property Campus ${String(i)}`));
    const people: Person[] = [];
    for (let i = 0; i < 30; i += 1) people.push(await person(`Property Person ${String(i)}`));
    const active = new Map<string, Affiliation>();
    let archived = 0;
    for (let step = 0; step < 120; step += 1) {
      const p = pick(people);
      const c = pick(campuses);
      const key = `${p.id}/${c.id}`;
      const existing = active.get(key);
      if (existing === undefined) {
        const created = await linkPersonToCampus(f.appPool, MAINTENANCE, {
          personId: p.id,
          campusId: c.id,
        }).catch((error: unknown) => {
          if (error instanceof DomainError && error.code === 'PersonArchived') return undefined;
          throw error;
        });
        if (created !== undefined) active.set(key, created);
      } else if (random() < 0.5) {
        await endAffiliation(f.appPool, MAINTENANCE, existing);
        active.delete(key);
      }
      if (random() < 0.03) {
        const target = pick(people);
        const current = await getPerson(f.appPool, WHOLE_CHURCH, target.id, true);
        if (current.person.status === 'active') {
          await archivePerson(f.appPool, MAINTENANCE, current.person);
          archived += 1;
          for (const k of [...active.keys()]) if (k.startsWith(target.id)) active.delete(k);
        }
      }
    }
    const propertyPeople = new Set(people.map((p) => p.id));
    let nonEmptyScopes = 0;
    for (let trial = 0; trial < 40; trial += 1) {
      const inScope = campuses.filter(() => random() < 0.35);
      const scopeIds = new Set(inScope.map((c) => c.id));
      const expected = new Set(
        [...active.values()].filter((a) => scopeIds.has(a.campusId)).map((a) => a.personId),
      );
      const returned = (await listPeople(f.appPool, campusScope(...inScope))).map((p) => p.id);
      expect(new Set(returned)).toEqual(expected);
      // Independent check in SQL: every returned person has an active link in scope.
      const { n } = await firstRow<{ n: number }>(
        f.admin,
        `SELECT count(*)::int AS n FROM unnest($1::uuid[]) AS r(id)
          WHERE NOT EXISTS (SELECT 1 FROM chms.person_campus_affiliations a
                             WHERE a.person_id = r.id AND a.ended_at IS NULL
                               AND a.campus_id = ANY($2::uuid[]))`,
        [returned, [...scopeIds]],
      );
      expect(n).toBe(0);
      expect(returned.every((id) => propertyPeople.has(id))).toBe(true);
      if (returned.length > 0) nonEmptyScopes += 1;
    }
    // The seed must exercise the interesting cases, not only empty results.
    expect({ archived: archived > 0, linksLeft: active.size > 10, nonEmptyScopes }).toMatchObject({
      archived: true,
      linksLeft: true,
    });
    expect(nonEmptyScopes).toBeGreaterThan(20);
  });
});

describe('actors, audit and logs at service level (POL-01, POL-02; TS-F001-27, TS-F001-34)', () => {
  let f: ServiceFixture;

  beforeAll(async () => {
    f = await createServiceFixture();
    await bootstrapChurch(f.ownerPool, { name: 'Grace Fellowship' });
  });

  afterAll(async () => {
    await f.close();
  });

  it('TS-F001-27: rejects malformed and unknown actor categories, and test ones in production', async () => {
    const before = await auditEventCount(f.admin);
    expect(
      await domainFailure(createCampus(f.appPool, 'Maintenance', { name: 'Actor A' })),
    ).toMatchObject({ code: 'ValidationFailed', details: { field: 'actorCategory' } });
    for (const category of ['unknown', 'test']) {
      expect(
        await unmappedFailure(createCampus(f.appPool, category, { name: 'Actor B' })),
      ).toMatchObject({ sqlstate: '23503', constraint: 'audit_actor_category_fk' });
    }
    expect(await auditEventCount(f.admin)).toBe(before);
    expect(
      await firstRow(
        f.admin,
        "SELECT count(*)::int AS n FROM chms.campuses WHERE name LIKE 'Actor%'",
      ),
    ).toEqual({ n: 0 });
    // Test-environment setup only (POL-02): the category is then accepted and recorded.
    await f.admin.query("INSERT INTO chms.system_actor_categories (category) VALUES ('test')");
    const created = await createCampus(f.appPool, 'test', { name: 'Actor C' });
    expect(
      await firstRow(
        f.admin,
        'SELECT actor_kind, actor_category FROM chms.audit_events WHERE entity_id = $1',
        [created.id],
      ),
    ).toEqual({ actor_kind: 'system', actor_category: 'test' });
  });

  it('TS-F001-34: no marker value reaches captured logs, errors or audit events', async () => {
    const marker = 'Zq7Marker';
    const captured: string[] = [];
    const capture = (...args: unknown[]) => {
      captured.push(
        args
          .map((a) => (a instanceof Error ? `${String(a)} ${a.stack ?? ''}` : String(a)))
          .join(' '),
      );
      return true;
    };
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation(capture),
      vi.spyOn(process.stderr, 'write').mockImplementation(capture),
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(capture),
      ),
    ];
    const errors: unknown[] = [];
    try {
      const fail = async (work: Promise<unknown>) => {
        errors.push(
          await work.then(
            () => 'unexpected success',
            (error: unknown) => error,
          ),
        );
      };
      const created = await createCampus(f.appPool, MAINTENANCE, { name: `${marker} Campus` });
      const c = await renameCampus(f.appPool, MAINTENANCE, {
        ...created,
        name: `${marker} Campus Renamed`,
      });
      const p = await createPerson(f.appPool, MAINTENANCE, {
        displayName: `${marker} Person`,
        givenName: `${marker} Given`,
        familyName: `${marker} Family`,
      });
      const linked = await linkPersonToCampus(f.appPool, MAINTENANCE, {
        personId: p.id,
        campusId: c.id,
      });
      // Failures with the marker in the input, in Drizzle's query parameters, or in the
      // PostgreSQL error detail (the duplicate key and the failing row).
      const controlCharacter = String.fromCodePoint(0x01);
      await fail(createCampus(f.appPool, MAINTENANCE, { name: `${marker} CAMPUS RENAMED` }));
      await fail(
        createPerson(f.appPool, MAINTENANCE, { displayName: `${marker}${controlCharacter}` }),
      );
      await fail(createCampus(f.appPool, 'unknown', { name: `${marker} Unknown Actor` }));
      await fail(
        updatePersonNames(f.appPool, MAINTENANCE, { ...p, rowVersion: 9, displayName: marker }),
      );
      await fail(archiveCampus(f.appPool, MAINTENANCE, c));
      await fail(linkPersonToCampus(f.appPool, MAINTENANCE, { personId: p.id, campusId: c.id }));
      await endAffiliation(f.appPool, MAINTENANCE, linked);
      await archivePerson(f.appPool, MAINTENANCE, p);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(
      errors.map((e) => (e instanceof DomainError ? e.code : (e as { name: string }).name)),
    ).toEqual([
      'CampusNameTaken',
      'ValidationFailed',
      'DatabaseFailureError',
      'ConcurrentModification',
      'CampusHasActiveAffiliations',
      'AffiliationExists',
    ]);
    for (const error of errors) {
      const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ''}`;
      expect(text).not.toContain(marker);
    }
    expect(captured.filter((line) => line.includes(marker))).toEqual([]);
    expect(
      await firstRow(
        f.admin,
        'SELECT count(*)::int AS n FROM chms.audit_events e WHERE e::text LIKE $1',
        [`%${marker}%`],
      ),
    ).toEqual({ n: 0 });
  });
});
