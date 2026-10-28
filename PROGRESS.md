# CHMS progress and handoff

Last updated: 2026-10-28. Feature: **CHMS-F001 — Church, Campus and Person Foundation** (backend only).

- Branch: `feat/chms-f001-foundation`, based on `133e321` (`main`).
- Pull request: [#3](https://github.com/BTC-Patrush/chms/pull/3), **ready for review, not merged**. Merging needs human review and approval. Its description has the evidence and the latest CI status.

## Where things stand
CHMS-F001 is implemented. The branch contains:
- the toolchain, CI and PostgreSQL 18 compatibility proofs;
- migrations M00 and M01a;
- the internal services, the operator CLI and the committed restore drill.

Every TS-F001 case has passed. The test matrix's [execution evidence](docs/features/CHMS-F001/test-matrix.md#execution-evidence) names the runs:
- **R1, R4:** GitHub CI.
- **R2, R5:** local runs.
- **R3, R6:** manual restore drills.

On `edd7472`, locally:
- 72 unit tests;
- 132 database tests, in two consecutive runs;
- the concurrency file in 10 consecutive runs;
- the committed drill, 10 of 10 checks.

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
| `55bcdd6`, `2de49e7` | M00 provisioning and migration, and its security tests |
| `616c633` | Erratum E3 in ADR-006 |
| `fb9abfe`, `a68670a` | M01a migrations and contract tests |
| `a7c0a70` | First version of this file |
| `d5cd20f`, `6c8115d` | Services, operator command functions, error mapping, boundary schemas, and their tests |
| `d0ebc88` | Renaming an archived campus is refused (now PPD-02 (a)) |
| `e37c467` | Test execution evidence (R1 to R3) |
| `23ba17d` | Archived people only on explicit request, lookups by id included (PPD-02 (b)) |
| `c23e1c7` | Operator CLI (`src/commands`, `npm run chms`) with unit and database tests |
| `edd7472` | Committed restore drill (`tests/recovery/restore-drill.ts`, `npm run drill:restore`) |

## Decisions

**Product owner (Patrush)**
- **2026-10-27:**
  - BR-01 to BR-10, POL-01 to POL-06 and PPD-01 approved.
  - ADR-001 to ADR-008 accepted, with amendments.
  - Errata E1 to E3 approved.
  - M00 implementation choices accepted.
  - B-07 and B-09 to B-13 deferred, nonblocking.
- **2026-10-28:**
  - `created_at` stays in audit `changed_fields`.
  - **PPD-02 closes RR-19** (decision register §3):
    - (a) renaming an archived campus is refused;
    - (b) archived people only when "include archived" is requested under whole-church scope, lookups by id included;
    - (c) archived people's names stay editable, audited;
    - (d) explicit domain error codes, never personal data.
  - **Hand-written validation; no validation library in F001.**
  - Operator CLI with passwords from files, and the restore drill committed.
  - PR #3 to be marked ready for review, and not merged.

**Engineering (in commit messages; reviewed in PR #3)**
- **Drizzle wraps PostgreSQL errors** in `DrizzleQueryError`, whose message repeats the query parameters. Mapping unwraps `cause`, and an unmapped failure is rethrown as `DatabaseFailureError` with only the SQLSTATE and constraint.
- **Drizzle's insert lists every column**, which column-level grants reject. Inserts are therefore explicit SQL.
- **`util.parseArgs` error messages can echo arguments**, so the CLI reports only the kind of error. Password files are refused when group or others can access them, as libpq does for `.pgpass`.
- **Service semantics outside design §4:**
  - `setPrimaryAffiliation` moves the primary in one transaction.
  - `updatePersonNames` replaces all three names.
  - Zero-row updates are classified as not found, `ConcurrentModification` or a state error.

## Open items
- **TLS:** the CLI connection does not configure TLS. That is needed before any non-loopback use. Production deployment is out of F001 scope.
- **No campus listing command.** No `listCampuses` service exists, so operators read campus ids and row versions from command output or SQL.
- **The restore drill stays manual,** because `pg_dump` and `pg_restore` need approval on each run.
- **Before merge:**
  - human review of the migrations (DoD 5);
  - the product owner's review of PR #3.
- **Carried over:**
  - Dependabot covers GitHub Actions only.
  - The frontend workstream needs the React, import and `jsx-a11y` lint plugins.
  - The repository is public.
  - Deferred: RR-15, RR-17, RR-18, SR-12 and B-09.

## Next
1. Human review of PR #3, then a merge decision by the product owner.
2. After the merge: plan CHMS-F002, which needs RR-07, RR-13 and the D-01 role model first.

## Notes for the next session
- **Node:** use `nvm use`, or put `~/.nvm/versions/node/v24.22.1/bin` first on `PATH`. `engine-strict` rejects 24.20.0.
- **Local cluster:**
  - Running, with its password file at `~/.config/chms/pg-admin-password` (the README path).
  - Export `CHMS_PG_ADMIN_PASSWORD_FILE` before `npm run test:db`, `npm run drill:restore` or `docker compose`.
  - The drill and the test suite both reset the login roles' passwords, so do not run them at the same time.
- **Vitest 5 hides the console output of passing tests.** Use `--silent=false` for the TS-F001-38 timing.
- **Approval prompts:** `drizzle-kit`, `psql`, `pg_dump`, `pg_restore`, `docker compose exec`, `docker compose down` and `git push` need approval. Run them directly, never wrapped to avoid the prompt.
- **drizzle-kit 0.31.11:** it exits 0 even after an error, so check its output. Use `./drizzle` for `--out`.
- **`gh pr edit` fails** on the deprecated Projects-classic GraphQL field. Use `gh api -X PATCH repos/BTC-Patrush/chms/pulls/3`.
