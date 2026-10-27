# ADR-004 — Archive invariants through status-carrying foreign keys, and transaction semantics
Status: Proposed
Date: 2026-10-27
Context: BR-03, BR-04, BR-05 and BR-06 are approved business rules for [CHMS-F001](../../features/CHMS-F001/specification.md). Revision 1 enforced "campus archival is blocked while active affiliations exist" in the service by checking, then updating `archived_at`. The PostgreSQL documentation ([explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html), checked 2026-10-27) states that an `UPDATE` that does not modify a column of a unique index usable by a foreign key takes `FOR NO KEY UPDATE`, and that this lock "will not block `SELECT FOR KEY SHARE`", which is the lock a foreign-key check takes when a referencing row is inserted. A campus could therefore be archived while a concurrent transaction inserts an active affiliation to it, and both could commit. The same race applies to person archival.
Decision:
1. `chms.campuses` and `chms.people` get `status text NOT NULL DEFAULT 'active'` (`'active'` or `'archived'`), a CHECK that `status = 'archived'` exactly when `archived_at IS NOT NULL`, and `UNIQUE (church_id, id, status)`.
2. `chms.person_campus_affiliations` carries `person_status` and `campus_status`: `'active'` while the affiliation is active and `NULL` once it has ended. Two foreign keys, `pca_person_active_fk (church_id, person_id, person_status) → people (church_id, id, status)` and `pca_campus_active_fk (church_id, campus_id, campus_status) → campuses (church_id, id, status)`, use the default `MATCH SIMPLE` (so ended rows, whose status columns are NULL, are not checked), `ON UPDATE RESTRICT` and `ON DELETE RESTRICT`. The existence foreign keys `(church_id, person_id)` and `(church_id, campus_id)` remain and are always enforced.
3. Partial unique indexes: `pca_active_pair_uq (person_id, campus_id) WHERE ended_at IS NULL` and `pca_active_primary_uq (person_id) WHERE is_primary AND ended_at IS NULL`. Ended rows keep `is_primary` as history.
4. Person archive runs in one transaction:
   1. End every active affiliation (`ended_at`, `end_reason = 'person_archived'`, status columns NULL).
   2. Archive the person, using the `row_version` check.

   If step 2 fails with `23503` on `pca_person_active_fk` (an affiliation committed in between), the whole transaction rolls back and the service retries once (BR-04).
5. Campus archive is a single `UPDATE`. A `23503` error on `pca_campus_active_fk` maps to `CampusHasActiveAffiliations` (BR-06).
6. Unarchiving a person or campus never restores affiliations (BR-05). Re-linking creates new rows.
7. Ended affiliations are immutable: `chms.forbid_history_change()` raises SQLSTATE `CHH01` on any `UPDATE` of a row whose `ended_at` was already set.
8. Transaction semantics:
   - Service transactions run at READ COMMITTED.
   - Every `UPDATE` carries an optimistic `row_version` check; zero affected rows maps to `ConcurrentModification`.
   - Errors map to domain errors by SQLSTATE plus constraint name, **outside** the transaction callback. Code inside a transaction callback must never catch a database error and continue.
   - Retries always start a **new** transaction outside the failed callback. That covers up to three retries for `40001` and `40P01`, and the single person-archive retry above. No other error is retried.
   - **Unverified implementation risk.** [drizzle-orm #6572](https://github.com/drizzle-team/drizzle-orm/issues/6572) was open with no maintainer response as of 2026-10-27. It reports that, on drizzle-orm 0.45.4 with `pg` 8.23.1 and PostgreSQL 18.6, if a statement error is caught **inside** the `db.transaction()` callback and the callback returns, PostgreSQL answers `COMMIT` with `ROLLBACK` but `db.transaction()` still resolves as successful. We have not reproduced it.
     - The pattern above never catches inside the callback, so it does not meet the reported trigger condition.
     - The risk applies only if that rule is broken: for example, a helper that swallows `23505` to detect duplicates, or a retry implemented inside the callback.
     - Whether Drizzle's nested `tx.transaction()` savepoints behave safely when their errors are caught is also unverified.
     - Proof CP-05 must reproduce the issue or rule it out, and TS-F001-33 guards against regressions.
Theoretical basis (from documentation, not executed): changing `status` modifies a column of a unique index usable by a foreign key, so the `UPDATE` takes `FOR UPDATE`, which conflicts with the `FOR KEY SHARE` taken by the foreign-key check of a concurrent insert. The two transactions serialize; at READ COMMITTED the loser should fail with `23503`, and at REPEATABLE READ or SERIALIZABLE it may fail with `40001` instead. The exact SQLSTATEs on PostgreSQL 18 must be confirmed by the proof-of-concept tests below.
Alternatives:
- An explicit `SELECT … FOR SHARE` / `FOR UPDATE` protocol in every service: correct, but direct SQL can bypass it.
- SERIALIZABLE for every transaction: correct, but every operation then needs retry handling.
- Triggers that take row locks and re-check state: correct, but more custom code to review.
- Generated status columns: PostgreSQL 18 makes generated columns virtual by default, and foreign-key behaviour with generated columns would need separate verification. Not chosen.
Consequences:
- The status columns are denormalized, kept correct by the foreign keys themselves.
- Two extra unique constraints are added.
- Archiving a person or campus takes a stronger row lock and waits for, or blocks, concurrent inserts that reference that row, which is intended.
- Every future table that references people or campuses must decide whether it also carries status.
Security impact: the invariants hold for direct SQL by `chms_app`, not only for service code.
Verification (not executed): TS-F001-08 to TS-F001-12, TS-F001-16 to TS-F001-23, TS-F001-32 and TS-F001-38 in the [test matrix](../../features/CHMS-F001/test-matrix.md). Execution status: NOT RUN.
Approvers: none yet. Requires product-owner approval of this exact content before implementation.
