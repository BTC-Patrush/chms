# CHMS-F001 — Test and acceptance matrix

Status: **in execution.** Every test case below has passed at least once, at the levels and in the runs named in its execution status ([execution evidence](#execution-evidence)). Service-level results come from local runs only; GitHub CI has run the database level. Previously: "planned; no test has been executed" ([history](#history)).

Acceptance criteria are defined in the [specification](specification.md#acceptance-criteria-given--when--then); this matrix references them by ID.

Test levels:
- **Unit:** no database.
- **Integration:** real PostgreSQL 18, never mocked.
- **Concurrency:** two or more connections; each interleaving is confirmed with `pg_blocking_pids()`, then the invariant probes are run.
- **Security:** privileges and adversarial direct SQL.
- **Migration**, **Recovery**, **Static** (repository scan).

Invariant probes: no active affiliation joins an archived campus or an archived person (see [database design §4](../../database/CHMS-F001-database-design.md#4-transaction-behavior)).

| Requirement ID | Acceptance criterion | Test case | Test level | Expected result | Execution status |
|---|---|---|---|---|---|
| BR-01, BR-09, POL-01 | AC-F001-01 | TS-F001-01: bootstrap on an empty database | Integration | 1 church; 1 audit event (`system`, `bootstrap`, `create`) | PASS (service: R2) |
| BR-01, BR-09 | AC-F001-02 | TS-F001-02: rerun bootstrap with the same name, then with a different name | Integration | Same name: `row_version` and audit count unchanged. Different name: `ChurchMismatch`, nothing changed | PASS (service: R2) |
| BR-01 | AC-F001-03 | TS-F001-03: `chms_app` inserts a church; the owner inserts a second church | Security | `42501`; `23505` on `churches_singleton_uq` | PASS (database: R1, R2; service: R2) |
| BR-09 | AC-F001-04 | TS-F001-04: update `churches.id` as app and as owner; rename via maintenance | Security | `42501`; `CHI01`; name changed, with 1 audit event `update {name}` | PASS (database: R1, R2; service: R2) |
| BR-09, TD-03 | AC-F001-05 | TS-F001-05: update identity columns on campuses, people and affiliations as app and as owner | Security | `42501` (app); `CHI01` (owner) | PASS (database: R1, R2) |
| BR-07, TD-09 | AC-F001-06 | TS-F001-06: "North", then "north"/"NORTH"; archived "North", then new "NORTH"; rename another campus to "north" | Integration | `23505` on `campuses_name_ci_uq` in every case | PASS (database: R1, R2; service: R2) |
| BR-07, PPD-01, TD-09 | AC-F001-06 | TS-F001-07: comparison and validation table for campus names under the chosen locale and comparison function (proof CP-08): `ß`/`SS`, `İ`/`i`, `Σ`/`σ`/`ς`; NFC vs NFD; leading or trailing space, tab and no-break space; an internal double space; a control character; 100 vs 101 characters; capitalization preserved after a duplicate is rejected | Integration (proof of concept) | NFD input is stored as NFC; untrimmed, control-character and 101-character names are rejected (`23514`); 100 characters and internal double spaces are accepted unchanged; case variants are rejected (`23505`); capitalization is preserved. Results for `ß`, `İ` and sigma are recorded together with the function chosen (`casefold()` or `lower()`) | PASS (database: R1, R2, CP-08; service boundary part: R2). `casefold()` under `PG_UNICODE_FAST`: `ß` = `SS` and every sigma form are equal (`23505`); `İ` and `i` differ |
| BR-06 | AC-F001-07 | TS-F001-08: archive a campus with an active link; end all links; archive again | Integration | `23001` on `pca_campus_active_fk` → `CampusHasActiveAffiliations` [E1]; then success | PASS (database: R1, R2; service: R2) |
| BR-06, TD-04 | AC-F001-08 | TS-F001-09: link to an archived campus, through the service and by direct SQL | Integration / Security | `23503` on `pca_campus_active_fk` | PASS (database: R1, R2; service: R2) |
| BR-06, TD-04 | AC-F001-09 | TS-F001-10: T1 archives the campus (uncommitted); T2's insert is confirmed blocked; T1 commits | Concurrency | T2 fails with `23503`; probes return 0 | PASS (database: R1, R2, CP-06; service: R2) |
| BR-06, TD-04 | AC-F001-09 | TS-F001-11: T2 inserts a link (uncommitted); T1's archive is confirmed blocked; T2 commits (and a rollback variant) | Concurrency | T1 fails with `23001` [E1] (rollback variant: T1 succeeds); probes return 0 | PASS (database: R1, R2, CP-06 and M01a; service, commit and rollback variants: R2) |
| BR-06, TD-04 | AC-F001-09 | TS-F001-12: TS-F001-10 and TS-F001-11 at REPEATABLE READ | Concurrency | The insert loser fails with `40001` and the archive loser with `23001` [E1]; the two never both commit; probes return 0 | PASS (database: R1, R2, CP-06). No service variant: services always run at READ COMMITTED |
| BR-02, TD-02 | AC-F001-10 | TS-F001-13: create a person with a display name only; inspect the id and `information_schema`; app inserts with a supplied `id` | Integration / Security | `uuid_extract_version(id)` returns 7 and the column default is `uuidv7()`; no account column exists; `42501` | PASS (database: R1, R2; service: R2) |
| BR-08, PPD-01, TD-11 | AC-F001-11 | TS-F001-14: boundary-schema table for display names and components (missing, empty, whitespace-only, control characters, not well-formed Unicode such as a lone surrogate, 100 vs 101 characters after trimming, non-NFC, leading and trailing whitespace, an internal double space; components omitted; empty component) | Unit | Invalid names and empty components are rejected; input is trimmed and normalized to NFC; internal whitespace is kept; 100 characters and omitted components are accepted | PASS (unit: R2) |
| BR-08, PPD-01, TD-11 | AC-F001-11 | TS-F001-15: direct SQL on `people.display_name`, `given_name`, `family_name` and `churches.name` with untrimmed, non-NFC, control-character, empty and 101-character values, and NULL components | Integration | `23514` for each invalid value; NULL components accepted | PASS (database: R1, R2, M01a and CP-08) |
| BR-03 | AC-F001-12 | TS-F001-16: zero links; two campuses; duplicate active pair; second primary; end, then re-link | Integration | Valid cases succeed; `23505` on `pca_active_pair_uq` / `pca_active_primary_uq`; re-link creates a new id; the ended row keeps `is_primary` | PASS (database: R1, R2; service: R2) |
| BR-03 | AC-F001-12 | TS-F001-17: two concurrent "set primary" operations for one person | Concurrency | Exactly one succeeds; the other fails with `23505` | PASS (database: R1, R2; service, two variants: R2) |
| BR-04 | AC-F001-13 | TS-F001-18: archive a person with two active links (one primary) | Integration | Both links ended (`person_archived`, primary kept); person archived; 3 audit events sharing one `xact_id` | PASS (database: R1, R2; service: R2) |
| BR-04 | AC-F001-13 | TS-F001-19: archive a person with a stale `row_version` | Integration | `ConcurrentModification`; the links are still active | PASS (service: R2) |
| BR-04, TD-04 | AC-F001-14 | TS-F001-20: T1 has ended the links (step 1); T2 inserts a link and commits; T1 runs step 2 | Concurrency | T1 fails with `23001` on `pca_person_active_fk` [E1] and rolls back completely; the retry ends all three links; probes return 0 | PASS (database: R1, R2, CP-06; service: R2) |
| BR-04, TD-04 | AC-F001-14 | TS-F001-21: T1's archive is complete but uncommitted; T2's insert is confirmed blocked; T1 commits | Concurrency | T2 fails with `23503`; probes return 0 | PASS (database: R1, R2; service: R2) |
| BR-05 | AC-F001-15 | TS-F001-22: unarchive the person; re-link | Integration | Person active with 0 active links; history unchanged; re-link creates a new row | PASS (database: R1, R2; service: R2) |
| BR-04, TD-12 | AC-F001-16 | TS-F001-23: update an ended row (`ended_at`, `is_primary`, `end_reason`); `DELETE` on each F001 table as app | Security | `CHH01`; `42501` | PASS (database: R1, R2) |
| CLAUDE.md (campus scope) | AC-F001-17 | TS-F001-24: people A(X), B(Y), C(no link) and D(X, archived) listed under {X}, {Y}, {X,Y}, whole church, and whole church including archived | Integration (leakage) | A; B; A,B; A,B,C; A,B,C,D | PASS (service: R2) |
| CLAUDE.md (campus scope) | AC-F001-17 | TS-F001-25: random links and scopes with a fixed seed | Integration (property) | Every returned person has an active link to a campus in scope | PASS (service, seed 20261028: R2) |
| POL-01, TD-05 | AC-F001-18 | TS-F001-26: changes through the service and by direct SQL; forced rollback | Integration | 1 audit event per row; derived action; names only, with no marker values; rollback leaves no events; one `xact_id` per operation | PASS (database: R1, R2; service: R2) |
| POL-01, POL-02 | AC-F001-19 | TS-F001-27: no actor; unknown category; human actor kind; category `test` in a production-profile database vs. a test-profile database | Security | `CHA01`; `23503` on `audit_actor_category_fk`; `23514`; rejected in production profile, accepted in test profile | PASS (database: R1, R2; service: R2) |
| POL-01 | AC-F001-19 | TS-F001-28: on one pooled connection, transaction 1 sets an actor with `set_config(…, true)` and commits; transaction 2 sets none. Check `pg_db_role_setting` for `chms.*` defaults, and that `chms_app` cannot create one with `ALTER ROLE ... SET` [E2]. Demonstrate that a session-level `SET` persists across transactions (documented limitation) | Security | Transaction 2 fails with `CHA01`; the `ALTER ROLE` attempt fails with `42501` [E2]; no `chms.*` role or database defaults exist; session-level persistence observed and recorded | PASS (database: R1, R2) |
| POL-03, POL-04 | AC-F001-20 | TS-F001-29: full audit access matrix for app, reader and owner; reader membership; catalog scan for deletion jobs | Security | App gets `42501` for all five operations; reader can only `SELECT`; owner gets `CHA02`; members match the configured list; no deletion mechanism found | PASS (database: R1, R2) |
| TD-05 | AC-F001-21 | TS-F001-30: inspect `pg_proc` (`prosecdef`, owner, `proconfig`); `PUBLIC` execute privilege; app `CREATE TEMP TABLE` | Security | `true`; a `NOLOGIN` owner; `search_path=pg_catalog, pg_temp`; no `PUBLIC` execute; `42501` | PASS (database: R1, R2) |
| TD-06 | AC-F001-22 | TS-F001-31: role attributes; every cell of the privilege matrix; app tries `SET session_replication_role`, `ALTER TABLE … DISABLE TRIGGER`, `CREATE`/`DROP TRIGGER`, `TRUNCATE`, and `LOCK TABLE … IN ACCESS EXCLUSIVE MODE`; predefined-role memberships; `PUBLIC` database privileges | Security | Exact match with the matrix; `42501` for each attempt. The `LOCK` result is expected but unverified, because the grants are column-level. No memberships; no `CONNECT`/`TEMPORARY` for `PUBLIC` | PASS (database: R1, R2). `LOCK`: column-level grantees get only `ACCESS SHARE` (CP-09) |
| TD-07 | AC-F001-23 | TS-F001-32: two updates with the same `row_version`, in a deterministic interleaving | Concurrency | One success; one `ConcurrentModification`; 1 audit event | PASS (service: R2) |
| TD-07, TD-08 | AC-F001-24 | TS-F001-33: an error is caught inside the transaction callback and the callback returns. This deliberately breaks the ADR-004 rule, to reproduce or rule out the *reported, unverified* drizzle-orm #6572 (CP-05) | Integration | The service call rejects and the database is unchanged. If #6572 reproduces, the service transaction wrapper must detect the rollback before this test can pass | PASS (database: R1, R2) |
| CLAUDE.md (logging) | AC-F001-25 | TS-F001-34: scan captured logs and the audit table for marker strings | Security | No marker found | PASS (database: R1, R2; service, logs and errors: R2) |
| TD-08 | AC-F001-26 | TS-F001-35: migrate an empty PostgreSQL 18 database; rerun; drift check, including a catalog comparison for custom objects; static check of application startup | Migration | Applies; rerun is a no-op; no drift; startup never migrates | PASS (database and unit: R1, R2; `drizzle-kit check`: R2). The catalog comparison covers triggers and privileges exactly, not every function body |
| BR-09, POL-05 | AC-F001-27 | TS-F001-36: dump and restore into an empty database, then bootstrap; `pg_restore --single-transaction` into a bootstrapped database; static check for delete or replace paths | Recovery | Same church id; bootstrap is a no-op; the single-transaction restore fails and loads nothing into any table; no such path exists | PASS (recovery drill: R3; static part: R2) |
| POL-06, TD-10 | AC-F001-28 | TS-F001-37: scan for routes, pages, server actions and `"use server"`; import graph | Static | None found; F001 services imported only by commands and tests | PASS (static: R1, R2; import graph: R2) |
| BR-04, BR-06, POL-01 | AC-F001-09, AC-F001-14, AC-F001-18 | TS-F001-38: fixed seed, 8 workers × 500 random operations at READ COMMITTED, under 60 s | Concurrency (stress) | Probes return 0; audit events equal successful changes | PASS (R2: 4,000 operations in 4,035 ms) |

Coverage: all 28 acceptance criteria have at least one test case. Requirements with no F001 test: BR-10 (verified by compatibility proofs CP-01 to CP-09, not by tests).

## Execution evidence

All runs used Node.js 24.22.1 and PostgreSQL 18.6 (`postgres:18-trixie`, pinned by digest), on disposable databases only.

| Run | Date | Where and what | Result |
|---|---|---|---|
| R1 | 2026-10-28 | GitHub CI run [40751257498](https://github.com/BTC-Patrush/chms/actions/runs/40751257498) on `a68670a` (database level: compatibility proofs, M00, M01a, `withTransaction`) | `npm run test:db` 87 passed; `npm run test:unit` 13 passed |
| R2 | 2026-10-28 | Local, on `d0ebc88` (unit, database and service levels) | `npm run test:unit` 67 passed; `npm run test:db` 124 passed, twice in a row; the service concurrency file alone passed 10 runs in a row. `npx drizzle-kit check`: "Everything's fine". Not yet run in CI |
| R3 | 2026-10-28 | Local recovery drill, run by hand because `pg_dump` and `pg_restore` need approval each time | 10 of 10 checks passed (below) |

**R3, TS-F001-36.** A source database was migrated and bootstrapped through the services, with synthetic data: 2 campuses, 3 people, 3 affiliations and 12 audit events.
1. `docker compose exec -T postgres pg_dump -U postgres -Fc` of the source.
2. `pg_restore --single-transaction` into a database with the provisioning applied and 0 relations: exit 0. The church id, row counts, 12 audit events, 11 triggers and `chms_app` grants equal the source; the restore wrote no audit event, because triggers are post-data.
3. `bootstrapChurch` with the same name: `created = false`, same church id, no audit event. With another name: `ChurchMismatch`.
4. A service write after the restore is audited exactly once.
5. `pg_restore --single-transaction` into a different, already bootstrapped database: exit 1 (`schema "chms" already exists`), and nothing loaded; its counts are unchanged.
6. The three databases and the dump file were removed.

**Limits.**
- R2 is local: CI runs those tests only after the service commits are pushed.
- R3 is manual. Its helper script, which prepared and checked the databases around the `pg_dump` and `pg_restore` commands, was not committed. Automating TS-F001-36 needs a decision, because both commands require approval on each run.
- TS-F001-12 has no service variant, because services never use REPEATABLE READ.
- TS-F001-38's operation choices are seeded, but the eight workers interleave differently on each run, so the mix of conflicts varies.

## History

- 2026-10-28: execution statuses set from runs R1 to R3. Before that, the status line read "planned. **No test has been executed. Every execution status is NOT RUN.**", and every row read NOT RUN.

## Errata

- **E1** (2026-10-27, CP-06 on PostgreSQL 18.6): an archive `UPDATE` refused by a status-carrying `ON UPDATE RESTRICT` key raises `23001` (`restrict_violation`), not `23503`. An `INSERT` that references an archived row still raises `23503`. Error mapping uses `23001` plus the constraint name for archive operations. Affects TS-F001-08, 11, 12 and 20, which originally expected `23503` for the archive side.
- **E2** (2026-10-27, CP-09 on PostgreSQL 18.6): PostgreSQL denies an ordinary role `ALTER ROLE ... SET` for placeholder parameters such as `chms.actor_category` (`42501`); only a superuser can create such a default. The session-level `SET` limitation remains (CP-05, CP-09). Affects TS-F001-28, which now also checks the denied `ALTER ROLE` attempt.
