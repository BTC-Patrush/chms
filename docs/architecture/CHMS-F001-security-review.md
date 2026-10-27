# CHMS-F001 — Security review

**Status: DESK REVIEW of a proposed design, dated 2026-10-27. Nothing has been implemented or executed. This review is advisory and is not independent security assurance (`CLAUDE.md`).**

Scope: [CHMS-F001 specification](../features/CHMS-F001/specification.md), [database design](../database/CHMS-F001-database-design.md), and ADR-003 to ADR-008 (all Proposed).

## 1. Threat assumptions

| Assumption | Basis |
|---|---|
| F001 has no network-exposed application surface: no HTTP routes, pages, server actions or UI | TD-10; enforced by TS-F001-37 |
| Superusers and `chms_owner` operators are trusted. They can change any object, so the controls below protect against the application, not against them | ADR-006 |
| The application code base is trusted to *declare* the actor category but **not** to keep the data model's invariants. Direct SQL as `chms_app` (a bug, a compromised dependency, or injection in a later feature) is treated as hostile for integrity | ADR-004, ADR-005 |
| Actor attribution is application-asserted and unauthenticated; there are no human actors in F001 | ADR-005, CLAUDE.md |
| Test clusters and production clusters are separate; test roles and test actor categories never exist in production | POL-02 |
| Backups contain personal data and audit metadata; protecting backups is out of F001 scope | RR-06 |

## 2. Trust boundaries

| Boundary | Crossing | Control |
|---|---|---|
| Operator → database (privileged) | Migrations, role creation, bootstrap, restore as `chms_owner` | Explicit human authorization; reviewed migrations |
| Application process → database | Service and maintenance commands as `chms_app` | Column grants, constraints, triggers, no `DELETE`/`TRUNCATE`/`TEMPORARY` |
| `chms_app` → audit trail | Row triggers run `chms.audit_row_change()` as `chms_audit_writer` | `SECURITY DEFINER` hardening; `chms_app` has no audit privileges |
| Audit trail → readers | `SELECT` by operators | `chms_audit_reader` membership limited to authorized operators (POL-03) |
| Test environment → production | Fixtures, actor categories, roles | Test categories are seeded only by test setup (POL-02) |
| Backup and restore | Dump files, restore into a new cluster | Restore ordering (ADR-003); triggers are created post-data |

## 3. Privileged function risks: `chms.audit_row_change()`

| Risk | Mitigation | Test |
|---|---|---|
| Hijacking of objects through `search_path`; **revision 2 omitted `pg_temp`**, and PostgreSQL searches `pg_temp` first for relations when it isn't listed | `SET search_path = pg_catalog, pg_temp`; every object schema-qualified; `TEMPORARY` revoked from `PUBLIC` | TS-F001-30 |
| Calling the function directly to forge events | `EXECUTE` revoked from `PUBLIC`. PostgreSQL is also *expected* to reject direct calls to a trigger function; not verified against documentation in this review | TS-F001-30 |
| Over-privileged definer | Owner `chms_audit_writer` is `NOLOGIN` with only `INSERT` on `audit_events` | TS-F001-30, TS-F001-31 |
| Injection through dynamic SQL | No dynamic SQL; field names come from `to_jsonb` keys | Code review |
| Values leaking into audit | Only names are stored; marker scan | TS-F001-26, TS-F001-34 |

## 4. Risks of direct SQL as `chms_app`

| Attempt | Outcome by design | Test |
|---|---|---|
| Insert a second church; insert a row with a chosen `id` | Denied (`42501`) | TS-F001-03, TS-F001-13 |
| Change `id` or `church_id`, or re-point an affiliation | Denied (`42501`); the trigger blocks the owner too | TS-F001-04, TS-F001-05 |
| Link to an archived campus or person; archive a campus that has active links | Foreign-key violation (`23503`), including under concurrency (theoretical) | TS-F001-09 to TS-F001-12, TS-F001-20, TS-F001-21 |
| Reopen or edit an ended affiliation; delete any row | Denied (`CHH01` / `42501`) | TS-F001-23 |
| Skip audit by disabling triggers, using `session_replication_role`, or dropping or creating triggers | Denied: requires ownership, superuser or an explicit SET grant, or the `TRIGGER` privilege | TS-F001-31 |
| Write, read, update or delete audit events | Denied (`42501`); the owner is also blocked from changing or deleting them (`CHA02`) | TS-F001-29 |
| Declare an actor | **Possible for any allowlisted category.** Attribution between `bootstrap` and `maintenance` can be spoofed (residual) | TS-F001-27 (only verifies the allowlist) |
| Read every person, campus and affiliation | **Possible**: there is no RLS, and campus scope is enforced only in services (residual; this is why TD-10 forbids exposure) | TS-F001-24, TS-F001-25 cover the service layer only |
| Take strong table locks | *Expected to be denied.* `LOCK TABLE` grants strong modes only for table-level `MAINTAIN`, `UPDATE`, `DELETE` or `TRUNCATE`, and `chms_app` holds only column-level grants (unverified) | TS-F001-31 |
| Hold row locks for a long time | **Possible** through `UPDATE` or `SELECT … FOR UPDATE`; can block archive and update operations (residual) | — |
| Set a session-level or role-level actor (`SET`, `ALTER ROLE chms_app SET …`) | **Possible**: ordinary roles may set their own defaults. This defeats the fail-closed actor check (residual; detected by checking `pg_db_role_setting`) | TS-F001-28 |

