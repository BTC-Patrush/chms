# ADR-005 — Foundation audit trail and system-actor attribution
Status: Proposed
Date: 2026-10-27
Context:
- [migration-strategy.md](../../database/migration-strategy.md) says audit must be established with each module, not postponed to M09, but [DB-08](../../database/DB-08.md) lists `audit_events` under reporting/administration (M08), and [DB-02](../../database/DB-02.md) lists separate "security events". This conflict is recorded as RR-15 in [open-questions.md](../../decisions/open-questions.md).
- Approved policies POL-01 to POL-04 cover system actor categories, isolation of test actors, authorized audit readers and the absence of any retention policy.
- `CLAUDE.md` forbids sensitive member data in logs and forbids treating an application-set setting as a trusted identity.
Decision:
1. `chms.audit_events` is created in M00 (foundation) and owned by `chms_owner`. Approving this ADR resolves RR-15 for F001 tables only; DB-08 and DB-02 stay unchanged until a broader decision is made.
2. Audit events are written only by `AFTER INSERT OR UPDATE` row triggers on the F001 tables, which call `chms.audit_row_change()`. That function:
   - is `SECURITY DEFINER`, owned by `chms_audit_writer` (`NOLOGIN`, with only `INSERT` on `chms.audit_events` and `USAGE` on schema `chms`);
   - declares `SET search_path = pg_catalog, pg_temp` and schema-qualifies every object it references;
   - uses no dynamic SQL;
   - has `EXECUTE` revoked from `PUBLIC` and granted only to `chms_owner`, which creates the triggers.
3. Actor attribution:
   - Each writing transaction calls `set_config('chms.actor_category', <category>, true)`. The final `true` makes the setting transaction-local, so it does not survive on a pooled connection.
   - The trigger fails closed (SQLSTATE `CHA01`) when no category is declared.
   - **Limit of the fail-closed check.** `current_setting()` cannot tell a transaction-local value from two other sources. First, a session-level `SET`, which persists across transactions on a pooled connection. Second, a role-level default: PostgreSQL 18 allows "ordinary roles [to] set defaults for themselves" ([ALTER ROLE](https://www.postgresql.org/docs/18/sql-alterrole.html), checked 2026-10-27), so `chms_app` could run `ALTER ROLE chms_app SET chms.actor_category = …`. Either would make the check pass without a declaration in that transaction. The check is therefore a guard against coding mistakes, not a security control. Mitigations: services use only `set_config(…, true)`; and an operator check plus TS-F001-28 assert that `pg_db_role_setting` holds no `chms.*` defaults.
   - `actor_category` references `chms.system_actor_categories`. Production migrations insert only `bootstrap` and `maintenance` (POL-01). Test categories are inserted only by test-environment setup scripts that are never part of the migration chain (POL-02).
   - `actor_kind` is constrained to `'system'` and `actor_user_id` to `NULL`. Recording human actors needs a later migration (CHMS-F002) that adds a foreign key to authenticated accounts.
4. Content of each event: `xact_id xid8 DEFAULT pg_current_xact_id()`, `occurred_at DEFAULT clock_timestamp()`, `action` (derived by the trigger: `create`, `update`, `archive`, `unarchive`, `end_affiliation`), `entity_type`, `entity_id`, and `changed_fields text[]` holding column names only (excluding `row_version` and `updated_at`). No column values are stored.
5. Audit is append-only for every role, including the owner: a `BEFORE UPDATE OR DELETE` row trigger and a `BEFORE TRUNCATE` statement trigger raise SQLSTATE `CHA02`. No deletion or retention mechanism exists (POL-04; RR-17).
6. Read access: `chms_audit_reader` (`NOLOGIN`, `SELECT` only) is granted only to explicitly authorized operator login roles (POL-03). `chms_app` has no privileges on audit tables.
Trust statement: actor attribution is asserted by application and operator tooling and is **not authenticated**. It must not be used for authorization. Attributing actions to humans requires CHMS-F002 and the trusted-actor decision (RR-07).
Revision note: CHMS-F001 revision 2 proposed `SET search_path = pg_catalog, chms`. PostgreSQL 18 documentation ([runtime-config-client](https://www.postgresql.org/docs/18/runtime-config-client.html), checked 2026-10-27) states that when `pg_temp` is not listed it "is searched first (even before `pg_catalog`)" for relations, so a role able to create temporary tables could shadow an unqualified table name. The [SECURITY DEFINER guidance](https://www.postgresql.org/docs/18/sql-createfunction.html) prescribes trusted schemas followed by `pg_temp` last. This ADR corrects the setting and also revokes `TEMPORARY` from `PUBLIC` (ADR-006).
Alternatives:
- Audit written by the services: can be forgotten, or bypassed by direct SQL.
- Logical decoding or change-data capture: operational complexity, and no actor information.
- The `pgaudit` extension: records statements rather than domain events, and its logs can contain values, which conflicts with the logging rule in `CLAUDE.md`.
- Storing before and after values: deferred, because of privacy risk.
Consequences:
- Every F001 write performs one extra insert.
- The audit table grows without limit until retention is decided (RR-17).
- `pg_dump` creates triggers in its post-data section, so rows loaded during a restore are not re-audited. This is expected and must be stated in the restore runbook.
- The owner role can still drop triggers through a migration; that is controlled by review and CODEOWNERS.
Security impact: `chms_app` cannot write, alter, read or bypass audit events, because:
- disabling triggers requires table ownership ([ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html));
- setting `session_replication_role` requires superuser or an explicit SET grant ([client configuration](https://www.postgresql.org/docs/current/runtime-config-client.html));
- creating triggers requires the `TRIGGER` privilege ([CREATE TRIGGER](https://www.postgresql.org/docs/current/sql-createtrigger.html)).

All three were checked 2026-10-27; behaviour on PostgreSQL 18 is to be confirmed by TS-F001-31.

Residual risks:
- Application code can declare any allowlisted category, for example `maintenance`, so attribution between system categories can be spoofed.
- A role-level or session-level actor setting defeats the fail-closed check (see Decision 3).

Security assumptions:
- The owner and superusers are trusted.
- Test categories never reach a production database (POL-02); this is enforced by process, because the migration chain omits them.
- Restores load data before triggers exist (`pg_dump` puts triggers in post-data; [pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html), checked 2026-10-27).
Verification (not executed): TS-F001-26 to TS-F001-31 in the [test matrix](../../features/CHMS-F001/test-matrix.md). Execution status: NOT RUN.
Approvers: none yet. Requires product-owner approval of this exact content before implementation.
