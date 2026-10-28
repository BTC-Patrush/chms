import pg from 'pg';
import {
  DatabaseFailureError,
  DomainError,
  type DomainErrorCode,
} from '../../src/domain/errors.ts';
import { createFoundationDatabase, type FoundationDatabase } from './foundation.ts';
import { firstRow } from './sql.ts';

/*
 * A fully migrated test database with the pools services run on: chms_app for services and
 * maintenance, chms_owner for bootstrap. Services are always called through these pools.
 */

export const MAINTENANCE = 'maintenance';

export interface ServiceFixture {
  readonly db: FoundationDatabase;
  /** Superuser connection for inspection only. */
  readonly admin: pg.Client;
  readonly ownerPool: pg.Pool;
  readonly appPool: pg.Pool;
  /**
   * A pool with exactly one connection, as chms_app or chms_owner, and that connection's
   * backend PID, read before any statement can block, so a test can confirm a service call's
   * interleaving with pg_blocking_pids().
   */
  singleConnection(role?: 'app' | 'owner'): Promise<{ pool: pg.Pool; pid: number }>;
  close(): Promise<void>;
}

export async function createServiceFixture(): Promise<ServiceFixture> {
  const db = await createFoundationDatabase();
  const admin = await db.connectAdmin();
  const pools = [new pg.Pool({ ...db.ownerConfig, max: 2 }), new pg.Pool({ ...db.appConfig })];
  const [ownerPool, appPool] = pools as [pg.Pool, pg.Pool];
  return {
    db,
    admin,
    ownerPool,
    appPool,
    async singleConnection(role = 'app') {
      // idleTimeoutMillis 0 keeps the one connection open, so the PID stays valid.
      const pool = new pg.Pool({
        ...(role === 'app' ? db.appConfig : db.ownerConfig),
        max: 1,
        idleTimeoutMillis: 0,
      });
      pools.push(pool);
      const { rows } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = rows[0]?.pid;
      if (pid === undefined) throw new Error('pg_backend_pid() returned no row');
      return { pool, pid };
    },
    async close() {
      await Promise.all(pools.map((pool) => pool.end()));
      await admin.end();
      await db.drop();
    },
  };
}

async function rejection<E extends Error>(
  promise: Promise<unknown>,
  type: abstract new (...args: never[]) => E,
): Promise<E> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof type) return error;
    throw error;
  }
  throw new Error(`Expected a ${type.name}, but the call succeeded`);
}

/** Awaits a promise that must reject with a DomainError and returns it. */
export const domainFailure = (promise: Promise<unknown>) => rejection(promise, DomainError);

/** Awaits a service call that must fail with a database error that has no domain meaning. */
export const unmappedFailure = (promise: Promise<unknown>) =>
  rejection(promise, DatabaseFailureError);

/** The DomainError code a call rejects with. */
export const failureCode = async (promise: Promise<unknown>): Promise<DomainErrorCode> =>
  (await domainFailure(promise)).code;

export interface AuditEvent {
  readonly action: string;
  readonly entity_type: string;
  readonly actor_kind: string;
  readonly actor_category: string;
  readonly changed_fields: string[];
  readonly xact_id: string;
}

export async function auditEvents(admin: pg.Client, entityId: string): Promise<AuditEvent[]> {
  const { rows } = await admin.query<AuditEvent>(
    `SELECT action, entity_type, actor_kind, actor_category, changed_fields, xact_id::text AS xact_id
       FROM chms.audit_events WHERE entity_id = $1 ORDER BY occurred_at, id`,
    [entityId],
  );
  return rows;
}

export async function auditEventCount(admin: pg.Client): Promise<number> {
  return (await firstRow<{ n: number }>(admin, 'SELECT count(*)::int AS n FROM chms.audit_events'))
    .n;
}

/** Invariant probes: active affiliations joined to an archived campus or an archived person. */
export async function invariantProbes(
  admin: pg.Client,
): Promise<{ campus: number; person: number }> {
  return firstRow(
    admin,
    `SELECT
       (SELECT count(*)::int FROM chms.person_campus_affiliations a JOIN chms.campuses c ON c.id = a.campus_id
         WHERE a.ended_at IS NULL AND c.status = 'archived') AS campus,
       (SELECT count(*)::int FROM chms.person_campus_affiliations a JOIN chms.people p ON p.id = a.person_id
         WHERE a.ended_at IS NULL AND p.status = 'archived') AS person`,
  );
}
