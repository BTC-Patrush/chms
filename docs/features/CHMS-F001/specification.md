# CHMS-F001 — Church, Campus and Person Foundation
Status: Draft — business rules approved by the product owner on 2026-10-27; technical design Proposed; not approved for implementation
Domain: D-02 Church (partial), D-03 People (partial)
Requirement IDs: BR-01 to BR-10 and POL-01 to POL-06 (provisional, feature-scoped identifiers; RR-18)
Owner: Product owner (named approver to be recorded at review)

| Related document | Link |
|---|---|
| Approved business rules (authoritative text) | [D-02](../../requirements/domains/D-02-church.md#approved-business-rules-chms-f001), [D-03](../../requirements/domains/D-03-people.md#approved-business-rules-chms-f001) |
| Decision register | [CHMS-F001-decision-register.md](../../decisions/CHMS-F001-decision-register.md) |
| Database design (proposed) | [CHMS-F001-database-design.md](../../database/CHMS-F001-database-design.md) |
| Security review | [CHMS-F001-security-review.md](../../architecture/CHMS-F001-security-review.md) |
| Test and acceptance matrix | [test-matrix.md](test-matrix.md) |
| Implementation readiness | [implementation-readiness.md](implementation-readiness.md) |

## Business problem and scope
Every later ChMS module needs one trustworthy record of the church, its campuses and the people it serves, with integrity enforced by the database rather than by convention. CHMS-F001 is a **backend and data foundation**: schema, database roles, audit, internal domain services, operator commands and automated tests. It has no end-user surface. The planned follow-up, CHMS-F002 (POL-06), is an authenticated, campus-scoped people directory, specified separately.

**In scope:**
- One church per installation, with multiple campuses.
- People independent of accounts.
- Person–campus affiliations, with history.
- Archiving and unarchiving.
- A database-enforced audit trail with system actors.
- An operator bootstrap command and operator maintenance commands.
- Internal domain services.
- Automated tests against PostgreSQL 18.

**Out of scope:**
- HTTP routes, pages, server actions, UI and public APIs (TD-10).
- Authentication, IAM roles, human actors and row-level security.
- Production deployment.
- All other domains, unchanged: D-01 and D-04 to D-16.

**Deferred D-02/D-03 MVP requirements.** These are not delivered by F001 and remain MVP scope:
- households and household membership
- person relationships
- membership status and basic visitor status (RR-12)
- contact details
- date of birth and handling of minors
- campus details (address, timezone)
- duplicate detection and merge
- erasure and retention (RR-10)
- imports

## Actors, permissions and scope
| Actor | F001 capability | Database role / actor category |
|---|---|---|
| Operator (bootstrap) | Creates the church once | `chms_owner` / `bootstrap` |
| Operator (maintenance) | Renames the church; manages campuses, people and affiliations | `chms_app` / `maintenance` |
| Authorized audit reader | Reads audit events (POL-03) | member of `chms_audit_reader` |
| Authenticated user | None in F001 | — (CHMS-F002) |

Every read takes an explicit scope: a set of campuses, or the whole church. Deciding who holds which scope belongs to D-01 and F002.

## Functional requirements
| Capability | Rules |
|---|---|
| Bootstrap the church; rename it with audit | BR-01, BR-09, POL-01, POL-05 |
| Create, rename, archive and unarchive campuses | BR-01, BR-06, BR-07 |
| Create people and update their names | BR-02, BR-08 |
| Link people to campuses; end links; set the primary link | BR-03 |
| Archive and unarchive people | BR-04, BR-05 |
| List and get people within a scope | BR-03 |
| Audit every change with a system actor | POL-01 to POL-04 |

## Invariants
All invariants are enforced by the database, except where noted. See [database design §3](../../database/CHMS-F001-database-design.md#3-database-enforced-invariants).
1. At most one church; its identity never changes (BR-01, BR-09).
2. No cross-church references (BR-01).
3. Campus names are unique per church under case-insensitive comparison, including archived names (BR-07).
4. No active affiliation references an archived campus or an archived person (BR-04, BR-06).
5. At most one active affiliation per person–campus pair, and at most one active primary per person (BR-03).
6. Ended affiliations are immutable, and no F001 row is deleted (BR-04).
7. Every person has a non-blank display name; structured components are optional (BR-08).
8. People never reference authentication accounts (BR-02).
9. Every committed change is audited with an allowlisted system actor, and audit is append-only (POL-01 to POL-04).
10. Stale updates are rejected. *Enforced by the service through `row_version`.*

## Data model and transactions
See the [database design proposal](../../database/CHMS-F001-database-design.md), and ADR-003 to ADR-008 (Proposed).

## API contract
There is no external API. The internal service operations are:
- `bootstrapChurch`, `renameChurch`
- `createCampus`, `renameCampus`, `archiveCampus`, `unarchiveCampus`
- `createPerson`, `updatePersonNames`, `archivePerson`, `unarchivePerson`
- `linkPersonToCampus`, `endAffiliation`, `setPrimaryAffiliation`
- `listPeople(scope, includeArchived)`, `getPerson(scope, id)`

Every write takes an actor category, and every update takes a `row_version`. The domain errors are listed in [database design §4](../../database/CHMS-F001-database-design.md#4-transaction-behavior).

## UI states and accessibility
Not applicable: F001 has no UI.

## Main and failure workflows
- **Bootstrap:** succeeds on an empty database, is a no-op when the church already exists with the same name, and fails when the name differs.
- **Archive person:** ends active links, then archives the person, in one transaction. If a link committed concurrently, everything rolls back and the service retries once.
- **Archive campus:** rejected while active links exist.
- **Missing actor or stale `row_version`:** the change fails and nothing is written.

## Security, privacy and audit
See the [security review](../../architecture/CHMS-F001-security-review.md). F001 stores names only, keeps no values in audit, and is not exposed. Actor attribution is application-asserted and unauthenticated.

## Acceptance criteria (Given / When / Then)
| ID | Source | Criterion |
|---|---|---|
| AC-F001-01 | BR-01, BR-09, POL-01 | **Given** an empty database, **when** an operator runs bootstrap as `chms_owner` with actor `bootstrap`, **then** exactly one church row exists, together with one audit event: `actor_kind` `system`, category `bootstrap`, action `create`. |
| AC-F001-02 | BR-01, BR-09 | **Given** a church exists, **when** bootstrap runs again with the same name, **then** nothing changes and no audit event is written. **When** it runs with a different name, **then** it fails and nothing changes. |
| AC-F001-03 | BR-01 | **Given** a church exists, **when** the owner role inserts a second church, **then** it is rejected (`23505`, `churches_singleton_uq`). **When** `chms_app` inserts any church, **then** it is rejected (`42501`). |
| AC-F001-04 | BR-09 | **Given** a church, **when** its `id` is updated, **then** the update is rejected for every role. **When** a maintenance operator renames it, **then** the name changes and one audit event records `changed_fields = {name}`. |
| AC-F001-05 | BR-09, TD-03 | **When** `id`, `church_id`, or an affiliation's `person_id` or `campus_id` is updated on any F001 table, **then** it is rejected: `42501` for `chms_app`; `CHI01` for the owner role. |
| AC-F001-06 | BR-07, TD-09 | **Given** a campus "North", active or archived, **when** another campus is created with, or renamed to, a name equal under the approved case-insensitive comparison (for example "north" or "NORTH"), **then** it is rejected (`23505`, `campuses_name_ci_uq`). Campus-name validation (trimming, NFC, 1–120 characters, preserved capitalization) and the expected results for non-ASCII names apply once PPD-01 (RR-16) is confirmed. |
| AC-F001-07 | BR-06 | **Given** a campus with at least one active affiliation, **when** it is archived, **then** the archive is rejected (`CampusHasActiveAffiliations`) and nothing changes. **After** all its affiliations have ended, archiving succeeds. |
| AC-F001-08 | BR-06, TD-04 | **Given** an archived campus, **when** an affiliation to it is created, through the service or by direct SQL as `chms_app`, **then** it is rejected (`23503`, `pca_campus_active_fk`). |
| AC-F001-09 | BR-06, TD-04 | **When** a campus archive and an affiliation insert for that campus interleave, in either order, at READ COMMITTED or REPEATABLE READ, **then** at most one succeeds; the other fails with `23503` or `40001`; and no active affiliation references an archived campus. |
| AC-F001-10 | BR-02, TD-02 | **When** a person is created with no account, **then** the row persists with a database-generated UUIDv4 `id`. `people` has no column referencing an account. An insert by `chms_app` that supplies `id` is rejected (`42501`). |
| AC-F001-11 | BR-08, TD-11 | **When** a person is created or updated with a missing, empty or whitespace-only display name, **then** it is rejected at the boundary and by the database (`23514`). Structured components may be absent (NULL); when present, they must not be blank. |
| AC-F001-12 | BR-03 | **Given** a person, **then**: zero affiliations is valid; active affiliations to several distinct campuses are valid; a second active affiliation to the same campus is rejected; a second active primary is rejected; and ended affiliations keep their `is_primary` value. |
| AC-F001-13 | BR-04 | **Given** a person with active affiliations, **when** the person is archived, **then**, in one transaction, every active affiliation is ended with reason `person_archived` (rows kept, `is_primary` kept) and the person is archived; all the resulting audit events share one `xact_id`. If any step fails, nothing changes. |
| AC-F001-14 | BR-04, TD-04 | **When** a person archive and an affiliation insert for that person interleave, in either order, **then** no active affiliation references an archived person. A failed archive leaves the original affiliations active, and one service retry succeeds. |
| AC-F001-15 | BR-05 | **Given** an archived person with ended affiliations, **when** the person is unarchived, **then** the person is active with no active affiliations, the historical affiliations are unchanged, and re-linking creates new affiliation rows. |
| AC-F001-16 | BR-04, TD-12 | **Given** an ended affiliation, **when** any of its columns is updated, **then** the update is rejected (`CHH01`). **When** `chms_app` deletes from any F001 table, **then** it is rejected (`42501`). |
| AC-F001-17 | CLAUDE.md (campus scope) | **Given** people linked to different campuses, a person with no link and an archived person, **when** people are listed with a campus scope, **then** only people actively linked to a campus in scope are returned. Unlinked people appear only under whole-church scope; archived people appear only when explicitly requested under whole-church scope. |
| AC-F001-18 | POL-01, TD-05 | **When** an insert or update on an F001 table commits, through the service or by direct SQL as `chms_app`, **then** exactly one audit event exists per changed row, with an action derived by the database and with field names but no values. **When** the transaction rolls back, **then** no audit event exists. |
| AC-F001-19 | POL-01, POL-02 | **When** a change runs without a declared actor, with an unknown category, or with a human actor kind, **then** it fails and nothing is written. **In** a production-profile database, only `bootstrap` and `maintenance` are accepted and test categories are rejected. **Then** an actor declared with `set_config(…, true)` in one transaction does not apply to the next transaction on the same connection, and no role-level or database-level `chms.*` default exists. A session-level `SET` is a known limitation (ADR-005). |
| AC-F001-20 | POL-03, POL-04 | **Then** `chms_app` cannot select, insert, update, delete or truncate audit events. `chms_audit_reader` can only select them, and its members are exactly the configured operator logins. Update, delete and truncate by the owner role are rejected (`CHA02`). No automatic deletion mechanism exists. |
| AC-F001-21 | TD-05 | **Then** the audit function is `SECURITY DEFINER`, owned by a `NOLOGIN` role, has `search_path = pg_catalog, pg_temp`, schema-qualifies every object, and is not executable by `PUBLIC`. `chms_app` cannot create temporary tables. |
| AC-F001-22 | TD-06 | **Then** every role's attributes and privileges match the approved matrix exactly. `chms_app` cannot change `session_replication_role`, alter tables, create or drop triggers, or truncate, and is a member of no predefined role. `PUBLIC` has no `CONNECT` or `TEMPORARY` privilege on the database. |
| AC-F001-23 | TD-07 | **Given** two updates carrying the same `row_version`, **then** exactly one succeeds, the other fails with `ConcurrentModification`, and exactly one audit event is written. |
| AC-F001-24 | TD-07, TD-08 | **When** a database error occurs inside a service transaction, **then** the caller receives a failure and nothing is committed, even if application code catches the error inside the transaction callback. |
| AC-F001-25 | CLAUDE.md (logging) | **Given** fixtures with synthetic marker names, **when** the full suite runs, **then** no marker value appears in captured logs or in audit events. |
| AC-F001-26 | TD-08 | **When** migrations run against an empty PostgreSQL 18 database, **then** they apply. A second run changes nothing. The schema, including custom objects, matches the reviewed definition. The application never runs migrations on startup. |
| AC-F001-27 | BR-09, POL-05 | **Given** a bootstrapped database with data, **when** it is dumped and restored into an empty database, **then** the church `id` is unchanged and bootstrap is a no-op. A `pg_restore --single-transaction` into an already bootstrapped database fails and loads nothing. No command or service can delete or replace the church. |
| AC-F001-28 | POL-06, TD-10 | **Then** the repository contains no HTTP route handler, page, server action or `"use server"` module, and F001 services are imported only by operator commands and tests. |

## Test plan (unit / integration / E2E / adversarial)
Levels: unit; integration on PostgreSQL 18; concurrency, using two connections with `pg_blocking_pids()` to make interleavings deterministic, plus invariant probes; security (privileges and adversarial direct SQL); migration; recovery; static checks. There is no end-to-end level, because F001 has no UI. Test cases and expected results are in the [test and acceptance matrix](test-matrix.md). Every case is **NOT RUN**.

## Dependencies
- **Approval** of ADR-003 to ADR-008 (Proposed), and review of ADR-001 and ADR-002 (Recorded baseline).
- **Confirmation** of PPD-01 (campus-name rules, RR-16); decisions on church-name and person-name rules (RR-16); awareness of RR-15, RR-17 and RR-18.
- **Compatibility proofs** CP-01 to CP-09 ([readiness report](implementation-readiness.md)).
- **Separate approval** to install the toolchain and run a test database.
- **Not required for F001, but required before F002:** RR-07, RR-13 and the D-01 role model.

## Open questions
Listed in [decision register §3 and §5](../../decisions/CHMS-F001-decision-register.md#5-deferred-decisions) and tracked as RR-15 to RR-18 in [open-questions.md](../../decisions/open-questions.md).

## Definition of done
1. **Approvals recorded:** ADR-003 to ADR-008 accepted by the product owner with named approvers and dates; ADR-001 and ADR-002 reviewed; PPD-01 confirmed and the remaining RR-16 questions answered.
2. **Compatibility proofs** CP-01 to CP-09 executed on PostgreSQL 18, with commands and results recorded.
3. **Test coverage:** every AC-F001 maps to at least one test that has been executed and passed, with nothing skipped. Negative, concurrency, leakage and privilege tests are included.
4. **CI:** lint, strict typecheck, the tests and `scripts/check_repo_hygiene.py` all pass, with exact commands and results in each PR.
5. **Migrations:** reviewed by a human, applied explicitly, non-destructive; no drift, including custom objects.
6. **Limits documented:** no HTTP exposure (TS-F001-37 passes); no RLS security claim; synthetic fixtures only.
7. **Records updated:** the traceability matrix, the deferred MVP list and the open questions.

## Verification evidence (actual commands/results)
None. No implementation exists and no F001 test has been executed. Documentation checks for this package are reported in the [readiness report](implementation-readiness.md).