## 5. Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| SR-01 | High (design) | Revision 2's `search_path` omitted `pg_temp`, allowing temporary-table shadowing | Corrected in ADR-005 (Proposed); proof TS-F001-30 |
| SR-02 | Medium | PostgreSQL grants `CONNECT` and `TEMPORARY` on databases and `EXECUTE` on functions to `PUBLIC` by default | Revocations in ADR-006 (Proposed) |
| SR-03 | Medium (unverified) | drizzle-orm #6572 *reports* that a rolled-back transaction can be reported as successful when an error is caught inside the callback. Not reproduced by us; the proposed pattern does not meet the trigger condition | No catch-and-continue rule (ADR-004); CP-05 reproduces or rules it out; TS-F001-33 |
| SR-04 | Medium (residual) | Actor attribution is application-asserted | Accepted for F001 only; F002 needs RR-07 |
| SR-05 | Medium (residual) | No RLS; `chms_app` can read everything | TD-10 forbids exposure until F002 conditions are met |
| SR-06 | Low (residual) | Denial of service through long-held row locks by `chms_app`. Strong table locks are expected to be unavailable with column-level grants (unverified) | Accepted; TS-F001-31; revisit with F002 |
| SR-07 | Low | The audit trail grows without bound | RR-17 |
| SR-08 | Low | Getting the PostgreSQL 18 image volume path wrong (`/var/lib/postgresql`) can lose test data when a container is recreated | ADR-007; CP-09 |
| SR-09 | Info | All concurrency guarantees are theoretical until the proof tests run on PostgreSQL 18 | Readiness report |
| SR-10 | Medium (residual) | The fail-closed actor check cannot tell a transaction-local declaration from a session-level `SET` or a role-level default that `chms_app` can set itself | Documented in ADR-005; services use `set_config(…, true)`; `pg_db_role_setting` check (TS-F001-28) |
| SR-11 | Medium | By default `pg_restore` continues after errors, so restoring into a non-empty database can partly load data despite the singleton constraint | ADR-003: verified-empty target and `--single-transaction`; TS-F001-36 |

## 6. Mapping to the threat model

Mapping to the [threat model](threat-model.md), for the threats relevant to F001:

| Threat | Actor | Boundary | Exploit | Mitigation | Negative test | Residual risk |
|---|---|---|---|---|---|---|
| Spoofed database identity via an untrusted setting | Application code | App → database | Declare a false actor | Allowlist; system actors only; not used for authorization | TS-F001-27 | Spoofing between system categories |
| Cross-campus data exposure | Future web user | (none in F001) | Read outside scope | No exposure; service-level scope with leakage tests | TS-F001-24, TS-F001-25, TS-F001-37 | No database-level scope until RR-07 |
| Secrets in logs | Developer or operator | Logs | Personal data in logs or audit | Names-only audit; marker scan | TS-F001-34 | Logging outside the test suite |
| Restore replay | Operator | Backup and restore | Duplicate identity, or a partial restore into a non-empty database | Verified-empty target; `pg_restore --single-transaction`; singleton | TS-F001-36 | Runbook discipline |

Each row still needs a named reviewer. The global threat model is unchanged.

## 7. Conditions required before F002 exposure

1. ADR-003 to ADR-008 accepted with named approvers; ADR-001 and ADR-002 reviewed.
2. Every F001 proof-of-concept and compatibility test executed on PostgreSQL 18, with recorded commands and results.
3. An approved IAM role model and campus-scope grants (D-01; audit R-05).
4. An approved Better Auth integration (RR-13; audit R-26).
5. A trusted database actor and RLS decision with adversarial proof (RR-07).
6. Audit widened to human actors bound to authenticated sessions, with a foreign key to accounts.
7. Campus scope enforced on the server side for every endpoint, with leakage tests.
8. Threat-model fields completed for every exposed threat, with a named reviewer.
9. A reverse proxy and TLS decision (audit R-24) and a decision, or explicit acceptance, on audit retention (RR-17).
10. TD-10 lifted explicitly by the approved F002 specification. Until then, TS-F001-37 must keep passing.
