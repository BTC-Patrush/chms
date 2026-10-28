import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { archiveCampus, createCampus, renameCampus, unarchiveCampus } from '../church/campuses.ts';
import type { Campus } from '../church/campuses.ts';
import { bootstrapChurch, renameChurch } from '../church/church.ts';
import { DatabaseFailureError, DomainError } from '../domain/errors.ts';
import type { Scope } from '../domain/input.ts';
import {
  endAffiliation,
  linkPersonToCampus,
  setPrimaryAffiliation,
  type Affiliation,
} from '../people/affiliations.ts';
import { getPerson, listPeople } from '../people/directory.ts';
import {
  archivePerson,
  createPerson,
  unarchivePerson,
  updatePersonNames,
  type Person,
} from '../people/people.ts';

/*
 * The CHMS-F001 operator commands (specification "Actors"; ADR-003). `bootstrap` connects as
 * chms_owner with system actor `bootstrap`; every other command connects as chms_app with
 * `maintenance` (POL-01). Connection details come from the environment, and a password only
 * from the file an environment variable names: never from an argument, and never printed.
 * Output is JSON on stdout. Write commands print ids, states and row versions, never a
 * person's names. Errors go to stderr without input values.
 */

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** A problem with the command line or the environment, reported with exit status 2. */
class UsageError extends Error {
  override name = 'UsageError';
}

type Role = 'owner' | 'app';
interface OptionSpec {
  readonly type: 'string' | 'boolean';
  readonly multiple?: boolean;
}

interface Command {
  readonly role: Role;
  /** Options as shown by --help. */
  readonly usage: string;
  readonly options: Readonly<Record<string, OptionSpec>>;
  readonly run: (pool: pg.Pool, args: Arguments) => Promise<unknown>;
}

const MAINTENANCE = 'maintenance';
const text = { type: 'string' } as const;
const flag = { type: 'boolean' } as const;
const versioned = { id: text, 'row-version': text } as const;
const scoped = {
  scope: text,
  'campus-id': { type: 'string', multiple: true },
  'include-archived': flag,
} as const;

const COMMANDS: Readonly<Record<string, Command>> = {
  bootstrap: {
    role: 'owner',
    usage: '--name <church name>',
    options: { name: text },
    run: async (pool, a) => {
      const { church, created } = await bootstrapChurch(pool, { name: a.required('name') });
      return { churchId: church.id, created };
    },
  },
  'rename-church': {
    role: 'app',
    usage: '--row-version <n> --name <church name>',
    options: { 'row-version': text, name: text },
    run: async (pool, a) => {
      const church = await renameChurch(pool, {
        rowVersion: a.rowVersion(),
        name: a.required('name'),
      });
      return { id: church.id, name: church.name, rowVersion: church.rowVersion };
    },
  },
  'create-campus': {
    role: 'app',
    usage: '--name <campus name>',
    options: { name: text },
    run: async (pool, a) =>
      campusOutput(await createCampus(pool, MAINTENANCE, { name: a.required('name') })),
  },
  'rename-campus': {
    role: 'app',
    usage: '--id <campus id> --row-version <n> --name <campus name>',
    options: { ...versioned, name: text },
    run: async (pool, a) =>
      campusOutput(
        await renameCampus(pool, MAINTENANCE, { ...a.version(), name: a.required('name') }),
      ),
  },
  'archive-campus': {
    role: 'app',
    usage: '--id <campus id> --row-version <n>',
    options: versioned,
    run: async (pool, a) => campusOutput(await archiveCampus(pool, MAINTENANCE, a.version())),
  },
  'unarchive-campus': {
    role: 'app',
    usage: '--id <campus id> --row-version <n>',
    options: versioned,
    run: async (pool, a) => campusOutput(await unarchiveCampus(pool, MAINTENANCE, a.version())),
  },
  'create-person': {
    role: 'app',
    usage: '--display-name <name> [--given-name <name>] [--family-name <name>]',
    options: { 'display-name': text, 'given-name': text, 'family-name': text },
    run: async (pool, a) => personOutput(await createPerson(pool, MAINTENANCE, a.names())),
  },
  'update-person-names': {
    role: 'app',
    usage:
      '--id <person id> --row-version <n> --display-name <name> [--given-name <name>] [--family-name <name>]  (omitted parts are cleared)',
    options: { ...versioned, 'display-name': text, 'given-name': text, 'family-name': text },
    run: async (pool, a) =>
      personOutput(await updatePersonNames(pool, MAINTENANCE, { ...a.version(), ...a.names() })),
  },
  'archive-person': {
    role: 'app',
    usage: '--id <person id> --row-version <n>',
    options: versioned,
    run: async (pool, a) => {
      const { person, endedAffiliationIds } = await archivePerson(pool, MAINTENANCE, a.version());
      return { ...personOutput(person), endedAffiliationIds };
    },
  },
  'unarchive-person': {
    role: 'app',
    usage: '--id <person id> --row-version <n>',
    options: versioned,
    run: async (pool, a) => personOutput(await unarchivePerson(pool, MAINTENANCE, a.version())),
  },
  link: {
    role: 'app',
    usage: '--person-id <id> --campus-id <id> [--primary]',
    options: { 'person-id': text, 'campus-id': text, primary: flag },
    run: async (pool, a) =>
      affiliationOutput(
        await linkPersonToCampus(pool, MAINTENANCE, {
          personId: a.required('person-id'),
          campusId: a.required('campus-id'),
          isPrimary: a.flag('primary'),
        }),
      ),
  },
  'end-affiliation': {
    role: 'app',
    usage: '--id <affiliation id> --row-version <n>',
    options: versioned,
    run: async (pool, a) => affiliationOutput(await endAffiliation(pool, MAINTENANCE, a.version())),
  },
  'set-primary': {
    role: 'app',
    usage: '--id <affiliation id> --row-version <n>',
    options: versioned,
    run: async (pool, a) => {
      const result = await setPrimaryAffiliation(pool, MAINTENANCE, a.version());
      return {
        ...affiliationOutput(result.affiliation),
        previousPrimaryId: result.previousPrimaryId,
      };
    },
  },
  // Reads print names: their output is the record the operator asked for. Nothing is logged.
  'list-people': {
    role: 'app',
    usage: '--scope church [--include-archived] | --scope campuses [--campus-id <id>]...',
    options: scoped,
    run: async (pool, a) =>
      (await listPeople(pool, a.scope(), a.flag('include-archived'))).map(personRecord),
  },
  'get-person': {
    role: 'app',
    usage:
      '--id <person id> (--scope church [--include-archived] | --scope campuses [--campus-id <id>]...)',
    options: { id: text, ...scoped },
    run: async (pool, a) => {
      const detail = await getPerson(pool, a.scope(), a.required('id'), a.flag('include-archived'));
      return {
        ...personRecord(detail.person),
        affiliations: detail.affiliations.map(affiliationOutput),
      };
    },
  },
};

