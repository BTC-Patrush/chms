import { DrizzleQueryError } from 'drizzle-orm';
import pg from 'pg';

/*
 * Errors of the CHMS-F001 services (database design section 4). Messages are fixed and never
 * carry input values: names are personal data, Drizzle's error message repeats the query
 * parameters, and a PostgreSQL error detail can quote row values. So a database error is
 * never attached as a cause; only its SQLSTATE and constraint name are kept.
 */

const MESSAGES = {
  ValidationFailed: 'input failed validation',
  ChurchNotFound: 'no church exists; bootstrap has not run',
  ChurchAlreadyExists: 'a church already exists',
  ChurchMismatch: 'the existing church has a different name',
  CampusNotFound: 'campus not found',
  CampusNameTaken: 'a campus with an equal name exists, archived campuses included',
  CampusArchived: 'campus is archived',
  CampusNotArchived: 'campus is not archived',
  CampusHasActiveAffiliations: 'campus still has active affiliations',
  PersonNotFound: 'person not found',
  PersonArchived: 'person is archived',
  PersonNotArchived: 'person is not archived',
  AffiliationNotFound: 'affiliation not found',
  AffiliationEnded: 'affiliation has ended',
  AffiliationExists: 'person already has an active affiliation to this campus',
  PrimaryAffiliationExists: 'person already has an active primary affiliation',
  ConcurrentAffiliationChange: 'affiliations changed concurrently, again after one retry',
  ConcurrentModification: 'the row changed since it was read (stale row_version)',
} as const;

export type DomainErrorCode = keyof typeof MESSAGES;

export interface DomainErrorDetails {
  /** ValidationFailed only: the input field and the rule it broke, never the value. */
  readonly field?: string;
  readonly rule?: string;
  /** The PostgreSQL failure this error was mapped from. */
  readonly sqlstate?: string;
  readonly constraint?: string;
}

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: DomainErrorDetails;

  constructor(code: DomainErrorCode, details: DomainErrorDetails = {}) {
    const where = details.field === undefined ? '' : ` (${details.field}: ${details.rule ?? ''})`;
    super(`${code}: ${MESSAGES[code]}${where}`);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export interface DatabaseFailure {
  readonly sqlstate: string;
  readonly constraint: string | undefined;
}

/**
 * SQLSTATE and constraint of a PostgreSQL error, also when Drizzle wrapped it; undefined for
 * any other error.
 */
export function databaseFailure(error: unknown): DatabaseFailure | undefined {
  const cause = error instanceof DrizzleQueryError ? error.cause : error;
  if (!(cause instanceof pg.DatabaseError) || cause.code === undefined) return undefined;
  return { sqlstate: cause.code, constraint: cause.constraint };
}

/**
 * A database failure with no domain meaning, such as CHA01 (no actor), 42501 or an unknown
 * actor category: a defect or misconfiguration, not a business outcome. It keeps only the
 * SQLSTATE and constraint, so logging it cannot leak names.
 */
export class DatabaseFailureError extends Error implements DatabaseFailure {
  readonly sqlstate: string;
  readonly constraint: string | undefined;

  constructor(failure: DatabaseFailure) {
    const on = failure.constraint === undefined ? '' : ` on ${failure.constraint}`;
    super(`PostgreSQL error ${failure.sqlstate}${on}`);
    this.name = 'DatabaseFailureError';
    this.sqlstate = failure.sqlstate;
    this.constraint = failure.constraint;
  }
}

/**
 * What a service rethrows after its transaction has ended: a DomainError for a mapped
 * failure, a DatabaseFailureError for any other database failure, and any other error
 * unchanged, except that Drizzle's wrapper (query and parameters) is replaced by its cause.
 */
export function toServiceError(error: unknown): unknown {
  const failure = databaseFailure(error);
  if (failure === undefined) {
    return error instanceof DrizzleQueryError ? error.cause : error;
  }
  return toDomainError(error) ?? new DatabaseFailureError(failure);
}

/**
 * Constraint violations with a domain meaning, by SQLSTATE and constraint name (database
 * design section 4). Archives refused by an active reference raise 23001; inserts that
 * reference an archived row raise 23503 (erratum E1).
 */
const VIOLATIONS: Readonly<Record<string, Readonly<Record<string, DomainErrorCode>>>> = {
  '23505': {
    churches_singleton_uq: 'ChurchAlreadyExists',
    campuses_name_ci_uq: 'CampusNameTaken',
    pca_active_pair_uq: 'AffiliationExists',
    pca_active_primary_uq: 'PrimaryAffiliationExists',
  },
  '23503': {
    pca_campus_active_fk: 'CampusArchived',
    pca_person_active_fk: 'PersonArchived',
  },
  '23001': {
    pca_campus_active_fk: 'CampusHasActiveAffiliations',
    // Person archive, step 2: only after its one retry (ADR-004 decision 4).
    pca_person_active_fk: 'ConcurrentAffiliationChange',
  },
};

/** Maps a PostgreSQL error to a domain error, or returns undefined to rethrow it unchanged. */
export function toDomainError(error: unknown): DomainError | undefined {
  const failure = databaseFailure(error);
  if (failure?.constraint === undefined) return undefined;
  const code = VIOLATIONS[failure.sqlstate]?.[failure.constraint];
  return code === undefined
    ? undefined
    : new DomainError(code, { sqlstate: failure.sqlstate, constraint: failure.constraint });
}

/**
 * Why a guarded UPDATE matched no row: the row is missing, its row_version moved on, or it is
 * in the wrong state for the operation.
 */
export function unmatched(
  current: { readonly rowVersion: number } | undefined,
  expectedRowVersion: number,
  notFound: DomainErrorCode,
  wrongState: DomainErrorCode = 'ConcurrentModification',
): DomainError {
  if (current === undefined) return new DomainError(notFound);
  if (current.rowVersion !== expectedRowVersion) return new DomainError('ConcurrentModification');
  return new DomainError(wrongState);
}
