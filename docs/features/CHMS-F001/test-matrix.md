# CHMS-F001 — Test and acceptance matrix

Status: planned. **No test has been executed. Every execution status is NOT RUN.**

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
| BR-01, BR-09, POL-01 | AC-F001-01 | TS-F001-01: bootstrap on an empty database | Integration | 1 church; 1 audit event (`system`, `bootstrap`, `create`) | NOT RUN |
| BR-01, BR-09 | AC-F001-02 | TS-F001-02: rerun bootstrap with the same name, then with a different name | Integration | Same name: `row_version` and audit count unchanged. Different name: `ChurchMismatch`, nothing changed | NOT RUN |
| BR-01 | AC-F001-03 | TS-F001-03: `chms_app` inserts a church; the owner inserts a second church | Security | `42501`; `23505` on `churches_singleton_uq` | NOT RUN |
| BR-09 | AC-F001-04 | TS-F001-04: update `churches.id` as app and as owner; rename via maintenance | Security | `42501`; `CHI01`; name changed, with 1 audit event `update {name}` | NOT RUN |
| BR-09, TD-03 | AC-F001-05 | TS-F001-05: update identity columns on campuses, people and affiliations as app and as owner | Security | `42501` (app); `CHI01` (owner) | NOT RUN |
| BR-07, TD-09 | AC-F001-06 | TS-F001-06: "North", then "north"/"NORTH"; archived "North", then new "NORTH"; rename another campus to "north" | Integration | `23505` on `campuses_name_ci_uq` in every case | NOT RUN |
| BR-07, TD-09 | AC-F001-06 | TS-F001-07: comparison and validation table for campus names under the chosen locale (proof CP-08): `ß`/`SS`, `İ`/`i`, `Σ`/`σ`/`ς`; NFC vs NFD; leading or trailing space, tab and no-break space; 120 vs 121 characters; capitalization preserved after a duplicate is rejected | Integration (proof of concept) | Observed results recorded. **Pass criteria are fixed once PPD-01 (RR-16) is confirmed** | NOT RUN |
| BR-06 | AC-F001-07 | TS-F001-08: archive a campus with an active link; end all links; archive again | Integration | `23503` on `pca_campus_active_fk` → `CampusHasActiveAffiliations`; then success | NOT RUN |
| BR-06, TD-04 | AC-F001-08 | TS-F001-09: link to an archived campus, through the service and by direct SQL | Integration / Security | `23503` on `pca_campus_active_fk` | NOT RUN |
| BR-06, TD-04 | AC-F001-09 | TS-F001-10: T1 archives the campus (uncommitted); T2's insert is confirmed blocked; T1 commits | Concurrency | T2 fails with `23503`; probes return 0 | NOT RUN |
| BR-06, TD-04 | AC-F001-09 | TS-F001-11: T2 inserts a link (uncommitted); T1's archive is confirmed blocked; T2 commits (and a rollback variant) | Concurrency | T1 fails with `23503` (rollback variant: T1 succeeds); probes return 0 | NOT RUN |
| BR-06, TD-04 | AC-F001-09 | TS-F001-12: TS-F001-10 and TS-F001-11 at REPEATABLE READ | Concurrency | Loser fails with `40001` or `23503`; the two never both commit; probes return 0 | NOT RUN |
| BR-02, TD-02 | AC-F001-10 | TS-F001-13: create a person with a display name only; inspect the id and `information_schema`; app inserts with a supplied `id` | Integration / Security | UUID version nibble is 4; no account column exists; `42501` | NOT RUN |
| BR-08, TD-11 | AC-F001-11 | TS-F001-14: boundary-schema table (missing, empty, whitespace-only, control characters, too long, non-NFC; components omitted; empty component) | Unit | Invalid display names and empty components are rejected; omitted components are accepted | NOT RUN |
| BR-08, TD-11 | AC-F001-11 | TS-F001-15: direct SQL with invalid `display_name`, an empty `given_name`, and NULL components | Integration | `23514` for each invalid value; NULL components accepted | NOT RUN |
| BR-03 | AC-F001-12 | TS-F001-16: zero links; two campuses; duplicate active pair; second primary; end, then re-link | Integration | Valid cases succeed; `23505` on `pca_active_pair_uq` / `pca_active_primary_uq`; re-link creates a new id; the ended row keeps `is_primary` | NOT RUN |
| BR-03 | AC-F001-12 | TS-F001-17: two concurrent "set primary" operations for one person | Concurrency | Exactly one succeeds; the other fails with `23505` | NOT RUN |
| BR-04 | AC-F001-13 | TS-F001-18: archive a person with two active links (one primary) | Integration | Both links ended (`person_archived`, primary kept); person archived; 3 audit events sharing one `xact_id` | NOT RUN |
| BR-04 | AC-F001-13 | TS-F001-19: archive a person with a stale `row_version` | Integration | `ConcurrentModification`; the links are still active | NOT RUN |
| BR-04, TD-04 | AC-F001-14 | TS-F001-20: T1 has ended the links (step 1); T2 inserts a link and commits; T1 runs step 2 | Concurrency | T1 fails with `23503` on `pca_person_active_fk` and rolls back completely; the retry ends all three links; probes return 0 | NOT RUN |
| BR-04, TD-04 | AC-F001-14 | TS-F001-21: T1's archive is complete but uncommitted; T2's insert is confirmed blocked; T1 commits | Concurrency | T2 fails with `23503`; probes return 0 | NOT RUN |
| BR-05 | AC-F001-15 | TS-F001-22: unarchive the person; re-link | Integration | Person active with 0 active links; history unchanged; re-link creates a new row | NOT RUN |
| BR-04, TD-12 | AC-F001-16 | TS-F001-23: update an ended row (`ended_at`, `is_primary`, `end_reason`); `DELETE` on each F001 table as app | Security | `CHH01`; `42501` | NOT RUN |
| CLAUDE.md (campus scope) | AC-F001-17 | TS-F001-24: people A(X), B(Y), C(no link) and D(X, archived) listed under {X}, {Y}, {X,Y}, whole church, and whole church including archived | Integration (leakage) | A; B; A,B; A,B,C; A,B,C,D | NOT RUN |
| CLAUDE.md (campus scope) | AC-F001-17 | TS-F001-25: random links and scopes with a fixed seed | Integration (property) | Every returned person has an active link to a campus in scope | NOT RUN |
| POL-01, TD-05 | AC-F001-18 | TS-F001-26: changes through the service and by direct SQL; forced rollback | Integration | 1 audit event per row; derived action; names only, with no marker values; rollback leaves no events; one `xact_id` per operation | NOT RUN |
| POL-01, POL-02 | AC-F001-19 | TS-F001-27: no actor; unknown category; human actor kind; category `test` in a production-profile database vs. a test-profile database | Security | `CHA01`; `23503` on `audit_actor_category_fk`; `23514`; rejected in production profile, accepted in test profile | NOT RUN |
| POL-01 | AC-F001-19 | TS-F001-28: on one pooled connection, transaction 1 sets an actor with `set_config(…, true)` and commits; transaction 2 sets none. Check `pg_db_role_setting` for `chms.*` defaults. Demonstrate that a session-level `SET` persists across transactions (documented limitation) | Security | Transaction 2 fails with `CHA01`; no `chms.*` role or database defaults exist; session-level persistence observed and recorded | NOT RUN |
| POL-03, POL-04 | AC-F001-20 | TS-F001-29: full audit access matrix for app, reader and owner; reader membership; catalog scan for deletion jobs | Security | App gets `42501` for all five operations; reader can only `SELECT`; owner gets `CHA02`; members match the configured list; no deletion mechanism found | NOT RUN |
| TD-05 | AC-F001-21 | TS-F001-30: inspect `pg_proc` (`prosecdef`, owner, `proconfig`); `PUBLIC` execute privilege; app `CREATE TEMP TABLE` | Security | `true`; a `NOLOGIN` owner; `search_path=pg_catalog, pg_temp`; no `PUBLIC` execute; `42501` | NOT RUN |
| TD-06 | AC-F001-22 | TS-F001-31: role attributes; every cell of the privilege matrix; app tries `SET session_replication_role`, `ALTER TABLE … DISABLE TRIGGER`, `CREATE`/`DROP TRIGGER`, `TRUNCATE`, and `LOCK TABLE … IN ACCESS EXCLUSIVE MODE`; predefined-role memberships; `PUBLIC` database privileges | Security | Exact match with the matrix; `42501` for each attempt. The `LOCK` result is expected but unverified, because the grants are column-level. No memberships; no `CONNECT`/`TEMPORARY` for `PUBLIC` | NOT RUN |
| TD-07 | AC-F001-23 | TS-F001-32: two updates with the same `row_version`, in a deterministic interleaving | Concurrency | One success; one `ConcurrentModification`; 1 audit event | NOT RUN |
| TD-07, TD-08 | AC-F001-24 | TS-F001-33: an error is caught inside the transaction callback and the callback returns. This deliberately breaks the ADR-004 rule, to reproduce or rule out the *reported, unverified* drizzle-orm #6572 (CP-05) | Integration | The service call rejects and the database is unchanged. If #6572 reproduces, the service transaction wrapper must detect the rollback before this test can pass | NOT RUN |
| CLAUDE.md (logging) | AC-F001-25 | TS-F001-34: scan captured logs and the audit table for marker strings | Security | No marker found | NOT RUN |
| TD-08 | AC-F001-26 | TS-F001-35: migrate an empty PostgreSQL 18 database; rerun; drift check, including a catalog comparison for custom objects; static check of application startup | Migration | Applies; rerun is a no-op; no drift; startup never migrates | NOT RUN |
| BR-09, POL-05 | AC-F001-27 | TS-F001-36: dump and restore into an empty database, then bootstrap; `pg_restore --single-transaction` into a bootstrapped database; static check for delete or replace paths | Recovery | Same church id; bootstrap is a no-op; the single-transaction restore fails and loads nothing into any table; no such path exists | NOT RUN |
| POL-06, TD-10 | AC-F001-28 | TS-F001-37: scan for routes, pages, server actions and `"use server"`; import graph | Static | None found; F001 services imported only by commands and tests | NOT RUN |
| BR-04, BR-06, POL-01 | AC-F001-09, AC-F001-14, AC-F001-18 | TS-F001-38: fixed seed, 8 workers × 500 random operations at READ COMMITTED, under 60 s | Concurrency (stress) | Probes return 0; audit events equal successful changes | NOT RUN |

Coverage: all 28 acceptance criteria have at least one test case. Requirements with no F001 test: BR-10 (verified by compatibility proofs CP-01 to CP-09, not by tests).
