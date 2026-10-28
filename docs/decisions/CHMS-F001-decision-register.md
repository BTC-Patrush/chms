# CHMS-F001 decision register

Feature: [CHMS-F001 — Church, Campus and Person Foundation](../features/CHMS-F001/specification.md)
Last updated: 2026-10-28
Product owner: Patrush

Status values:
- **APPROVED**: a business rule, policy or product decision approved by the product owner.
- **ACCEPTED**: a technical decision accepted by the product owner through its ADR.
- **CLOSED**: decided for F001.
- **DEFERRED**: deliberately left for later. **NONBLOCKING** means it does not block F001.

On 2026-10-27 the product owner, Patrush, approved the business rules, policies and name rules below, accepted ADR-001 to ADR-008 with the amendments recorded in §4, and authorized implementation (§6). Implementation starts only after the documentation PR is merged and its required CI checks pass. No compatibility, concurrency or product test has been executed yet.

## 1. Approved business rules

Approved by the product owner, Patrush, on 2026-10-27. The authoritative wording of BR-01 to BR-09 is in the domain requirement files; this table summarizes them only, so there is a single source of truth.

| ID | Summary | Authoritative text | Status |
|---|---|---|---|
| BR-01 | One church per installation, multiple campuses | [D-02 §Approved business rules](../requirements/domains/D-02-church.md#approved-business-rules-chms-f001) | APPROVED |
| BR-02 | People records are independent of authentication accounts | [D-03 §Approved business rules](../requirements/domains/D-03-people.md#approved-business-rules-chms-f001) | APPROVED |
| BR-03 | Zero or more active campus affiliations; at most one active primary | [D-03](../requirements/domains/D-03-people.md#approved-business-rules-chms-f001) | APPROVED |
| BR-04 | Archiving a person atomically ends active affiliations and preserves history | [D-03](../requirements/domains/D-03-people.md#approved-business-rules-chms-f001) | APPROVED |
| BR-05 | Unarchiving a person does not restore affiliations | [D-03](../requirements/domains/D-03-people.md#approved-business-rules-chms-f001) | APPROVED |
| BR-06 | Campus archival is blocked while active affiliations exist | [D-02](../requirements/domains/D-02-church.md#approved-business-rules-chms-f001) | APPROVED |
| BR-07 | Campus names unique per church, case-insensitive; archived names stay reserved | [D-02](../requirements/domains/D-02-church.md#approved-business-rules-chms-f001) | APPROVED |
| BR-08 | Display name required; structured name components optional | [D-03](../requirements/domains/D-03-people.md#approved-business-rules-chms-f001) | APPROVED |
| BR-09 | Church identity immutable; authorized renaming permitted and audited | [D-02](../requirements/domains/D-02-church.md#approved-business-rules-chms-f001) | APPROVED |
| BR-10 | PostgreSQL 18 is the target major version, subject to implementation compatibility verification | This register (a platform constraint, not a domain requirement) | APPROVED |

## 2. Approved policy decisions

Approved by the product owner, Patrush, on 2026-10-27. The authoritative text is here.

| ID | Policy | Status |
|---|---|---|
| POL-01 | Production system actor categories: bootstrap and maintenance. | APPROVED |
| POL-02 | Test-only actor identities must remain isolated from production. | APPROVED |
| POL-03 | Audit readers are explicitly authorized operators. | APPROVED |
| POL-04 | Audit retention remains unresolved; no automatic deletion policy is approved. | APPROVED (tracked as RR-17) |
| POL-05 | Church identity replacement requires an authorized rebuild. | APPROVED |
| POL-06 | F002 is planned as an authenticated, campus-scoped people directory. | APPROVED (planning only; F002 is not specified) |

## 3. Approved name rules (closes RR-16 for F001)

Approved by the product owner, Patrush, on 2026-10-27.

| ID | Decision | Scope | Status | Tracking |
|---|---|---|---|---|
| PPD-01 | Trim leading and trailing whitespace. Reject empty names, control characters and invalid Unicode. Normalize to NFC before storage. Do not collapse internal whitespace. Length is 1–100 characters after trimming. Use case-insensitive uniqueness where already required. Prefer PostgreSQL 18 `casefold()` only if compatibility testing proves it `IMMUTABLE` and suitable for the required unique index; otherwise use `lower()`. The `casefold()`/`lower()` choice is delegated to compatibility testing (CP-08) and needs no further product-owner approval. | All F001 names: church name, campus name, person `display_name`, and `given_name` and `family_name` when present. Case-insensitive uniqueness applies only to campus names within a church, including archived records (BR-07). No new field, entity or uniqueness requirement. | APPROVED; RR-16 CLOSED for F001 | RR-16, TD-09, [ADR-008](../architecture/adr/ADR-008-name-comparison-and-normalization.md) |

Technical reading, accepted with ADR-008: "characters" are Unicode code points after NFC; "whitespace" is the Unicode `White_Space` property; "control characters" are general category `Cc`; display capitalization is preserved as entered.

History: PPD-01 was proposed in review on 2026-10-27 for campus names only, with a length of 1–120 characters, leaving church-name and person-name rules open. The approved rules above replace that proposal.

### Approved service behaviour (closes RR-19)

Approved by the product owner, Patrush, on 2026-10-28. The question was raised at the F001 service checkpoint, because the approved documents did not fix these behaviours.

| ID | Decision | Scope | Status | Tracking |
|---|---|---|---|---|
| PPD-02 | (a) Renaming an archived campus is refused; unarchive it first, so archived campus names stay reserved (BR-07). (b) Archived people are returned only when "include archived" is explicitly requested under whole-church scope, for lists and lookups by id alike; campus scopes never return archived people. (c) An archived person's names can still be edited, and the edit is audited. (d) Domain errors use explicit codes and never expose personal data. | F001 internal services and operator commands | APPROVED; RR-19 CLOSED | RR-19, [specification](../features/CHMS-F001/specification.md#api-contract) |

## 4. Technical decisions

Accepted by the product owner, Patrush, on 2026-10-27, through the ADRs listed. The safety constraints documented in each ADR are part of the accepted decision.

| ID | Decision | Record | Status | Rationale |
|---|---|---|---|---|
| TD-01 | Single `churches` row (singleton column), `church_id` with composite same-church foreign keys, operator bootstrap, recovery rules | [ADR-003](../architecture/adr/ADR-003-single-church-installation.md) | ACCEPTED | Implements BR-01, BR-09, POL-05; `church_id` and composite foreign keys retained |
| TD-02 | UUIDv7 primary keys generated by PostgreSQL 18 (`uuidv7()` column default); the application cannot supply ids | [ADR-001](../architecture/adr/ADR-001-identifiers.md) | ACCEPTED (amended) | Amended on acceptance: UUIDv7 replaces UUIDv4 |
| TD-03 | Identity immutability through column grants, a trigger and `ON UPDATE RESTRICT` | [ADR-003](../architecture/adr/ADR-003-single-church-installation.md) | ACCEPTED | BR-09 |
| TD-04 | Status-carrying foreign keys and partial unique indexes for archive and affiliation invariants | [ADR-004](../architecture/adr/ADR-004-archive-invariants-and-transactions.md) | ACCEPTED | BR-03 to BR-06; closes the race in revision 1 |
| TD-05 | Trigger-based foundation audit in M00; hardened `SECURITY DEFINER` function; system-actor attribution; append-only | [ADR-005](../architecture/adr/ADR-005-foundation-audit-trail.md) | ACCEPTED | POL-01 to POL-04; resolves RR-15 for F001 tables only |
| TD-06 | Database roles and least-privilege matrix | [ADR-006](../architecture/adr/ADR-006-database-roles-least-privilege.md) | ACCEPTED | Minimum privilege for F001 |
| TD-07 | READ COMMITTED, optimistic `row_version`, error mapping outside transactions, bounded retries | [ADR-004](../architecture/adr/ADR-004-archive-invariants-and-transactions.md) | ACCEPTED | Concurrency; also avoids the trigger condition of the reported, unverified drizzle-orm #6572 (CP-05) |
| TD-08 | Platform baseline: PostgreSQL 18 image, Node.js 24 LTS, drizzle-orm 0.45.x, drizzle-kit ≥ 0.31.7, `pg` 8.x, explicit migrations | [ADR-007](../architecture/adr/ADR-007-f001-platform-baseline.md) | ACCEPTED | Realizes BR-10; compatibility proofs authorized, not yet run |
| TD-09 | Database implementation of the approved name rules (PPD-01): NFC, Unicode-whitespace trim check, control-character check, 1–100 characters, builtin locale provider, and campus-name uniqueness with `casefold()` or, if CP-08 shows it unsuitable, `lower()` | [ADR-008](../architecture/adr/ADR-008-name-comparison-and-normalization.md) | ACCEPTED (amended) | BR-07, BR-08, PPD-01 |
| TD-10 | F001 exposes no HTTP route, page, server action or UI; operator commands and tests only | This register; [specification](../features/CHMS-F001/specification.md) | ACCEPTED | Part of the approved F001 scope (POL-06); lifted only by the approved F002 specification |
| TD-11 | Name model: `display_name` is authoritative and required; `given_name` and `family_name` are optional (NULL when absent, never empty); no synchronization rule between them | [Database design §2](../database/CHMS-F001-database-design.md#2-tables-constraints-and-indexes) | ACCEPTED | BR-08; confirmed by the product owner |
| TD-12 | Archive semantics per [ADR-002](../architecture/adr/ADR-002-retention.md): archive-first; no deletion or erasure path in F001 | ADR-002 | ACCEPTED (amended) | Amended on acceptance: no erasure implementation in F001 |

## 5. Deferred decisions

| Item | Status | Tracking |
|---|---|---|
| Deferred D-02/D-03 MVP requirements: households and household membership, person relationships, membership and basic visitor status, contact details, date of birth and minors, campus details (address, timezone), duplicate detection and merge, erasure and retention, imports | DEFERRED (still MVP scope) | [Traceability §F001](../requirements/traceability-matrix.md#chms-f001-church-campus-and-person-foundation), RR-10, RR-12 |
| Trusted database actor and RLS | DEFERRED to before F002 | RR-07 |
| Human actor attribution in audit | DEFERRED to F002 | ADR-005 |
| Audit ownership beyond F001 tables (DB-08, DB-02) | DEFERRED, NONBLOCKING for F001 (B-07) | RR-15 |
| Operations runbook for role creation, bootstrap and restore | DEFERRED, NONBLOCKING for F001 (B-09) | [Readiness report](../features/CHMS-F001/implementation-readiness.md#6-blockers-and-deferred-items) |
| Audit retention; no automatic deletion (POL-04) | DEFERRED, NONBLOCKING for F001 (B-10) | RR-17 |
| Repository-wide requirement identifier scheme; F001 IDs are provisional | DEFERRED, NONBLOCKING for F001 (B-11) | RR-18 |
| Residual risks SR-04 to SR-06 | DEFERRED, NONBLOCKING for F001 (B-12); revisit before F002 | [Security review](../architecture/CHMS-F001-security-review.md#5-findings) |
| Named reviewers for threat-model rows | DEFERRED, NONBLOCKING for F001 (B-13) | [Security review](../architecture/CHMS-F001-security-review.md#6-mapping-to-the-threat-model) |
| Exposure of UUIDv7 ids, which reveal creation time | Open; F001 exposes no ids (TD-10); decide before F002 exposes ids | SR-12 |
| Name rules | CLOSED for F001 (§3); the `casefold()`/`lower()` choice is made by CP-08 | RR-16 |
| Test runner and boundary-schema library | CLOSED for F001: Vitest (toolchain step); boundary schemas are hand-written (`src/domain/input.ts`), with no validation library in F001 (Patrush, 2026-10-28) | ADR-007 |

## 6. Approval record

| Item | Approved by | Date | Evidence |
|---|---|---|---|
| BR-01 to BR-10, POL-01 to POL-06 | Patrush (product owner) | 2026-10-27 | Product-owner decisions of 2026-10-27; the final authorization names the approver |
| PPD-01 name rules (closes RR-16 for F001) | Patrush (product owner) | 2026-10-27 | Final product-owner authorization of 2026-10-27, replacing the earlier proposal (§3 history) |
| ADR-001 to ADR-008 (TD-01 to TD-12) | Patrush (product owner) | 2026-10-27 | Accepted with amendments: ADR-001 (UUIDv7), ADR-002 (archive-first, no erasure in F001), ADR-008 (approved name rules). Before this, ADR-001 and ADR-002 had no approval record: both were added in `778ce37` (2026-10-26) as "Recorded baseline", and each keeps its original text in a history note |
| Implementation authorization | Patrush (product owner) | 2026-10-27 | Install the ADR-007 toolchain; use disposable local and CI PostgreSQL 18 databases; run CP-01 to CP-09 and TS-F001-33 at the beginning of the implementation branch; start after the documentation PR is merged |
| B-07, B-09 to B-13 | Patrush (product owner) | 2026-10-27 | DEFERRED, NONBLOCKING for F001 |
| PPD-02 service behaviour (closes RR-19) | Patrush (product owner) | 2026-10-28 | Product-owner approval of 2026-10-28 |
| Hand-written boundary validation; no validation library in F001 | Patrush (product owner) | 2026-10-28 | Product-owner approval of 2026-10-28 |