const ENVIRONMENT = `Environment:
  CHMS_PG_HOST, CHMS_PG_DATABASE   required
  CHMS_PG_PORT                     default 5432
  CHMS_OWNER_PASSWORD_FILE         bootstrap: file holding the chms_owner password
  CHMS_APP_PASSWORD_FILE           other commands: file holding the chms_app password
  CHMS_OWNER_USER, CHMS_APP_USER   default chms_owner, chms_app
Password files must not be accessible by group or others (chmod 600).`;

export function usage(): string {
  const commands = Object.entries(COMMANDS).map(([name, command]) => `  ${name} ${command.usage}`);
  return `Usage: npm run chms -- <command> [options]\n\nCommands:\n${commands.join('\n')}\n\n${ENVIRONMENT}`;
}

/** Runs one operator command and returns the process exit status. */
export async function runCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo,
): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === '--help' || name === 'help') {
    io.out(usage());
    return name === undefined ? EXIT_USAGE : EXIT_OK;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (command === undefined) {
    io.err('error: unknown command (see --help)');
    return EXIT_USAGE;
  }
  let args: Arguments;
  let config: pg.PoolConfig & { password: string };
  try {
    args = new Arguments(name, command.options, rest);
    config = connectionConfig(env, command.role);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err(`error: ${error.message}`);
    return EXIT_USAGE;
  }
  // Belt and braces: no output line can carry the password, whatever produced it.
  const redact = (line: string) => line.split(config.password).join('[redacted]');
  const pool = new pg.Pool(config);
  pool.on('error', () => undefined); // An idle-connection error fails the next query instead.
  try {
    const result = await command.run(pool, args);
    io.out(redact(JSON.stringify(result, null, 2)));
    return EXIT_OK;
  } catch (error) {
    io.err(redact(`error: ${describe(error)}`));
    return error instanceof UsageError ? EXIT_USAGE : EXIT_FAILED;
  } finally {
    await pool.end();
  }
}

function describe(error: unknown): string {
  // These messages carry codes and field names, never values.
  if (error instanceof DomainError || error instanceof DatabaseFailureError) return error.message;
  if (error instanceof UsageError) return error.message;
  // Anything else, such as a refused connection, is named by type and code only.
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? ` (${error.code})` : '';
    return `${error.name}${code}`;
  }
  return 'unexpected failure';
}

/** Parsed options of one command. Parsing errors never echo the offending argument. */
class Arguments {
  readonly #command: string;
  readonly #values: Readonly<Record<string, string | boolean | (string | boolean)[] | undefined>>;

