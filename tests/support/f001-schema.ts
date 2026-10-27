import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import type pg from 'pg';
import * as schema from '../../src/db/schema.ts';

/** The F001 DDL exactly as drizzle-kit generates it from src/db/schema.ts. */
export async function f001Ddl(): Promise<string[]> {
  return generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema));
}

/** Applies the generated F001 tables to an empty test database. */
export async function applyF001Schema(client: pg.Client): Promise<void> {
  for (const statement of await f001Ddl()) {
    await client.query(statement);
  }
}
