# CHMS progress and handoff

Last updated: 2026-10-28. Feature in progress: **CHMS-F001 — Church, Campus and Person Foundation** (backend only).

- Branch: `feat/chms-f001-foundation`, based on `133e321` (`main`).
- Pull request: [#3](https://github.com/BTC-Patrush/chms/pull/3), **draft**, not for merge yet.
- Pushed head: `2de49e7` (M00). GitHub CI was green on it.
- Local only, push not yet approved: `616c633` (erratum E3), `fb9abfe` (M01a migrations), `a68670a` (M01a tests), and the commit that adds this file.

## Where things stand
The toolchain, the PostgreSQL 18 compatibility proofs, migration M00 (roles, grants, audit trail) and migration M01a (the F001 tables) are implemented and tested. Locally, everything passes: 13 unit tests, and 87 database tests in two consecutive runs. GitHub CI has not run on M01a yet. The next step is the internal domain services and operator commands.

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
| `616c633` | Erratum E3 in ADR-006 (local) |
| `fb9abfe` | M01a: `drizzle/0001_m01a_tables.sql` and `0002_m01a_integrity.sql` (local) |
| `a68670a` | M01a contract tests (24) and the migration and static-boundary guards (local) |

**Compatibility proofs** (all pass; full evidence in PR #3):

| Check | Result |
|---|---|
| CP-01 | Image, UTF8 with the builtin locale, data surviving container recreation |
| CP-02 | `uuidv7()`, `xid8`, `casefold()` |
| CP-03, CP-04 | `drizzle-kit` generate, migrate and check; PostgreSQL 18 introspection |
| CP-05 | **drizzle-orm #6572 reproduces** |
| CP-06 | Row locks; gave erratum E1 |
| CP-07 | Restore: verified-empty target with `--single-transaction` |
| CP-08 | `casefold()` and `PG_UNICODE_FAST` chosen |
| CP-09 | Privilege behaviour; gave erratum E2 |
| TS-F001-33 | `withTransaction()` detects the swallowed failure |

**Test cases covered so far at the database level:** TS-F001-03, 04, 05, 06, 08, 09, 10, 11, 12, 13, 15, 16, 17, 18, 20, 21, 22, 23, 26, 27, 28, 29, 30, 31, 33 and 34, plus the static parts of 35 and 37.

## In progress
1. **Push** `616c633`, `fb9abfe` and `a68670a` (awaiting approval), confirm GitHub CI, and add the M01a evidence to PR #3's description. The M00 evidence is already there.
2. **Open question from the M01a checkpoint:** create events list `created_at` in `changed_fields`, because the design excludes only `row_version` and `updated_at`. It is a name, never a value. Should it be excluded?

## Next
Sequence step 5 is the internal domain services and operator commands; step 6 is full acceptance testing. In order:
1. Operator commands:
   - `bootstrapChurch`: as `chms_owner`, actor `bootstrap`; a no-op when the name matches, a failure when it differs (TS-F001-01, 02).
   - `renameChurch`: actor `maintenance`.
2. Services for campuses, people and affiliations, plus `listPeople` and `getPerson` with an explicit campus scope (TS-F001-24, 25). Rules for every service:
   - run inside `withTransaction`;
   - use the `row_version` check, mapping zero rows to `ConcurrentModification` (TS-F001-19, 32);
   - map errors outside the transaction by SQLSTATE plus constraint name, including `23001` for archives;
   - retry `40001`/`40P01` up to 3 times, plus one retry for a person archive, always in a new transaction.
3. Boundary schemas for names and inputs (TS-F001-14): reject strings that are not well-formed, normalize to NFC, trim Unicode whitespace, allow 1 to 100 code points. The library is **not chosen yet** (ADR-007 left it to the toolchain step); choose the smallest maintained option.
4. Remaining tests:
   - TS-F001-07 boundary part;
   - TS-F001-36, restore with bootstrap and post-data triggers;
   - TS-F001-38, the stress test;
   - service-level versions of the database-level cases.
5. Update the test matrix's execution status (every row still says NOT RUN), then ask the product owner to review PR #3.

## Decisions

**Product owner (Patrush, 2026-10-27)**
- BR-01 to BR-10 and POL-01 to POL-06 approved.
- ADR-001 to ADR-008 accepted, with amendments:
  - UUIDv7 via `uuidv7()`;
  - archive-first, with no erasure in F001;
  - the name rules (PPD-01): trimmed, NFC, no control characters or invalid Unicode, internal whitespace kept, 1 to 100 characters, case-insensitive uniqueness only for campus names.
- Implementation authorized: toolchain, and disposable local and CI PostgreSQL 18 databases, with the compatibility proofs run first.
- B-07 and B-09 to B-13 deferred, nonblocking.
- Errata approved:
  - **E1:** an archive refused by an active reference raises `23001`; an insert that references an archived row raises `23503`.
  - **E2:** an ordinary role cannot `ALTER ROLE … SET chms.*`; the session-level `SET` limitation remains.
  - **E3:** a schema-scoped `ALTER DEFAULT PRIVILEGES` cannot revoke PUBLIC EXECUTE; M00 uses the database-wide form.
  - The E1 and E2 corrections are also kept in the specification and security review.
- M00 implementation choices accepted:
  - `chms_owner` has CREATE on the database;
  - `audit_events` has a UUIDv7 primary key;
  - the audit trigger takes the entity type as an argument;
  - `chms.actor_kind` and `chms.actor_user_id` are read only so their checks reject them;
  - operators in the audit function are left unqualified.

**Engineering (in commit messages and PR #3)**
- **Versions:** at least 14 days old unless a security fix requires newer. Next.js 16.4.1 for the critical RCEs GHSA-673q and GHSA-2464; Node.js 24.22.1 is a security release. drizzle-kit's nested esbuild is overridden to 0.25.12, giving 0 audit findings.
- **Lint:** ESLint 10 with `@next/eslint-plugin-next` and `react-hooks`. `eslint-config-next` was dropped because its React, import and accessibility plugins don't support ESLint 10, and ESLint 9 is unsupported.
- **Case comparison:** `casefold()` for campus-name uniqueness, under the builtin `PG_UNICODE_FAST` locale; the `lower()` fallback is not needed.
- **Transactions:** `withTransaction()` checks PostgreSQL's reply to COMMIT and blocks nested `transaction()`. Drizzle's own `db.transaction()` reports success on a rolled-back transaction (#6572).
- **Migrations:**
  - The generated M01a migration drops `CREATE SCHEMA "chms"`, because M00 owns the schema.
  - The audit foreign key to `churches` lives in M01a.
  - A unit test keeps `0001` equal to the schema, so the compatibility proofs apply to it.
- **Name-rule regular expressions:** escapes are built from code points at runtime, so the source and the DDL stay ASCII.

## Open items
- Dependabot covers GitHub Actions only; npm and the Docker image digest need a decision.
- The frontend workstream needs the React, import and `jsx-a11y` lint plugins once they support ESLint 10.
- The repository is public, so the security documents are publicly readable.
- Deferred and tracked: RR-15 (beyond F001), RR-17, RR-18, SR-12 (UUIDv7 creation time, before F002), B-09 (operations runbook).

## Notes for the next session
- **Node:** the shell may still resolve Node 24.20.0, which `engine-strict` rejects. Use `nvm use`, or put `~/.nvm/versions/node/v24.22.1/bin` first on `PATH`.
- **Local cluster:** the container is stopped. Volume `chms_pgdata` was initialized with a password file in the previous session's scratchpad, which may be gone. Create your own password file (README, Local development). Then recreate the volume with `docker compose down --volumes` and `docker compose up --detach --wait`. This is disposable data, but the command needs approval. Tests re-provision the four roles with fresh passwords.
- **Approval prompts:** `drizzle-kit`, `psql`, `pg_dump`, `pg_restore`, `docker compose exec`, `docker compose down` and `git push` need approval. Run them directly, never wrapped to avoid the prompt.
- **drizzle-kit 0.31.11:** it exits 0 even after an error, so check its output. It mishandles absolute `--out` paths; use `./drizzle`.
