import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

/*
 * Access to the local disposable PostgreSQL 18 cluster started by compose.yaml.
 * Tests never connect anywhere else: the host is fixed to loopback, and every test
 * database is created here with a random name and dropped afterwards.
 */

export type BuiltinLocale = 'PG_UNICODE_FAST' | 'C.UTF-8';

const HOST = '127.0.0.1';
const TEST_DATABASE_PREFIX = 'chms_t_';

function adminConfig(database: string): pg.ClientConfig {
  const passwordFile = process.env.CHMS_PG_ADMIN_PASSWORD_FILE;
  if (!passwordFile) {
    throw new Error(
      'CHMS_PG_ADMIN_PASSWORD_FILE is not set. Start the disposable cluster first (README: Local development).',
    );
  }
  return {
    host: HOST,
    port: Number(process.env.CHMS_PG_PORT ?? '55432'),
    user: 'postgres',
    password: readFileSync(passwordFile, 'utf8').trim(),
    database,
  };
}

/** Connection settings for a role on the disposable cluster (password authentication). */
export function roleConfig(database: string, user: string, password: string): pg.ClientConfig {
  return { ...adminConfig(database), user, password };
}

export function uniqueSuffix(): string {
  return randomBytes(6).toString('hex');
}

export async function connectAdmin(database = 'postgres'): Promise<pg.Client> {
  const client = new pg.Client(adminConfig(database));
  await client.connect();
  return client;
}

export interface TestDatabase {
  readonly name: string;
  /** Superuser connection settings for this database. */
  readonly adminConfig: pg.ClientConfig;
  connectAdmin(): Promise<pg.Client>;
  drop(): Promise<void>;
}

/**
 * Creates an empty UTF8 database with the builtin locale provider (ADR-008). The name is random
 * unless given; a given name must carry the test prefix too.
 */
export async function createTestDatabase(
  locale: BuiltinLocale = 'PG_UNICODE_FAST',
  name = `${TEST_DATABASE_PREFIX}${uniqueSuffix()}`,
): Promise<TestDatabase> {
  if (!/^chms_t_[a-z0-9_]+$/.test(name)) throw new Error(`Refusing database name ${name}`);
  const admin = await connectAdmin();
  try {
    await admin.query(
      `CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER 'builtin' BUILTIN_LOCALE '${locale}' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8'`,
    );
  } finally {
    await admin.end();
  }
  const config = adminConfig(name);
  return {
    name,
    adminConfig: config,
    async connectAdmin() {
      const client = new pg.Client(config);
      await client.connect();
      return client;
    },
    async drop() {
      if (!name.startsWith(TEST_DATABASE_PREFIX)) throw new Error(`Refusing to drop ${name}`);
      const client = await connectAdmin();
      try {
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}
