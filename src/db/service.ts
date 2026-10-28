import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import { databaseFailure, toServiceError, type DatabaseFailure } from '../domain/errors.ts';
import {
  withTransaction,
  type TransactionDatabase,
  type TransactionOptions,
} from './transaction.ts';

/*
 * How every CHMS-F001 service runs (ADR-004 decision 8): one READ COMMITTED transaction per
 * attempt, retries only in a new transaction, and errors mapped to domain errors only after
 * the transaction has ended. Callbacks never catch a database error.
 */

/** Serialization failure and deadlock: retried up to three times. */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(['40001', '40P01']);
export const MAX_SERIALIZATION_RETRIES = 3;

export interface ServiceOptions extends TransactionOptions {
  /** One more constraint violation retried once, in a new transaction (person archive). */
  readonly retryOnceOn?: DatabaseFailure;
}

/**
 * Runs `attempt` again after a retryable failure: up to three times for 40001 and 40P01, and
 * once for `retryOnceOn`. Every other error, and the last failure, is rethrown unchanged.
 */
export async function retrying<T>(
  attempt: () => Promise<T>,
  retryOnceOn?: DatabaseFailure,
): Promise<T> {
  let serializationRetries = 0;
  let retriedOnce = false;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      const failure = databaseFailure(error);
      if (failure === undefined) throw error;
      if (RETRYABLE_SQLSTATES.has(failure.sqlstate)) {
        if (serializationRetries === MAX_SERIALIZATION_RETRIES) throw error;
        serializationRetries += 1;
      } else if (
        !retriedOnce &&
        failure.sqlstate === retryOnceOn?.sqlstate &&
        failure.constraint === retryOnceOn.constraint
      ) {
        retriedOnce = true;
      } else {
        throw error;
      }
    }
  }
}

/**
 * Runs `work` as a service transaction with retries. A failure is rethrown as a DomainError
 * when it has a domain meaning, and never with query parameters or row values attached.
 */
export async function runService<T>(
  pool: pg.Pool,
  options: ServiceOptions,
  work: (tx: TransactionDatabase) => Promise<T>,
): Promise<T> {
  try {
    return await retrying(() => withTransaction(pool, options, work), options.retryOnceOn);
  } catch (error) {
    throw toServiceError(error);
  }
}

/** Every update moves row_version on by one and stamps updated_at. */
export const nextVersion = (rowVersion: AnyPgColumn) => ({
  rowVersion: sql<number>`${rowVersion} + 1`,
  updatedAt: sql<Date>`now()`,
});

/** The single row a statement must return; anything else is a bug, not a domain error. */
export function single<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (row === undefined || rows.length > 1) {
    throw new Error(`Expected exactly one row, got ${String(rows.length)}`);
  }
  return row;
}
