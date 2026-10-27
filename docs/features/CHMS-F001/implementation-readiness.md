# CHMS-F001 — Implementation readiness report
Date: 2026-10-27
Verdict: **NO-GO for implementation.** The documentation package is ready for product-owner review.

## 1. Approved decisions
- BR-01 to BR-10 and POL-01 to POL-06, approved by the product owner on 2026-10-27 ([decision register §1–2](../../decisions/CHMS-F001-decision-register.md#1-approved-business-rules)).
- These approvals cover business rules and policies only. No technical mechanism is approved.

## 2. Unapproved technical ADRs
| ADR | Status | Blocks |
|---|---|---|
| [ADR-001](../../architecture/adr/ADR-001-identifiers.md) Identifiers | Recorded baseline (review pending). No approval record in history: added in `778ce37` on 2026-10-26, content unchanged since | TD-02 |
| [ADR-002](../../architecture/adr/ADR-002-retention.md) Archive and deletion | Recorded baseline (review pending). No approval record in history: added in `778ce37` on 2026-10-26, content unchanged since | TD-12 |
| [ADR-003](../../architecture/adr/ADR-003-single-church-installation.md) Single-church installation | Proposed | TD-01, TD-03 |
| [ADR-004](../../architecture/adr/ADR-004-archive-invariants-and-transactions.md) Archive invariants and transactions | Proposed | TD-04, TD-07 |
| [ADR-005](../../architecture/adr/ADR-005-foundation-audit-trail.md) Foundation audit trail | Proposed | TD-05 |
| [ADR-006](../../architecture/adr/ADR-006-database-roles-least-privilege.md) Database roles | Proposed | TD-06 |
| [ADR-007](../../architecture/adr/ADR-007-f001-platform-baseline.md) Platform baseline | Proposed | TD-08 |
| [ADR-008](../../architecture/adr/ADR-008-name-comparison-and-normalization.md) Name comparison | Proposed (depends on RR-16) | TD-09 |

## 3. Required compatibility checks (none executed)
Each check runs on a disposable PostgreSQL 18 instance and needs separate approval.

| ID | Check | Pass criterion |
|---|---|---|
| CP-01 | The `postgres:18-trixie` image, pinned by digest, starts and keeps its data across container recreation | `SELECT version()` reports 18.x; `UTF8` encoding; builtin locale provider; data mounted at `/var/lib/postgresql` |
| CP-02 | Required functions | `gen_random_uuid()` returns version-4 UUIDs; `pg_current_xact_id()` returns `xid8`; `casefold()` is available |
| CP-03 | `drizzle-kit generate` (0.31.x, at least 0.31.7) for the F001 schema | SQL matches the design: composite foreign keys with `RESTRICT` actions, partial and expression unique indexes, named `CHECK`s including `IS NFC NORMALIZED`, and custom SQL migrations ordered correctly |
| CP-04 | `drizzle-kit migrate` and `check` on PostgreSQL 18 | Applies; no spurious diff (NOT NULL constraints in `pg_constraint`); `push` is not used |
| CP-05 | `pg` 8.x driver and Drizzle transactions | Connects; `set_config(…, true)` is transaction-local; the *reported, unverified* drizzle-orm #6572 is either reproduced, with a mitigation proven, or ruled out (TS-F001-33); nested `tx.transaction()` savepoint behaviour recorded |
| CP-06 | Row-lock behaviour | TS-F001-10 to TS-F001-12, TS-F001-20 and TS-F001-21 return the predicted SQLSTATEs |
| CP-07 | Restore ordering | TS-F001-36 passes with PostgreSQL 18 `pg_dump` / `pg_restore` |
| CP-08 | Collation, `casefold()` and whitespace | Behaviour of `PG_UNICODE_FAST` vs `C.UTF-8` recorded for the TS-F001-07 strings; `casefold()` usable in a unique index expression; NFC checks work; a whitespace pattern check that rejects leading and trailing tab and no-break space (`btrim()` removes only spaces) |
| CP-09 | Privileges | TS-F001-29 to TS-F001-31 pass, including the `LOCK TABLE` modes available to column-level grantees; a control run with `TEMPORARY` granted shows that the `search_path` setting alone prevents shadowing; `pg_db_role_setting` check (TS-F001-28) |

## 4. Required proof-of-concept tests
These run before ADR acceptance: TS-F001-10, 11, 12, 17, 20, 21 (locking); TS-F001-30, 31 (privileged function and privileges); TS-F001-33 (transaction false success); TS-F001-36 (restore); TS-F001-38 (stress). Every one is NOT RUN; see the [test matrix](test-matrix.md).

## 5. Blockers
| ID | Priority | Blocker | Needed to clear it |
|---|---|---|---|
| B-01 | P0 | ADR-003 to ADR-008 not approved | Product-owner approval of exact contents |
| B-02 | P0 | ADR-001 and ADR-002 still "Recorded baseline"; F001 depends on them unchanged | Review and decision |
| B-03 | P0 | RR-16: campus-name rules are proposed as PPD-01 and awaiting confirmation; church-name and person-name rules are open | Product-owner confirmation of PPD-01 and decisions on the remaining name rules |
| B-04 | P0 | Installing the toolchain and running a test database are not approved | Separate approval |
| B-05 | P1 | CP-01 to CP-09 not executed; every concurrency and privilege claim is theoretical | Execute and record results |
| B-06 | P1 | drizzle-orm #6572: reported, unverified, and relevant only if code catches inside a transaction callback | CP-05 reproduces it, with a mitigation proven, or rules it out; or an upstream fix |
| B-07 | P1 | RR-15: audit ownership conflicts with DB-08 and DB-02 beyond F001 | ADR-005 approval (F001 only); broader decision later |
| B-08 | P1 | Business-rule approval recorded as "product owner" with no name | Named approver at PR review |
| B-09 | P1 | No runbook for role creation, bootstrap and restore (privileged steps) | Operations runbook, separately approved |
| B-10 | P2 | RR-17: audit retention; unbounded growth | Decision before production |
| B-11 | P2 | RR-18: repository-wide requirement-ID scheme | Decision |
| B-12 | P2 | Residual risks SR-04 to SR-06 accepted for F001 only | Revisit before F002 |
| B-13 | P2 | Threat-model rows lack named reviewers | Assign reviewers |

## 6. Go / no-go
- **Implementation: NO-GO** until B-01 to B-04 are cleared.
- **Documentation package: GO for review.** It can be merged as documentation once reviewed. Merging it does not approve any ADR.
- **Order after approval:** toolchain PR → compatibility proofs CP-01 to CP-09 on a disposable PostgreSQL 18 instance → M00 (roles, audit) → M01a (tables) → services → full test suite.

## 7. Documentation checks for this package
Run on 2026-10-27, before commit. These are documentation checks only; no product test was run.

| Check | Command or method | Result |
|---|---|---|
| Repository hygiene | `python3 scripts/check_repo_hygiene.py` | `OK: repository hygiene checks passed (6 groups)`, exit 0. Covers tracked files only |
| Modes of new files | `find` on new and modified files for group/world-writable or executable bits | 0 found |
| Internal links and anchors | Ad-hoc script over `docs/**/*.md`, `CLAUDE.md` and `README.md` (no link-check tooling exists in the repository) | 136 internal links checked; 0 broken (rerun after the final corrections) |
| Identifier sets | Same script: AC (28), TS (38), TD (12), POL (6), BR (10), PPD (1), RR (18), CP (9) and SR (11) | All complete; no duplicates; no undefined references |
| Domain visibility | Same script on the traceability matrix | All 16 domains listed individually (D-01 to D-16); no catch-all row |
| Corrected claims | Same script: old name limits, `btrim()` used as a check, singleton as the restore guard, unconditional table-lock claim, unhedged drizzle-orm #6572 claim | None remain |
| Acceptance-criterion coverage | Same script | Every AC has at least one test case. BR-10 has no AC by design (covered by CP-01 to CP-09) |
| Technical decisions marked approved | Same script: ADR `Status:` lines and TD/ADR rows | ADR-003 to ADR-008 are `Proposed`; ADR-001 and ADR-002 unchanged; no TD row marked approved |
| Single source of business-rule text | Same script | Each of the 9 verbatim domain rules appears exactly once (in D-02 or D-03); BR-10 and POL text appear only in the decision register |
| Leftover contradictions | Same script: `search_path` without `pg_temp`, a required `given_name`, `lower(name)` | None outside the documented revision notes |
| Preservation | `git diff` | All 16 domain files present; only D-02 and D-03 changed, and both keep every original section; no existing ADR changed |
