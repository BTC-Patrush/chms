import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  archiveCampus,
  createCampus,
  renameCampus,
  unarchiveCampus,
} from '../../src/church/campuses.ts';
import { bootstrapChurch, renameChurch } from '../../src/church/church.ts';
import {
  endAffiliation,
  linkPersonToCampus,
  setPrimaryAffiliation,
} from '../../src/people/affiliations.ts';
import { getPerson } from '../../src/people/directory.ts';
import {
  archivePerson,
  createPerson,
  unarchivePerson,
  updatePersonNames,
} from '../../src/people/people.ts';
import { backendPid, waitUntilBlocked } from '../support/pg-assert.ts';
import {
  auditEventCount,
  auditEvents,
  createServiceFixture,
  domainFailure,
  failureCode,
  invariantProbes,
  MAINTENANCE,
  unmappedFailure,
  type ServiceFixture,
} from '../support/services.ts';
import { firstRow } from '../support/sql.ts';

/*
 * CHMS-F001 services against fully migrated PostgreSQL 18 databases, called exactly as
 * operator commands call them: chms_owner for bootstrap, chms_app for everything else.
 * Non-ASCII test strings are built from code points, so this file stays ASCII.
 */

const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const MISSING_ID = '019a0000-0000-7000-8000-000000000000';
const WHOLE_CHURCH = { kind: 'church' } as const;

describe('church operator commands (BR-01, BR-09; TS-F001-01 to 04)', () => {
  let f: ServiceFixture;

  beforeAll(async () => {
    f = await createServiceFixture();
  });

  afterAll(async () => {
    await f.close();
  });

  const churchRow = () =>
    firstRow<{ id: string; name: string; row_version: number; updated_at: Date }>(
      f.admin,
      'SELECT id, name, row_version, updated_at FROM chms.churches',
    );

  it('refuses writes before bootstrap with ChurchNotFound and writes nothing', async () => {
    expect(await failureCode(createCampus(f.appPool, MAINTENANCE, { name: 'North' }))).toBe(
      'ChurchNotFound',
    );
    expect(await failureCode(createPerson(f.appPool, MAINTENANCE, { displayName: 'Ada' }))).toBe(
      'ChurchNotFound',
    );
    expect(await failureCode(renameChurch(f.appPool, { rowVersion: 1, name: 'Grace' }))).toBe(
      'ChurchNotFound',
    );
    expect(await auditEventCount(f.admin)).toBe(0);
  });

  it('TS-F001-03: chms_app cannot bootstrap (42501), and the error carries no name', async () => {
    const failure = await unmappedFailure(bootstrapChurch(f.appPool, { name: 'Grace Fellowship' }));
    expect(failure).toMatchObject({ sqlstate: '42501', constraint: undefined });
    expect(`${String(failure)} ${failure.stack ?? ''}`).not.toContain('Grace');
  });

  it('TS-F001-01: bootstrap on an empty database creates one church and one audit event', async () => {
    const { church, created } = await bootstrapChurch(f.ownerPool, { name: ' Grace Fellowship ' });
    expect(created).toBe(true);
    expect(church).toMatchObject({ name: 'Grace Fellowship', rowVersion: 1 });
    const { rows } = await f.admin.query(
      'SELECT id, uuid_extract_version(id) AS version FROM chms.churches',
    );
    expect(rows).toEqual([{ id: church.id, version: 7 }]);
    expect(await auditEvents(f.admin, church.id)).toEqual([
      expect.objectContaining({
        actor_kind: 'system',
        actor_category: 'bootstrap',
        action: 'create',
        entity_type: 'church',
      }) as unknown,
    ]);
    expect(await auditEventCount(f.admin)).toBe(1);
  });

  it('TS-F001-02: a rerun with the same name changes nothing; another name fails with ChurchMismatch', async () => {
    const before = await churchRow();
    const again = await bootstrapChurch(f.ownerPool, { name: `Grace Fellowship${cp(0xa0)}` });
    expect(again).toMatchObject({ created: false, church: { id: before.id, rowVersion: 1 } });
    for (const name of ['Other Church', 'grace fellowship']) {
      expect(await domainFailure(bootstrapChurch(f.ownerPool, { name }))).toMatchObject({
        code: 'ChurchMismatch',
      });
    }
    expect(await churchRow()).toEqual(before);
    expect(await auditEventCount(f.admin)).toBe(1);
  });

  it('TS-F001-04: renames the church as maintenance, auditing only {name}; a stale row_version fails', async () => {
    const renamed = await renameChurch(f.appPool, {
      rowVersion: 1,
      name: 'Grace Fellowship Church',
    });
    expect(renamed).toMatchObject({ name: 'Grace Fellowship Church', rowVersion: 2 });
    expect((await auditEvents(f.admin, renamed.id)).at(-1)).toMatchObject({
      action: 'update',
      actor_category: 'maintenance',
      changed_fields: ['name'],
    });
    expect(await failureCode(renameChurch(f.appPool, { rowVersion: 1, name: 'Stale' }))).toBe(
      'ConcurrentModification',
    );
    expect(await churchRow()).toMatchObject({ name: 'Grace Fellowship Church', row_version: 2 });
  });

  it('a bootstrap that loses a concurrent race fails with ChurchAlreadyExists (23505)', async () => {
    const race = await createServiceFixture();
    const owner = await race.db.connectAs(race.db.ownerConfig);
    try {
      const ownerPid = await backendPid(owner);
      const { pool, pid } = await race.singleConnection('owner');
      await owner.query('BEGIN');
      await owner.query("SELECT set_config('chms.actor_category', 'bootstrap', true)");
      await owner.query("INSERT INTO chms.churches (name) VALUES ('Grace Fellowship')");
      const loser = domainFailure(bootstrapChurch(pool, { name: 'Grace Fellowship' }));
      await waitUntilBlocked(race.admin, pid, ownerPid);
      await owner.query('COMMIT');
      expect(await loser).toMatchObject({
        code: 'ChurchAlreadyExists',
        details: { sqlstate: '23505', constraint: 'churches_singleton_uq' },
      });
      // Rerun after the race: the committed church has the same name, so this is a no-op.
      expect((await bootstrapChurch(pool, { name: 'Grace Fellowship' })).created).toBe(false);
      expect(await auditEventCount(race.admin)).toBe(1);
    } finally {
      await owner.end();
      await race.close();
    }
  });
});

