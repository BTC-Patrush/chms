import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { inject } from 'vitest';
import { createTestDatabase, roleConfig, type TestDatabase } from './cluster.ts';

export interface FoundationDatabase extends TestDatabase {
  readonly ownerConfig: pg.ClientConfig;
  readonly appConfig: pg.ClientConfig;
  connectAs(config: pg.ClientConfig): Promise<pg.Client>;
}

/**
 * A test database set up like a real installation: database-level privileges from
 * db/provision/02-database-privileges.sql (as a superuser), then every migration in
 * ./drizzle applied as chms_owner. Roles come from the global setup.
 */
export async function createFoundationDatabase(): Promise<FoundationDatabase> {
  const db = await createTestDatabase();
  const admin = await db.connectAdmin();
  try {
    await admin.query(readFileSync('db/provision/02-database-privileges.sql', 'utf8'));
  } finally {
    await admin.end();
  }
  const passwords = inject('chmsRolePasswords');
  const ownerConfig = roleConfig(db.name, 'chms_owner', passwords.chms_owner);
  const appConfig = roleConfig(db.name, 'chms_app', passwords.chms_app);
  const owner = new pg.Client(ownerConfig);
  await owner.connect();
  try {
    await migrate(drizzle(owner), { migrationsFolder: 'drizzle' });
  } finally {
    await owner.end();
  }
  return {
    ...db,
    ownerConfig,
    appConfig,
    async connectAs(config) {
      const client = new pg.Client(config);
      await client.connect();
      return client;
    },
  };
}
