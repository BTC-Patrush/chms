import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { EXIT_FAILED, EXIT_OK, runCli } from '../../src/commands/cli.ts';
import { createFoundationDatabase, type FoundationDatabase } from '../support/foundation.ts';
import { auditEvents } from '../support/services.ts';
import { firstRow } from '../support/sql.ts';

/*
 * The operator CLI (src/commands) against a migrated PostgreSQL 18 database, with passwords
 * in private files as an operator would keep them. Every line the CLI prints is collected, so
 * the last test can prove no password ever appeared.
 */

const run = promisify(execFile);

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

describe('operator CLI (src/commands)', () => {
  let db: FoundationDatabase;
  let admin: pg.Client;
  let dir: string;
  let env: Record<string, string>;
  const printed: string[] = [];
  const passwords = inject('chmsRolePasswords');

  beforeAll(async () => {
    db = await createFoundationDatabase();
    admin = await db.connectAdmin();
    dir = mkdtempSync(join(tmpdir(), 'chms-cli-'));
    const file = (name: string, password: string) => {
      const path = join(dir, name);
      writeFileSync(path, `${password}\n`, { mode: 0o600 });
      return path;
    };
    env = {
      CHMS_PG_HOST: '127.0.0.1',
      CHMS_PG_PORT: String(db.appConfig.port),
      CHMS_PG_DATABASE: db.name,
      CHMS_OWNER_PASSWORD_FILE: file('owner', passwords.chms_owner),
      CHMS_APP_PASSWORD_FILE: file('app', passwords.chms_app),
    };
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await admin.end();
    await db.drop();
  });

  async function cli(...argv: string[]): Promise<Result> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, env, { out: (t) => out.push(t), err: (t) => err.push(t) });
    printed.push(...out, ...err);
    return { code, out: out.join('\n'), err: err.join('\n') };
  }
  /** Runs a command that must succeed and returns its JSON output. */
  async function ok<T = Record<string, unknown>>(...argv: string[]): Promise<T> {
    const result = await cli(...argv);
    expect({ argv, code: result.code, err: result.err }).toEqual({ argv, code: EXIT_OK, err: '' });
    return JSON.parse(result.out) as T;
  }
  interface Row {
    id: string;
    rowVersion: number;
    status?: string;
  }
  const version = (row: Row) => ['--id', row.id, '--row-version', String(row.rowVersion)];

  it('bootstrap creates the church once as chms_owner; a rerun is a no-op; another name fails', async () => {
    const first = await ok<{ churchId: string; created: boolean }>(
      'bootstrap',
      '--name',
      'Grace Fellowship',
    );
    expect(first.created).toBe(true);
    expect((await ok('bootstrap', '--name', 'Grace Fellowship')).created).toBe(false);
    const mismatch = await cli('bootstrap', '--name', 'Other Church');
    expect(mismatch).toMatchObject({ code: EXIT_FAILED, out: '' });
    expect(mismatch.err).toBe('error: ChurchMismatch: the existing church has a different name');
    expect(await auditEvents(admin, first.churchId)).toEqual([
      expect.objectContaining({ action: 'create', actor_category: 'bootstrap' }) as unknown,
    ]);
  });

  it('runs every maintenance command as chms_app with actor maintenance', async () => {
    const church = await ok<Row>('rename-church', '--row-version', '1', '--name', 'Grace Church');
    expect(church.rowVersion).toBe(2);
    const north = await ok<Row>('create-campus', '--name', 'North');
    const south = await ok<Row>('create-campus', '--name', 'South');
    const renamed = await ok<Row>('rename-campus', ...version(south), '--name', 'South Hill');
    const createPerson = await cli(
      'create-person',
      '--display-name',
      'Ada Example',
      '--given-name',
      'Ada',
    );
    // Write commands print ids, states and versions, never a person's names.
    expect(createPerson.out).not.toContain('Ada');
    const ada = JSON.parse(createPerson.out) as Row;
    const atNorth = await ok<Row>(
      'link',
      '--person-id',
      ada.id,
      '--campus-id',
      north.id,
      '--primary',
    );
    const atSouth = await ok<Row>('link', '--person-id', ada.id, '--campus-id', renamed.id);
    const moved = await ok<Row & { previousPrimaryId: string }>('set-primary', ...version(atSouth));
    expect(moved.previousPrimaryId).toBe(atNorth.id);

    const scoped = await ok<{ displayName: string }[]>(
      'list-people',
      '--scope',
      'campuses',
      '--campus-id',
      north.id,
    );
    expect(scoped.map((p) => p.displayName)).toEqual(['Ada Example']);
    expect(await ok('list-people', '--scope', 'campuses')).toEqual([]);
    const detail = await ok<{ affiliations: Row[] }>(
      'get-person',
      '--scope',
      'church',
      '--id',
      ada.id,
    );
    expect(detail.affiliations.map((a) => a.id).sort()).toEqual([atNorth.id, atSouth.id].sort());

    const archived = await ok<Row & { endedAffiliationIds: string[] }>(
      'archive-person',
      ...version(ada),
    );
    expect(archived.endedAffiliationIds).toHaveLength(2);
    // PPD-02: an archived person is found only when explicitly asked for.
    const hidden = await cli('get-person', '--scope', 'church', '--id', ada.id);
    expect(hidden).toMatchObject({
      code: EXIT_FAILED,
      err: 'error: PersonNotFound: person not found',
    });
    expect(await ok('list-people', '--scope', 'church')).toEqual([]);
    const shown = await ok<Row>(
      'get-person',
      '--scope',
      'church',
      '--include-archived',
      '--id',
      ada.id,
    );
    expect(shown.status).toBe('archived');
    // PPD-02: an archived person's names can still be edited.
    const edited = await ok<Row>(
      'update-person-names',
      ...version(archived),
      '--display-name',
      'Ada Q. Example',
    );
    const restored = await ok<Row>('unarchive-person', ...version(edited));
    expect(restored.status).toBe('active');

    const archivedCampus = await ok<Row>('archive-campus', ...version(north));
    // PPD-02: an archived campus keeps its name; unarchive it first.
    const refused = await cli('rename-campus', ...version(archivedCampus), '--name', 'Freed');
    expect(refused).toMatchObject({
      code: EXIT_FAILED,
      err: 'error: CampusArchived: campus is archived',
    });
    expect((await ok<Row>('unarchive-campus', ...version(archivedCampus))).status).toBe('active');
    const ended = await cli('end-affiliation', ...version(atNorth));
    // atNorth moved from version 1 to 3 (set-primary, then archive-person ended it).
    expect(ended.err).toMatch(/^error: ConcurrentModification:/);

    const { rows } = await admin.query<{ actor_category: string; n: number }>(
      `SELECT actor_category, count(*)::int AS n FROM chms.audit_events
        WHERE entity_type <> 'church' GROUP BY 1`,
    );
    expect(rows).toEqual([{ actor_category: 'maintenance', n: expect.any(Number) as number }]);
  });

  it('reports domain and validation errors with exit status 1 and no input values', async () => {
    const campus = await ok<Row>('create-campus', '--name', 'East');
    const stale = await cli(
      'rename-campus',
      '--id',
      campus.id,
      '--row-version',
      '9',
      '--name',
      'X',
    );
    expect(stale).toMatchObject({
      code: EXIT_FAILED,
      err: 'error: ConcurrentModification: the row changed since it was read (stale row_version)',
    });
    const invalid = await cli('create-person', '--display-name', `Zq7${String.fromCodePoint(1)}`);
    expect(invalid).toMatchObject({
      code: EXIT_FAILED,
      err: 'error: ValidationFailed: input failed validation (displayName: control character)',
    });
    for (const versionText of ['abc', '1.5', '0']) {
      const bad = await cli('archive-campus', '--id', campus.id, '--row-version', versionText);
      expect(bad.err).toBe(
        'error: ValidationFailed: input failed validation (rowVersion: not a positive integer)',
      );
    }
    const badId = await cli('archive-campus', '--id', 'Zq7-not-an-id', '--row-version', '1');
    expect(badId.err).toBe('error: ValidationFailed: input failed validation (id: not a UUID)');
    expect(printed.filter((line) => line.includes('Zq7'))).toEqual([]);
  });

  it('fails cleanly with a wrong password, without printing either password', async () => {
    const wrong = join(dir, 'wrong');
    writeFileSync(wrong, 'wrong-password-Zq7\n', { mode: 0o600 });
    const result = await runCli(
      ['list-people', '--scope', 'church'],
      {
        ...env,
        CHMS_APP_PASSWORD_FILE: wrong,
      },
      {
        out: (t) => printed.push(t),
        err: (t) => printed.push(t),
      },
    );
    expect(result).toBe(EXIT_FAILED);
    expect(printed.at(-1)).toBe('error: PostgreSQL error 28P01');
  });

  it('works as a separate process through the npm entry point, with exit statuses', async () => {
    // NODE_ENV is required by the ProcessEnv type that Next.js declares.
    const childEnv = { PATH: process.env.PATH ?? '', NODE_ENV: 'test', ...env } as const;
    const options = { env: childEnv, encoding: 'utf8' } as const;
    const main = ['src/commands/main.ts'];
    const listed = await run(
      process.execPath,
      [...main, 'list-people', '--scope', 'church'],
      options,
    );
    // The one person left active by the earlier tests.
    const people = JSON.parse(listed.stdout) as { displayName: string }[];
    expect(people.map((p) => p.displayName)).toEqual(['Ada Q. Example']);
    expect(listed.stderr).toBe('');
    printed.push(listed.stdout);
    const missing = await run(
      process.execPath,
      [...main, 'get-person', '--scope', 'church', '--id', '019a0000-0000-7000-8000-000000000000'],
      options,
    ).then(
      () => ({ code: 0, stderr: '' }),
      (error: unknown) => error as { code: number; stderr: string },
    );
    expect(missing).toMatchObject({
      code: EXIT_FAILED,
      stderr: 'error: PersonNotFound: person not found\n',
    });
  });

  it('never printed a password, on stdout or stderr', () => {
    expect(printed.length).toBeGreaterThan(20);
    for (const password of Object.values(passwords)) {
      expect(printed.filter((line) => line.includes(password))).toEqual([]);
    }
  });

  it('records the audit trail of CLI writes under the declared system actors', async () => {
    expect(
      await firstRow(
        admin,
        'SELECT count(DISTINCT actor_category)::int AS n FROM chms.audit_events',
      ),
    ).toEqual({ n: 2 });
  });
});
