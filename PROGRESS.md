# CHMS progress and handoff

Last updated: 2026-10-28. Feature in progress: **CHMS-F001 — Church, Campus and Person Foundation** (backend only).

- Branch: `feat/chms-f001-foundation`, based on `133e321` (`main`).
- Pull request: [#3](https://github.com/BTC-Patrush/chms/pull/3), **draft**, not for merge yet. Its description has the M00 and M01a evidence.
- Pushed head: `a68670a` (M01a tests). GitHub CI run [40751257498](https://github.com/BTC-Patrush/chms/actions/runs/40751257498) passed on it: 87 database and 13 unit tests.
- Local only, push not yet approved: `a7c0a70` (handoff note), `d5cd20f` (services), `6c8115d` (service tests), `d0ebc88` (RR-19 baseline), and the documentation commit after them.

## Where things stand
The service-level checkpoint is reached. The internal services, the bootstrap and rename commands, error mapping, retries and the remaining acceptance tests are implemented. On `d0ebc88`, locally, everything passes:
- 67 unit tests;
- 124 database tests, in two consecutive runs;
- the concurrency file in 10 consecutive runs.

Every TS-F001 case has passed at least once. The test matrix records the level and run of each one. GitHub CI has not run the service tests yet, because they are not pushed.

## Done

**Documentation baseline (merged to `main`)**
- PR #1 (`771dd4d`): Claude Code configuration hardening and the `repo-hygiene` CI.
- PR #2 (`133e321`): CHMS-F001 business baseline, ADR-001 to ADR-008, decision register, database design, security review, specification, test matrix and readiness report.

**On `feat/chms-f001-foundation`**

| Commit | What |
|---|---|
| `d5c2a1b` | Toolchain: Node.js 24.22.1, Next.js 16.4.1 (root layout only), TypeScript 6.0.3 strict, ESLint 10, Prettier, Vitest 5 |
| `e37146d` | `compose.yaml`: PostgreSQL 18.6 pinned by digest; loopback only; password from a file |
| `fde7e11` | `src/db/schema.ts` (F001 Drizzle schema) and `src/db/transaction.ts` (`withTransaction`) |
| `66510d9` | Compatibility proofs CP-02, 03, 05, 06, 08 and 09, and TS-F001-33 |
| `42472c9` | CI workflow `ci`: audit, format, lint, typecheck, unit tests, PostgreSQL 18 tests, build |
| `38e10eb` | Errata E1 and E2 |
| `55bcdd6` | M00: `db/provision/*.sql` and `drizzle/0000_m00_foundation.sql` |
| `2de49e7` | M00 security tests (24) |
| `616c633` | Erratum E3 in ADR-006 |
| `fb9abfe` | M01a: `drizzle/0001_m01a_tables.sql` and `0002_m01a_integrity.sql` |
| `a68670a` | M01a contract tests (24) and the migration and static-boundary guards (last pushed commit) |
| `a7c0a70` | First version of this file (local) |
| `d5cd20f` | Services, commands, error mapping and boundary schemas (local) |
| `6c8115d` | Unit, service, concurrency and stress tests (local) |
| `d0ebc88` | Renaming an archived campus is refused (RR-19 baseline) (local) |

**Service layer**
- **Modules:**
  - `src/church/church.ts`: `bootstrapChurch` as `chms_owner` with actor `bootstrap`; `renameChurch` with actor `maintenance`.
  - `src/church/campuses.ts`: campus operations.
  - `src/people/people.ts`, `affiliations.ts` and `directory.ts`: person and affiliation operations, `listPeople` and `getPerson`.
  - `src/db/service.ts`: `runService`, which runs the transaction, retries and maps errors.
  - `src/domain/errors.ts` and `input.ts`: domain errors and boundary schemas.
- **Errors:** mapped by SQLSTATE plus constraint name after the transaction has ended (`23001` for archives, `23503` for inserts). `40001`/`40P01` are retried up to 3 times, and the person-archive race once, each in a new transaction.

**Test evidence:** [test matrix, execution evidence](docs/features/CHMS-F001/test-matrix.md#execution-evidence).
- **R1:** CI on `a68670a`, database level.
- **R2:** local on `d0ebc88`, with unit, database and service levels.
- **R3:** the manual TS-F001-36 restore drill.

## Decisions

**Product owner (Patrush)**
- **2026-10-27:**
  - BR-01 to BR-10 and POL-01 to POL-06 approved.
  - ADR-001 to ADR-008 accepted, with amendments: UUIDv7 via `uuidv7()`; archive-first, with no erasure in F001; the name rules (PPD-01).
  - Errata E1, E2 and E3 approved.
  - M00 implementation choices accepted.
  - B-07 and B-09 to B-13 deferred, nonblocking.
- **2026-10-28:**
  - Keep `created_at` in audit `changed_fields`; no design change.
  - Push `616c633`, `fb9abfe` and `a68670a` (done).
  - Verify CI and add the M01a evidence to PR #3 (done).
  - Implement the services and the remaining acceptance tests, then stop at the service checkpoint (done).

**Engineering (in commit messages; for review)**
- **No boundary-schema library.** ADR-007 left the choice open. The F001 inputs are few, and the name rules need the Unicode `White_Space` set from `schema.ts`, which `String.prototype.trim()` does not match (it trims U+FEFF and not U+0085). So `src/domain/input.ts` is hand-written, with no new dependency.
- **Drizzle wraps PostgreSQL errors** in `DrizzleQueryError`, and its message repeats the query parameters, which include names. Mapping therefore unwraps `cause`, and an unmapped database failure is rethrown as `DatabaseFailureError`, which keeps only the SQLSTATE and constraint (AC-F001-25).
- **Drizzle's insert lists every column**, with `default`, so `chms_app`'s column-level INSERT grants would reject it. Inserts are explicit SQL naming only the granted columns. Updates and selects use the query builder, which lists only the columns they touch.
- **Drizzle's `exists()` does not parenthesize a raw `sql` subquery.** `directory.ts` writes `EXISTS (…)` itself.
- **Service semantics not spelled out in design §4:**
  - `setPrimaryAffiliation` moves the primary in one transaction.
  - Linking with `isPrimary` while another primary exists fails (`PrimaryAffiliationExists`).
  - `updatePersonNames` replaces all three names.
  - Zero-row updates are classified as not found, `ConcurrentModification` or a state error.
  - Open interpretations are listed in RR-19.
- **Test-only interleavings:** the service runs on a one-connection pool whose PID is read first. The other side is a raw SQL session. The 40P01 test sets `deadlock_timeout = 60s` on a superuser blocker, so the service's backend detects the deadlock.

## Open items
- **RR-19 (new; product owner):**
  - (a) renaming an archived campus is refused, the stricter baseline;
  - (b) `getPerson` under whole-church scope returns archived people;
  - (c) an archived person's names can be updated;
  - (d) the explicit errors for cases outside design §4.
- **No operator CLI yet.** The commands exist as functions called with a `pg.Pool`. A runnable entry point needs a decision on credentials (a password file, never logged) and argument parsing. The static import-graph test then needs the new directory added.
- **TS-F001-36 automation:** `pg_dump` and `pg_restore` require approval on each run, so the drill is manual. Its helper script was not committed.
- **Not in CI yet:** the service tests (R2); they run there after the push.
- **Carried over:**
  - Dependabot covers GitHub Actions only.
  - The frontend workstream needs the React, import and `jsx-a11y` lint plugins.
  - The repository is public.
  - Deferred: RR-15, RR-17, RR-18, SR-12 and B-09.

## Next
1. Approval to push `a7c0a70` through the documentation commit. Then confirm GitHub CI and add the service evidence to PR #3.
2. The product owner reviews PR #3, including RR-19 and the engineering decisions above.
3. After approval: the operator CLI entry points, if wanted in F001, and the F001 definition-of-done items: human migration review and the final traceability check.

## Notes for the next session
- **Node:** the shell may resolve Node 24.20.0, which `engine-strict` rejects. Use `nvm use`, or put `~/.nvm/versions/node/v24.22.1/bin` first on `PATH`.
- **Local cluster:**
  - Running. Volume `chms_pgdata` was recreated on 2026-10-28 with the password file at `~/.config/chms/pg-admin-password`, the README path.
  - Export `CHMS_PG_ADMIN_PASSWORD_FILE` to that path before `npm run test:db` or `docker compose`.
- **Vitest 5 hides the console output of passing tests.** Use `--silent=false` to see the TS-F001-38 timing and outcome counts.
- **Approval prompts:** `drizzle-kit`, `psql`, `pg_dump`, `pg_restore`, `docker compose exec`, `docker compose down` and `git push` need approval. Run them directly, never wrapped to avoid the prompt.
- **drizzle-kit 0.31.11:** it exits 0 even after an error, so check its output. It mishandles absolute `--out` paths; use `./drizzle`.
- **`gh pr edit` fails** on the deprecated Projects-classic GraphQL field. Use `gh api -X PATCH repos/BTC-Patrush/chms/pulls/3 -F body=@file`.
