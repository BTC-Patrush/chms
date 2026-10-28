import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { createCampus } from '../../src/church/campuses.ts';
import { bootstrapChurch } from '../../src/church/church.ts';
import { DomainError } from '../../src/domain/errors.ts';
import { endAffiliation, linkPersonToCampus } from '../../src/people/affiliations.ts';
import { archivePerson, createPerson } from '../../src/people/people.ts';
import { connectAdmin, createTestDatabase, roleConfig } from '../support/cluster.ts';

/*
 * TS-F001-36 recovery drill (AC-F001-27; ADR-003 decision 6), on the local disposable cluster
 * only. pg_dump and pg_restore need approval on every run, so they are run by hand between
 * the phases of this helper, never from it:
 *
 *   export CHMS_PG_ADMIN_PASSWORD_FILE=~/.config/chms/pg-admin-password
 *   npm run drill:restore -- prepare
 *   docker compose exec -T postgres pg_dump -U postgres -Fc \
 *     -f /tmp/chms_t_restore_source.dump chms_t_restore_source
 *   docker compose exec -T postgres pg_restore -U postgres --single-transaction \
 *     -d chms_t_restore_target /tmp/chms_t_restore_source.dump        # expect exit 0
 *   docker compose exec -T postgres pg_restore -U postgres --single-transaction \
 *     -d chms_t_restore_booted /tmp/chms_t_restore_source.dump        # expect exit 1
 *   npm run drill:restore -- verify                                   # exit 0: all checks pass
 *   npm run drill:restore -- cleanup
 *   docker compose exec -T postgres rm /tmp/chms_t_restore_source.dump
 *
 * prepare: a source database migrated and bootstrapped through the services, with synthetic
 * data; an already bootstrapped database with another church; and an empty target with only
 * the database provisioning. verify: compares the restored target with the source, runs
 * bootstrap on it, and confirms that the failed restore loaded nothing. Each phase gives the
 * login roles fresh random passwords, as the test suite does, so do not run it while tests run.
 */

const DATABASES = {
  source: 'chms_t_restore_source',
  target: 'chms_t_restore_target',
  booted: 'chms_t_restore_booted',
} as const;
const STATE_FILE = process.env.CHMS_DRILL_STATE_FILE ?? join(tmpdir(), 'chms-restore-drill.json');
const MAINTENANCE = 'maintenance';

interface Contents {
  readonly church_ids: string[];
  readonly church_names: string[];
  readonly campuses: number;
  readonly people: number;
  readonly affiliations: number;
  readonly audit_events: number;
  readonly triggers: number;
  readonly probe_violations: number;
  readonly app_can_select_people: boolean;
  readonly app_can_select_audit: boolean;
}

interface Snapshot {
  /** Relations outside the system schemas: 0 for a database that is verified empty. */
  readonly relations: number;
  readonly contents: Contents | null;
}

interface State {
  readonly sourceChurchId: string;
  readonly source: Snapshot;
  readonly target: Snapshot;
  readonly booted: Snapshot;
}

const passwords = {
  chms_owner: randomBytes(24).toString('hex'),
  chms_app: randomBytes(24).toString('hex'),
};

/** Provisions the roles (idempotent) and gives the login roles this run's passwords. */
async function provisionRoles(): Promise<void> {
  const admin = await connectAdmin();
  try {
    await admin.query(readFileSync('db/provision/01-cluster-roles.sql', 'utf8'));
    for (const [role, password] of Object.entries(passwords)) {
      await admin.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
    }
  } finally {
    await admin.end();
  }
}

const pool = (database: string, role: keyof typeof passwords) =>
  new pg.Pool({ ...roleConfig(database, role, passwords[role]), max: 2 });

