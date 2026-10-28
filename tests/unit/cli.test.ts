import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectionConfig,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  runCli,
  usage,
} from '../../src/commands/cli.ts';

/*
 * Operator CLI argument and environment handling, which fails before any connection is made.
 * The commands themselves run against PostgreSQL in tests/db/f001-cli.test.ts.
 */

const SECRET = 'not-a-real-password-Zq7';

describe('operator CLI: arguments and environment', () => {
  let dir: string;
  let passwordFile: string;
  let env: Record<string, string>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'chms-cli-unit-'));
    passwordFile = join(dir, 'app-password');
    writeFileSync(passwordFile, `${SECRET}\n`, { mode: 0o600 });
    env = {
      CHMS_PG_HOST: '127.0.0.1',
      CHMS_PG_DATABASE: 'chms',
      CHMS_APP_PASSWORD_FILE: passwordFile,
    };
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function cli(argv: string[], environment: Record<string, string> = env) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, environment, {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('prints usage, with every command and the environment variables', async () => {
    const help = await cli(['--help']);
    expect(help.code).toBe(EXIT_OK);
    for (const command of [
      'bootstrap',
      'create-campus',
      'archive-person',
      'set-primary',
      'get-person',
    ]) {
      expect(help.out).toContain(`  ${command} `);
    }
    expect(help.out).toContain('CHMS_OWNER_PASSWORD_FILE');
    expect((await cli([])).code).toBe(EXIT_USAGE);
    expect(usage()).not.toMatch(/--password/);
  });

  it('rejects unknown commands, options and arguments without echoing them', async () => {
    const cases = [
      ['no-such-command-Zq7'],
      ['create-campus', '--name', 'North', '--password', SECRET],
      ['create-campus', `--password=${SECRET}`],
      ['create-campus', '--name', 'North', SECRET],
      ['create-campus', '--name'],
      ['create-campus'],
      ['list-people'],
      ['list-people', '--scope', 'church', '--campus-id', 'x'],
      ['list-people', '--scope', 'everyone'],
    ];
    for (const argv of cases) {
      const result = await cli(argv);
      expect({ argv, code: result.code }).toEqual({ argv, code: EXIT_USAGE });
      expect(result.err).toMatch(/^error: /);
      expect(`${result.out}${result.err}`).not.toContain('Zq7');
    }
  });

  it('requires the connection variables and names the missing one', async () => {
    for (const variable of ['CHMS_PG_HOST', 'CHMS_PG_DATABASE', 'CHMS_APP_PASSWORD_FILE']) {
      const rest = Object.fromEntries(Object.entries(env).filter(([name]) => name !== variable));
      const result = await cli(['create-campus', '--name', 'North'], rest);
      expect(result).toMatchObject({ code: EXIT_USAGE, err: `error: ${variable} is not set` });
    }
    const badPort = await cli(['create-campus', '--name', 'North'], {
      ...env,
      CHMS_PG_PORT: '54x',
    });
    expect(badPort).toMatchObject({
      code: EXIT_USAGE,
      err: 'error: CHMS_PG_PORT is not a port number',
    });
    // bootstrap needs the owner's password file, not the app's.
    expect((await cli(['bootstrap', '--name', 'Grace'])).err).toBe(
      'error: CHMS_OWNER_PASSWORD_FILE is not set',
    );
  });

  it('reads the password only from a private file, and never prints it', async () => {
    const config = connectionConfig(env, 'app');
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 5432,
      database: 'chms',
      user: 'chms_app',
      password: SECRET,
    });
    const owner = connectionConfig(
      { ...env, CHMS_OWNER_PASSWORD_FILE: passwordFile, CHMS_OWNER_USER: 'operator_owner' },
      'owner',
    );
    expect(owner).toMatchObject({ user: 'operator_owner', password: SECRET });

    const shared = join(dir, 'shared-password');
    writeFileSync(shared, SECRET, { mode: 0o600 });
    chmodSync(shared, 0o640);
    const empty = join(dir, 'empty-password');
    writeFileSync(empty, '\n', { mode: 0o600 });
    const cases: [string, string][] = [
      [shared, 'names a file that group or others can access; chmod 600 it'],
      [empty, 'names an empty file'],
      [join(dir, 'missing'), 'names a file that cannot be read'],
      [dir, 'does not name a regular file'],
    ];
    for (const [file, reason] of cases) {
      const result = await cli(['create-campus', '--name', 'North'], {
        ...env,
        CHMS_APP_PASSWORD_FILE: file,
      });
      expect(result).toMatchObject({
        code: EXIT_USAGE,
        err: `error: CHMS_APP_PASSWORD_FILE ${reason}`,
      });
      expect(result.err).not.toContain(SECRET);
    }
  });

  it('reports a refused connection by error type and code only (exit 1)', async () => {
    // Port 1 on loopback: nothing listens there, so the connection is refused at once.
    const result = await cli(['list-people', '--scope', 'church'], { ...env, CHMS_PG_PORT: '1' });
    expect(result).toEqual({ code: EXIT_FAILED, out: '', err: 'error: Error (ECONNREFUSED)' });
  });
});
