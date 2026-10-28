import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { TestProject } from 'vitest/node';
import { connectAdmin } from './cluster.ts';

/*
 * Provisions the CHMS-F001 roles on the disposable cluster once per test run, exactly as an
 * operator would with db/provision/01-cluster-roles.sql, and gives the login roles fresh
 * random passwords. The script runs twice to prove it is safe to re-run.
 */
export default async function setup(project: TestProject): Promise<void> {
  const script = readFileSync('db/provision/01-cluster-roles.sql', 'utf8');
  const admin = await connectAdmin();
  try {
    await admin.query(script);
    await admin.query(script);
    const passwords = {
      chms_owner: randomBytes(24).toString('hex'),
      chms_app: randomBytes(24).toString('hex'),
    };
    for (const [role, password] of Object.entries(passwords)) {
      await admin.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
    }
    project.provide('chmsRolePasswords', passwords);
  } finally {
    await admin.end();
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    chmsRolePasswords: { chms_owner: string; chms_app: string };
  }
}