async function createDatabase(name: string, migrated: boolean): Promise<void> {
  const db = await createTestDatabase('PG_UNICODE_FAST', name);
  const admin = await db.connectAdmin();
  try {
    await admin.query(readFileSync('db/provision/02-database-privileges.sql', 'utf8'));
  } finally {
    await admin.end();
  }
  if (!migrated) return;
  const owner = new pg.Client(roleConfig(name, 'chms_owner', passwords.chms_owner));
  await owner.connect();
  try {
    await migrate(drizzle(owner), { migrationsFolder: 'drizzle' });
  } finally {
    await owner.end();
  }
}

async function snapshot(database: string): Promise<Snapshot> {
  const admin = await connectAdmin(database);
  try {
    const one = async <T extends pg.QueryResultRow>(text: string) => {
      const row = (await admin.query<T>(text)).rows[0];
      if (row === undefined) throw new Error('snapshot query returned no row');
      return row;
    };
    const { relations } = await one<{ relations: number }>(
      `SELECT count(*)::int AS relations FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`,
    );
    const { schemas } = await one<{ schemas: number }>(
      "SELECT count(*)::int AS schemas FROM pg_namespace WHERE nspname = 'chms'",
    );
    if (schemas === 0) return { relations, contents: null };
    const contents = await one<Contents>(
      `SELECT
         (SELECT array_agg(id ORDER BY id) FROM chms.churches) AS church_ids,
         (SELECT array_agg(name ORDER BY id) FROM chms.churches) AS church_names,
         (SELECT count(*)::int FROM chms.campuses) AS campuses,
         (SELECT count(*)::int FROM chms.people) AS people,
         (SELECT count(*)::int FROM chms.person_campus_affiliations) AS affiliations,
         (SELECT count(*)::int FROM chms.audit_events) AS audit_events,
         (SELECT count(*)::int FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid
           WHERE r.relnamespace = 'chms'::regnamespace AND NOT t.tgisinternal) AS triggers,
         (SELECT count(*)::int FROM chms.person_campus_affiliations a
            JOIN chms.people p ON p.id = a.person_id
           WHERE a.ended_at IS NULL AND p.status = 'archived')
         + (SELECT count(*)::int FROM chms.person_campus_affiliations a
              JOIN chms.campuses c ON c.id = a.campus_id
             WHERE a.ended_at IS NULL AND c.status = 'archived') AS probe_violations,
         has_table_privilege('chms_app', 'chms.people', 'SELECT') AS app_can_select_people,
         has_table_privilege('chms_app', 'chms.audit_events', 'SELECT') AS app_can_select_audit`,
    );
    return { relations, contents };
  } finally {
    await admin.end();
  }
}