  constructor(
    command: string,
    options: Readonly<Record<string, OptionSpec>>,
    argv: readonly string[],
  ) {
    this.#command = command;
    try {
      this.#values = parseArgs({
        args: [...argv],
        options,
        strict: true,
        allowPositionals: false,
      }).values;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      const reason = PARSE_ERRORS[code] ?? 'invalid arguments';
      throw new UsageError(`${reason} for ${command} (see --help)`);
    }
  }

  required(option: string): string {
    const value = this.#values[option];
    if (typeof value !== 'string')
      throw new UsageError(`--${option} is required for ${this.#command}`);
    return value;
  }

  optional(option: string): string | undefined {
    const value = this.#values[option];
    return typeof value === 'string' ? value : undefined;
  }

  flag(option: string): boolean {
    return this.#values[option] === true;
  }

  /** The services validate the number itself; anything but digits is passed on as NaN. */
  rowVersion(): number {
    const value = this.required('row-version');
    return /^[0-9]{1,10}$/.test(value) ? Number(value) : Number.NaN;
  }

  version(): { id: string; rowVersion: number } {
    return { id: this.required('id'), rowVersion: this.rowVersion() };
  }

  names(): { displayName: string; givenName?: string; familyName?: string } {
    const given = this.optional('given-name');
    const family = this.optional('family-name');
    return {
      displayName: this.required('display-name'),
      ...(given === undefined ? {} : { givenName: given }),
      ...(family === undefined ? {} : { familyName: family }),
    };
  }

  scope(): Scope {
    const scope = this.required('scope');
    const given = this.#values['campus-id'];
    const campusIds = Array.isArray(given) ? given.filter((v) => typeof v === 'string') : [];
    if (scope === 'church' && campusIds.length === 0) return { kind: 'church' };
    if (scope === 'campuses') return { kind: 'campuses', campusIds };
    throw new UsageError(
      `--scope must be church (without --campus-id) or campuses (with zero or more --campus-id) for ${this.#command}`,
    );
  }
}

const PARSE_ERRORS: Readonly<Record<string, string>> = {
  ERR_PARSE_ARGS_UNKNOWN_OPTION: 'unknown option',
  ERR_PARSE_ARGS_INVALID_OPTION_VALUE: 'missing or invalid option value',
  ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL: 'unexpected argument',
};

/** Connection settings for `role`; the password is read from a file, never from an argument. */
export function connectionConfig(
  env: Readonly<Record<string, string | undefined>>,
  role: Role,
): pg.PoolConfig & { password: string } {
  const required = (variable: string) => {
    const value = env[variable];
    if (value === undefined || value === '') throw new UsageError(`${variable} is not set`);
    return value;
  };
  const [userVariable, fileVariable, defaultUser] =
    role === 'owner'
      ? ['CHMS_OWNER_USER', 'CHMS_OWNER_PASSWORD_FILE', 'chms_owner']
      : ['CHMS_APP_USER', 'CHMS_APP_PASSWORD_FILE', 'chms_app'];
  const port = env.CHMS_PG_PORT ?? '5432';
  if (!/^[0-9]{1,5}$/.test(port)) throw new UsageError('CHMS_PG_PORT is not a port number');
  return {
    host: required('CHMS_PG_HOST'),
    port: Number(port),
    database: required('CHMS_PG_DATABASE'),
    user: env[userVariable] ?? defaultUser,
    password: readPasswordFile(required(fileVariable), fileVariable),
    max: 1,
    application_name: 'chms-cli',
  };
}

/** Reads a password file, refusing one that group or others can access, as libpq does for .pgpass. */
function readPasswordFile(path: string, variable: string): string {
  let password: string;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) throw new UsageError(`${variable} does not name a regular file`);
    if ((stats.mode & 0o077) !== 0) {
      throw new UsageError(
        `${variable} names a file that group or others can access; chmod 600 it`,
      );
    }
    password = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`${variable} names a file that cannot be read`);
  }
  if (password === '') throw new UsageError(`${variable} names an empty file`);
  return password;
}

const campusOutput = (c: Campus) => ({
  id: c.id,
  name: c.name,
  status: c.status,
  rowVersion: c.rowVersion,
});
const personOutput = (p: Person) => ({ id: p.id, status: p.status, rowVersion: p.rowVersion });
const personRecord = (p: Person) => ({
  id: p.id,
  displayName: p.displayName,
  givenName: p.givenName,
  familyName: p.familyName,
  status: p.status,
  archivedAt: p.archivedAt,
  rowVersion: p.rowVersion,
});
const affiliationOutput = (a: Affiliation) => ({
  id: a.id,
  personId: a.personId,
  campusId: a.campusId,
  isPrimary: a.isPrimary,
  endedAt: a.endedAt,
  endReason: a.endReason,
  rowVersion: a.rowVersion,
});