describe('campus, person and affiliation services', () => {
  let f: ServiceFixture;
  let seq = 0;

  beforeAll(async () => {
    f = await createServiceFixture();
    await bootstrapChurch(f.ownerPool, { name: 'Grace Fellowship' });
  });

  afterAll(async () => {
    await f.close();
  });

  const unique = (prefix: string) => `${prefix} ${String(++seq)}`;
  const campus = (name = unique('Campus')) => createCampus(f.appPool, MAINTENANCE, { name });
  const person = (displayName = unique('Person')) =>
    createPerson(f.appPool, MAINTENANCE, { displayName });
  const link = (personId: string, campusId: string, isPrimary = false) =>
    linkPersonToCampus(f.appPool, MAINTENANCE, { personId, campusId, isPrimary });
  const affiliationRow = (id: string) =>
    firstRow<{ ended_at: Date | null; end_reason: string | null; is_primary: boolean }>(
      f.admin,
      'SELECT ended_at, end_reason, is_primary FROM chms.person_campus_affiliations WHERE id = $1',
      [id],
    );
  const activeLinks = async (personId: string) =>
    (
      await firstRow<{ n: number }>(
        f.admin,
        'SELECT count(*)::int AS n FROM chms.person_campus_affiliations WHERE person_id = $1 AND ended_at IS NULL',
        [personId],
      )
    ).n;
  /** Asserts that `work` changes no audit event count, i.e. writes nothing. */
  const writesNothing = async (work: () => Promise<unknown>) => {
    const before = await auditEventCount(f.admin);
    await work();
    expect(await auditEventCount(f.admin)).toBe(before);
  };

  describe('campuses (BR-01, BR-06, BR-07)', () => {
    it('creates, renames, archives and unarchives a campus, auditing each change (TS-F001-26)', async () => {
      const created = await campus('East');
      expect(created).toMatchObject({
        name: 'East',
        status: 'active',
        archivedAt: null,
        rowVersion: 1,
      });
      const renamed = await renameCampus(f.appPool, MAINTENANCE, {
        id: created.id,
        rowVersion: 1,
        name: 'East Side',
      });
      const archived = await archiveCampus(f.appPool, MAINTENANCE, renamed);
      expect(archived).toMatchObject({ status: 'archived', rowVersion: 3 });
      expect(archived.archivedAt).toBeInstanceOf(Date);
      const restored = await unarchiveCampus(f.appPool, MAINTENANCE, archived);
      expect(restored).toMatchObject({ status: 'active', archivedAt: null, rowVersion: 4 });
      const events = await auditEvents(f.admin, created.id);
      expect(events.map((e) => [e.action, e.changed_fields, e.actor_category])).toEqual([
        ['create', ['church_id', 'created_at', 'id', 'name', 'status'], 'maintenance'],
        ['update', ['name'], 'maintenance'],
        ['archive', ['archived_at', 'status'], 'maintenance'],
        ['unarchive', ['archived_at', 'status'], 'maintenance'],
      ]);
      expect(new Set(events.map((e) => e.xact_id)).size).toBe(4);
    });

    it('rejects stale, missing and wrong-state updates and writes nothing', async () => {
      const c = await campus();
      await writesNothing(async () => {
        const stale = { id: c.id, rowVersion: 2, name: 'Stale' };
        expect(await failureCode(renameCampus(f.appPool, MAINTENANCE, stale))).toBe(
          'ConcurrentModification',
        );
        const missing = { id: MISSING_ID, rowVersion: 1 };
        expect(await failureCode(archiveCampus(f.appPool, MAINTENANCE, missing))).toBe(
          'CampusNotFound',
        );
        expect(await failureCode(unarchiveCampus(f.appPool, MAINTENANCE, c))).toBe(
          'CampusNotArchived',
        );
      });
      const archived = await archiveCampus(f.appPool, MAINTENANCE, c);
      expect(await failureCode(archiveCampus(f.appPool, MAINTENANCE, archived))).toBe(
        'CampusArchived',
      );
      // An archived campus keeps its reserved name (BR-07; rename of archived campuses: RR-19).
      await writesNothing(async () => {
        const rename = renameCampus(f.appPool, MAINTENANCE, { ...archived, name: 'Freed Name' });
        expect(await failureCode(rename)).toBe('CampusArchived');
      });
    });

    it('TS-F001-06: rejects names equal under casefold(), archived campuses included (CampusNameTaken)', async () => {
      const north = await campus('North');
      const south = await campus('South');
      const taken = async (work: Promise<unknown>) => {
        expect(await domainFailure(work)).toMatchObject({
          code: 'CampusNameTaken',
          details: { sqlstate: '23505', constraint: 'campuses_name_ci_uq' },
        });
      };
      await taken(campus('north'));
      await taken(campus('NORTH'));
      await archiveCampus(f.appPool, MAINTENANCE, north);
      await taken(campus('NORTH'));
      await taken(renameCampus(f.appPool, MAINTENANCE, { ...south, name: 'north' }));
      const { rows } = await f.admin.query<{ name: string }>(
        "SELECT name FROM chms.campuses WHERE casefold(name) = 'north'",
      );
      expect(rows).toEqual([{ name: 'North' }]);
    });

    it('TS-F001-07 (boundary part): normalizes, trims and validates campus names end to end', async () => {
      const stored = async (id: string) =>
        firstRow<{ name: string; nfc: boolean }>(
          f.admin,
          'SELECT name, name IS NFC NORMALIZED AS nfc FROM chms.campuses WHERE id = $1',
          [id],
        );
      // NFD input is stored as NFC.
      const nfd = await campus(`Cafe${cp(0x301)} Campus`);
      expect(await stored(nfd.id)).toEqual({ name: `Caf${cp(0xe9)} Campus`, nfc: true });
      // Leading or trailing space, tab and no-break space are trimmed; internal spaces kept.
      const trimmed = await campus(`${cp(0x09)} West${cp(0xa0)}`);
      expect((await stored(trimmed.id)).name).toBe('West');
      const doubled = await campus('North  Hill');
      expect((await stored(doubled.id)).name).toBe('North  Hill');
      // 100 characters are accepted; 101 and a control character are rejected at the boundary.
      expect((await campus('C'.repeat(100))).name).toBe('C'.repeat(100));
      await writesNothing(async () => {
        for (const [name, rule] of [
          ['C'.repeat(101), 'longer than 100 characters'],
          [`North${cp(0x01)}Hill`, 'control character'],
        ] as const) {
          expect(await domainFailure(campus(name))).toMatchObject({
            code: 'ValidationFailed',
            details: { field: 'name', rule },
          });
        }
      });
      // Case variants under PG_UNICODE_FAST casefold() (CP-08 records the same results).
      const results: Record<string, string> = {};
      for (const [label, first, second] of [
        ['sharp s', `Stra${cp(0xdf)}e`, 'STRASSE'],
        ['sigma', cp(0x39f, 0x394, 0x39f, 0x3a3), cp(0x3bf, 0x3b4, 0x3bf, 0x3c2)],
        ['dotted capital I', `${cp(0x130)}stanbul`, 'istanbul'],
      ] as const) {
        const kept = await campus(first);
        const outcome = await createCampus(f.appPool, MAINTENANCE, { name: second }).then(
          () => 'accepted',
          (error: unknown) => (error as { code: string }).code,
        );
        results[label] = outcome;
        // Capitalization is preserved after a duplicate is rejected.
        expect((await stored(kept.id)).name).toBe(first);
      }
      expect(results).toEqual({
        'sharp s': 'CampusNameTaken',
        sigma: 'CampusNameTaken',
        'dotted capital I': 'accepted',
      });
    });

    it('TS-F001-08: archive is rejected while a link is active (23001), then succeeds', async () => {
      const c = await campus();
      const a = await link((await person()).id, c.id);
      expect(await domainFailure(archiveCampus(f.appPool, MAINTENANCE, c))).toMatchObject({
        code: 'CampusHasActiveAffiliations',
        details: { sqlstate: '23001', constraint: 'pca_campus_active_fk' },
      });
      expect(
        await firstRow(f.admin, 'SELECT status, row_version FROM chms.campuses WHERE id = $1', [
          c.id,
        ]),
      ).toEqual({ status: 'active', row_version: 1 });
      await endAffiliation(f.appPool, MAINTENANCE, a);
      expect(await archiveCampus(f.appPool, MAINTENANCE, c)).toMatchObject({ status: 'archived' });
      expect(await invariantProbes(f.admin)).toEqual({ campus: 0, person: 0 });
    });
  });

  describe('people (BR-02, BR-04, BR-05, BR-08)', () => {
    it('TS-F001-13: creates a person with a display name only and a database-generated UUIDv7', async () => {
      const p = await person('Display Name Only');
      expect(p).toMatchObject({
        displayName: 'Display Name Only',
        givenName: null,
        familyName: null,
        status: 'active',
        rowVersion: 1,
      });
      expect(
        await firstRow(
          f.admin,
          'SELECT uuid_extract_version(id) AS v FROM chms.people WHERE id = $1',
          [p.id],
        ),
      ).toEqual({ v: 7 });
    });

    it('normalizes names end to end and rejects an empty component without writing (TS-F001-14)', async () => {
      const p = await createPerson(f.appPool, MAINTENANCE, {
        displayName: `  Jose${cp(0x301)}  Garcia${cp(0x3000)}`,
        givenName: `${cp(0x09)}Jose${cp(0x301)}`,
      });
      expect(p).toMatchObject({
        displayName: `Jos${cp(0xe9)}  Garcia`,
        givenName: `Jos${cp(0xe9)}`,
        familyName: null,
      });
      await writesNothing(async () => {
        const failure = await domainFailure(
          createPerson(f.appPool, MAINTENANCE, { displayName: 'Ada', familyName: '' }),
        );
        expect(failure).toMatchObject({
          code: 'ValidationFailed',
          details: { field: 'familyName', rule: 'empty' },
        });
      });
    });

    it('replaces all names, auditing only the changed fields; a stale row_version fails', async () => {
      const p = await person();
      const named = await updatePersonNames(f.appPool, MAINTENANCE, {
        id: p.id,
        rowVersion: 1,
        displayName: p.displayName,
        givenName: 'Ada',
        familyName: 'Lovelace',
      });
      expect(named).toMatchObject({ givenName: 'Ada', familyName: 'Lovelace', rowVersion: 2 });
      const cleared = await updatePersonNames(f.appPool, MAINTENANCE, {
        ...named,
        givenName: null,
      });
      expect(cleared).toMatchObject({ givenName: null, familyName: 'Lovelace', rowVersion: 3 });
      expect((await auditEvents(f.admin, p.id)).map((e) => e.changed_fields)).toEqual([
        ['church_id', 'created_at', 'display_name', 'id', 'status'],
        ['family_name', 'given_name'],
        ['given_name'],
      ]);
      expect(
        await failureCode(
          updatePersonNames(f.appPool, MAINTENANCE, { ...named, displayName: 'X' }),
        ),
      ).toBe('ConcurrentModification');
    });

    it('TS-F001-18: archive ends every active link (primary kept) and archives, in one transaction', async () => {
      const p = await person();
      const l1 = await link(p.id, (await campus()).id, true);
      const l2 = await link(p.id, (await campus()).id);
      const { person: archived, endedAffiliationIds } = await archivePerson(
        f.appPool,
        MAINTENANCE,
        p,
      );
      expect(archived).toMatchObject({ status: 'archived', rowVersion: 2 });
      expect([...endedAffiliationIds].sort()).toEqual([l1.id, l2.id].sort());
      expect(await affiliationRow(l1.id)).toMatchObject({
        end_reason: 'person_archived',
        is_primary: true,
      });
      expect(await affiliationRow(l2.id)).toMatchObject({
        end_reason: 'person_archived',
        is_primary: false,
      });
      const events = [
        ...(await auditEvents(f.admin, l1.id)),
        ...(await auditEvents(f.admin, l2.id)),
        ...(await auditEvents(f.admin, p.id)),
      ].filter((e) => e.action !== 'create');
      expect(events.map((e) => e.action).sort()).toEqual([
        'archive',
        'end_affiliation',
        'end_affiliation',
      ]);
      expect(new Set(events.map((e) => e.xact_id)).size).toBe(1);
      expect(await invariantProbes(f.admin)).toEqual({ campus: 0, person: 0 });
    });

    it('TS-F001-19: archive with a stale row_version fails and leaves the links active', async () => {
      const p = await person();
      await link(p.id, (await campus()).id, true);
      await link(p.id, (await campus()).id);
      const renamed = await updatePersonNames(f.appPool, MAINTENANCE, {
        ...p,
        displayName: unique('Renamed'),
      });
      await writesNothing(async () => {
        expect(await failureCode(archivePerson(f.appPool, MAINTENANCE, p))).toBe(
          'ConcurrentModification',
        );
      });
      expect(await activeLinks(p.id)).toBe(2);
      expect(
        await firstRow(f.admin, 'SELECT status, row_version FROM chms.people WHERE id = $1', [
          p.id,
        ]),
      ).toEqual({ status: 'active', row_version: renamed.rowVersion });
    });

    it('TS-F001-22: unarchive restores no link; re-linking creates a new row', async () => {
      const p = await person();
      const c = await campus();
      const original = await link(p.id, c.id, true);
      const { person: archived } = await archivePerson(f.appPool, MAINTENANCE, p);
      expect(await failureCode(archivePerson(f.appPool, MAINTENANCE, archived))).toBe(
        'PersonArchived',
      );
      const restored = await unarchivePerson(f.appPool, MAINTENANCE, archived);
      expect(restored).toMatchObject({ status: 'active', archivedAt: null });
      expect(await activeLinks(p.id)).toBe(0);
      expect(await affiliationRow(original.id)).toMatchObject({ end_reason: 'person_archived' });
      const relinked = await link(p.id, c.id, true);
      expect(relinked.id).not.toBe(original.id);
      expect(await failureCode(unarchivePerson(f.appPool, MAINTENANCE, restored))).toBe(
        'PersonNotArchived',
      );
      expect((await auditEvents(f.admin, p.id)).map((e) => e.action)).toEqual([
        'create',
        'archive',
        'unarchive',
      ]);
      const missing = { id: MISSING_ID, rowVersion: 1 };
      expect(await failureCode(archivePerson(f.appPool, MAINTENANCE, missing))).toBe(
        'PersonNotFound',
      );
    });

    it("updates an archived person's names, audited, and keeps the person archived (PPD-02)", async () => {
      const { person: archived } = await archivePerson(f.appPool, MAINTENANCE, await person());
      const renamed = await updatePersonNames(f.appPool, MAINTENANCE, {
        ...archived,
        displayName: unique('Archived Renamed'),
        familyName: 'Example',
      });
      expect(renamed).toMatchObject({ status: 'archived', rowVersion: archived.rowVersion + 1 });
      expect((await auditEvents(f.admin, archived.id)).at(-1)).toMatchObject({
        action: 'update',
        actor_category: 'maintenance',
        changed_fields: ['display_name', 'family_name'],
      });
    });
  });

  describe('affiliations (BR-03 to BR-06)', () => {
    it('TS-F001-16: zero or several links, one active pair, one active primary; re-link after end', async () => {
      const p = await person();
      expect((await getPerson(f.appPool, WHOLE_CHURCH, p.id)).affiliations).toEqual([]);
      const [a, b, c] = [await campus(), await campus(), await campus()];
      const primary = await link(p.id, a.id, true);
      await link(p.id, b.id);
      expect(await domainFailure(link(p.id, a.id))).toMatchObject({
        code: 'AffiliationExists',
        details: { sqlstate: '23505', constraint: 'pca_active_pair_uq' },
      });
      expect(await domainFailure(link(p.id, c.id, true))).toMatchObject({
        code: 'PrimaryAffiliationExists',
        details: { sqlstate: '23505', constraint: 'pca_active_primary_uq' },
      });
      const ended = await endAffiliation(f.appPool, MAINTENANCE, primary);
      expect(ended).toMatchObject({ endReason: 'ended', isPrimary: true, rowVersion: 2 });
      const relinked = await link(p.id, a.id, true);
      expect(relinked.id).not.toBe(primary.id);
      expect(await affiliationRow(primary.id)).toMatchObject({
        end_reason: 'ended',
        is_primary: true,
      });
    });

    it('TS-F001-09: rejects links to an archived campus or person (23503)', async () => {
      const archivedCampus = await campus();
      await archiveCampus(f.appPool, MAINTENANCE, archivedCampus);
      expect(await domainFailure(link((await person()).id, archivedCampus.id))).toMatchObject({
        code: 'CampusArchived',
        details: { sqlstate: '23503', constraint: 'pca_campus_active_fk' },
      });
      const archivedPerson = await person();
      await archivePerson(f.appPool, MAINTENANCE, archivedPerson);
      expect(await domainFailure(link(archivedPerson.id, (await campus()).id))).toMatchObject({
        code: 'PersonArchived',
        details: { sqlstate: '23503', constraint: 'pca_person_active_fk' },
      });
      expect(await invariantProbes(f.admin)).toEqual({ campus: 0, person: 0 });
    });

    it('rejects links to a missing person or campus, and stale or repeated ends', async () => {
      const p = await person();
      const c = await campus();
      await writesNothing(async () => {
        expect(await failureCode(link(MISSING_ID, c.id))).toBe('PersonNotFound');
        expect(await failureCode(link(p.id, MISSING_ID))).toBe('CampusNotFound');
        const missing = { id: MISSING_ID, rowVersion: 1 };
        expect(await failureCode(endAffiliation(f.appPool, MAINTENANCE, missing))).toBe(
          'AffiliationNotFound',
        );
      });
      const a = await link(p.id, c.id);
      const ended = await endAffiliation(f.appPool, MAINTENANCE, a);
      expect(await failureCode(endAffiliation(f.appPool, MAINTENANCE, a))).toBe(
        'ConcurrentModification',
      );
      expect(await failureCode(endAffiliation(f.appPool, MAINTENANCE, ended))).toBe(
        'AffiliationEnded',
      );
    });

    it('moves the primary in one transaction, and refuses an ended affiliation', async () => {
      const p = await person();
      const a = await link(p.id, (await campus()).id, true);
      const b = await link(p.id, (await campus()).id);
      const moved = await setPrimaryAffiliation(f.appPool, MAINTENANCE, b);
      expect(moved).toMatchObject({ previousPrimaryId: a.id, affiliation: { isPrimary: true } });
      expect(await affiliationRow(a.id)).toMatchObject({ is_primary: false, ended_at: null });
      const events = [...(await auditEvents(f.admin, a.id)), ...(await auditEvents(f.admin, b.id))]
        .filter((e) => e.action === 'update')
        .map((e) => [e.changed_fields, e.xact_id]);
      expect(events.map(([fields]) => fields)).toEqual([['is_primary'], ['is_primary']]);
      expect(new Set(events.map(([, xact]) => xact)).size).toBe(1);
      const ended = await endAffiliation(f.appPool, MAINTENANCE, moved.affiliation);
      expect(await failureCode(setPrimaryAffiliation(f.appPool, MAINTENANCE, ended))).toBe(
        'AffiliationEnded',
      );
      const c = await link(p.id, (await campus()).id);
      expect(await setPrimaryAffiliation(f.appPool, MAINTENANCE, c)).toMatchObject({
        previousPrimaryId: null,
      });
      const missing = { id: MISSING_ID, rowVersion: 1 };
      expect(await failureCode(setPrimaryAffiliation(f.appPool, MAINTENANCE, missing))).toBe(
        'AffiliationNotFound',
      );
    });
  });
});