async function prepare(): Promise<void> {
  await provisionRoles();
  await createDatabase(DATABASES.source, true);
  await createDatabase(DATABASES.booted, true);
  await createDatabase(DATABASES.target, false);

  // Source: a bootstrapped church with synthetic data and its audit trail.
  const owner = pool(DATABASES.source, 'chms_owner');
  const app = pool(DATABASES.source, 'chms_app');
  const { church } = await bootstrapChurch(owner, { name: 'Grace Fellowship' });
  const north = await createCampus(app, MAINTENANCE, { name: 'North' });
  const south = await createCampus(app, MAINTENANCE, { name: 'South' });
  const ada = await createPerson(app, MAINTENANCE, { displayName: 'Ada Example' });
  const bo = await createPerson(app, MAINTENANCE, { displayName: 'Bo Example' });
  await createPerson(app, MAINTENANCE, { displayName: 'Cy Example' });
  await linkPersonToCampus(app, MAINTENANCE, {
    personId: ada.id,
    campusId: north.id,
    isPrimary: true,
  });
  const adaSouth = await linkPersonToCampus(app, MAINTENANCE, {
    personId: ada.id,
    campusId: south.id,
  });
  await endAffiliation(app, MAINTENANCE, adaSouth);
  await linkPersonToCampus(app, MAINTENANCE, { personId: bo.id, campusId: south.id });
  await archivePerson(app, MAINTENANCE, bo);
  await Promise.all([owner.end(), app.end()]);

  // Booted: another installation, already bootstrapped, that a restore must not touch.
  const bootedOwner = pool(DATABASES.booted, 'chms_owner');
  const bootedApp = pool(DATABASES.booted, 'chms_app');
  await bootstrapChurch(bootedOwner, { name: 'Other Church' });
  await createCampus(bootedApp, MAINTENANCE, { name: 'Only Campus' });
  await Promise.all([bootedOwner.end(), bootedApp.end()]);

  const state: State = {
    sourceChurchId: church.id,
    source: await snapshot(DATABASES.source),
    target: await snapshot(DATABASES.target),
    booted: await snapshot(DATABASES.booted),
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(JSON.stringify(state, null, 2));
}

async function verify(): Promise<boolean> {
  const before = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
  await provisionRoles();
  const restored = await snapshot(DATABASES.target);
  const booted = await snapshot(DATABASES.booted);
  const sourceEvents = before.source.contents?.audit_events;
  const auditEventsNow = async () => (await snapshot(DATABASES.target)).contents?.audit_events;
  const checks: [string, boolean][] = [
    ['the target was empty before the restore (0 relations)', before.target.relations === 0],
    [
      'the restored data, audit trail, triggers and grants equal the source',
      JSON.stringify(restored) === JSON.stringify(before.source),
    ],
    ['the church id is unchanged', restored.contents?.church_ids[0] === before.sourceChurchId],
    [
      'the restore wrote no audit event (triggers are post-data)',
      restored.contents?.audit_events === sourceEvents,
    ],
  ];

  // Bootstrap after a restore is a no-op that keeps the restored identity (ADR-003).
  const owner = pool(DATABASES.target, 'chms_owner');
  const app = pool(DATABASES.target, 'chms_app');
  try {
    const again = await bootstrapChurch(owner, { name: 'Grace Fellowship' });
    checks.push(['bootstrap after the restore: created is false', !again.created]);
    checks.push([
      'bootstrap after the restore: same church id',
      again.church.id === before.sourceChurchId,
    ]);
    checks.push([
      'bootstrap after the restore: no audit event',
      (await auditEventsNow()) === sourceEvents,
    ]);
    const mismatch = await bootstrapChurch(owner, { name: 'Another Name' }).then(
      () => 'created',
      (error: unknown) => (error instanceof DomainError ? error.code : 'other error'),
    );
    checks.push([
      'bootstrap with another name after the restore: ChurchMismatch',
      mismatch === 'ChurchMismatch',
    ]);
    // Triggers and grants work after the restore: one service write, one audit event.
    await createCampus(app, MAINTENANCE, { name: 'After Restore' });
    checks.push([
      'a service write after the restore is audited once',
      (await auditEventsNow()) === (sourceEvents ?? Number.NaN) + 1,
    ]);
  } catch (error) {
    // For example, the target was never restored: report it as a failed check.
    const name = error instanceof Error ? error.message : 'unknown error';
    checks.push([`bootstrap and a service write after the restore ran (${name})`, false]);
  } finally {
    await Promise.all([owner.end(), app.end()]);
  }
  checks.push([
    'the failed single-transaction restore into a bootstrapped database loaded nothing',
    JSON.stringify(booted) === JSON.stringify(before.booted),
  ]);

  console.log(JSON.stringify({ restored, booted }, null, 2));
  for (const [check, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'}  ${check}`);
  return checks.every(([, passed]) => passed);
}

async function cleanup(): Promise<void> {
  const admin = await connectAdmin();
  try {
    for (const name of Object.values(DATABASES)) {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}

const phase = process.argv[2];
if (phase === 'prepare') await prepare();
else if (phase === 'verify') process.exitCode = (await verify()) ? 0 : 1;
else if (phase === 'cleanup') await cleanup();
else {
  console.error('Usage: npm run drill:restore -- prepare | verify | cleanup');
  process.exitCode = 2;
}
