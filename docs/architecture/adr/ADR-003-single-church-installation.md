# ADR-003 — Single-church installation model and church identity
Status: Proposed
Date: 2026-10-27
Context: BR-01 (one church per installation, multiple campuses), BR-09 (church identity immutable; authorized renaming audited) and POL-05 (identity replacement requires an authorized rebuild) are approved business rules for [CHMS-F001](../../features/CHMS-F001/specification.md). [ADR-001](ADR-001-identifiers.md) (status: Recorded baseline, review pending) records UUIDv4 keys and same-church composite foreign keys "where appropriate"; `CLAUDE.md` requires same-church references to be enforced. The audit (finding R-06) noted that keeping `church_id` under a single church needs an explicit rationale.
Decision:
1. Keep `chms.churches` and limit it to one row with `singleton boolean NOT NULL DEFAULT true`, `CHECK (singleton)` (`churches_singleton_ck`) and `UNIQUE (singleton)` (`churches_singleton_uq`).
2. Every church-owned F001 table carries `church_id` referencing `churches(id)`. Same-church references use composite `(church_id, id)` keys, so a cross-church reference cannot be stored even if a second church ever exists.
3. The church is created only by an operator-run bootstrap command, connected as `chms_owner`, with system actor category `bootstrap`, in one transaction (church row plus audit event). `chms_app` has no `INSERT` privilege on `churches`. If a church already exists, bootstrap changes nothing: it exits successfully when the name matches and fails when it differs.
4. Identity is immutable. `id` on every F001 table, `church_id`, and an affiliation's `person_id` and `campus_id` are excluded from `chms_app` column `UPDATE` grants; a `BEFORE UPDATE` trigger (`chms.forbid_identity_change()`, SQLSTATE `CHI01`) rejects changes for every role, including the owner; all foreign keys are `ON UPDATE RESTRICT ON DELETE RESTRICT`.
5. Renaming changes only `name`, runs with system actor category `maintenance`, and is audited.
6. Recovery:
   - Wrong name: rename.
   - Failed bootstrap: the transaction is atomic, so rerun it.
   - Restore:
     1. Create the roles.
     2. Confirm the target database is empty.
     3. Run `pg_restore --single-transaction`, which implies `--exit-on-error`.
     4. Run bootstrap, which is a no-op that keeps the restored identity.

     Without `--single-transaction`, `pg_restore` "continue[s] and display[s] a count of errors at the end" ([pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html), checked 2026-10-27). A restore into an already bootstrapped database would then fail only for `churches`, while rows for other tables could still load. The singleton constraint is therefore **not** a sufficient guard on its own.
   - Replacing the church identity: no in-app path; only an authorized rebuild of an empty database (POL-05).
   - Deletion: no path (no `DELETE` privilege; `RESTRICT` foreign keys).
Alternatives:
- No `churches` table and no `church_id`: simpler, but drops the same-church foreign-key pattern of ADR-001 and any future multi-church path.
- A unique index on the constant expression `((true))`: equivalent enforcement, but not representable in the ORM schema and less visible to reviewers.
- A fixed, well-known church UUID: couples environments and restores together for no benefit.
Consequences:
- Child tables carry a `church_id` that is redundant while only one church exists; this is accepted as defense in depth.
- Bootstrap becomes a privileged operational step that needs explicit authorization (`CLAUDE.md`: privileged changes).
- The restore runbook must order role creation, restore and bootstrap correctly.
- Supporting more than one church later requires a new ADR and a migration that drops the singleton constraint.
Security impact: no runtime code path can create, delete or replace the church. Changing an identity requires a reviewed migration that drops the immutability trigger.

Security assumptions:
- "Authorized renaming" (BR-09) depends on operators controlling access to the maintenance command and the `chms_app` credentials. Until IAM exists (CHMS-F002), the database cannot tell an authorized operator from any other holder of those credentials. The audit records the declared category only.
- Bootstrap and restore are privileged operations performed by trusted operators.
Verification (not executed): TS-F001-01 to TS-F001-05 and TS-F001-36 in the [test matrix](../../features/CHMS-F001/test-matrix.md). Execution status: NOT RUN.
Approvers: none yet. Requires product-owner approval of this exact content before implementation.
