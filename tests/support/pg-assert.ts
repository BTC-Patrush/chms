import pg from 'pg';

/** SQLSTATE and constraint of a PostgreSQL error, for exact assertions. */
export interface PgFailure {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
  readonly message: string;
}

/** Awaits a promise that must fail with a PostgreSQL error and returns its details. */
export async function pgFailure(promise: Promise<unknown>): Promise<PgFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof pg.DatabaseError) {
      return { code: error.code, constraint: error.constraint, message: error.message };
    }
    throw error;
  }
  throw new Error('Expected a PostgreSQL error, but the statement succeeded');
}

export async function backendPid(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error('pg_backend_pid() returned no row');
  return pid;
}

/**
 * Waits until `blockedPid` is blocked by `blockerPid`, confirmed with pg_blocking_pids(),
 * so a concurrency test asserts a real interleaving rather than a timing guess.
 */
export async function waitUntilBlocked(
  observer: pg.Client,
  blockedPid: number,
  blockerPid: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ blockers: number[] }>(
      'SELECT pg_blocking_pids($1) AS blockers',
      [blockedPid],
    );
    if (rows[0]?.blockers.includes(blockerPid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Backend ${String(blockedPid)} was not blocked by ${String(blockerPid)}`);
}
