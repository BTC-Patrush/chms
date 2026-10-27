# Requirements-to-test traceability

| Requirement ID | Approved source | Feature | Tables/API | Tests | Status |
|---|---|---|---|---|---|
| BR-01 | [D-02](domains/D-02-church.md#approved-business-rules-chms-f001) (PO, 2026-10-27) | CHMS-F001 | `churches` (singleton), `campuses`; `bootstrapChurch` | TS-F001-01, 02, 03 | Approved; design Proposed; tests NOT RUN |
| BR-02 | [D-03](domains/D-03-people.md#approved-business-rules-chms-f001) (PO, 2026-10-27) | CHMS-F001 | `people` (no account column); `createPerson` | TS-F001-13 | Approved; design Proposed; tests NOT RUN |
| BR-03 | [D-03](domains/D-03-people.md#approved-business-rules-chms-f001) | CHMS-F001 | `person_campus_affiliations`; `linkPersonToCampus`, `endAffiliation`, `setPrimaryAffiliation` | TS-F001-16, 17 | Approved; design Proposed; tests NOT RUN |
| BR-04 | [D-03](domains/D-03-people.md#approved-business-rules-chms-f001) | CHMS-F001 | `people`, `person_campus_affiliations`; `archivePerson` | TS-F001-18 to 21, 23, 38 | Approved; design Proposed; tests NOT RUN |
| BR-05 | [D-03](domains/D-03-people.md#approved-business-rules-chms-f001) | CHMS-F001 | `unarchivePerson` | TS-F001-22 | Approved; design Proposed; tests NOT RUN |
| BR-06 | [D-02](domains/D-02-church.md#approved-business-rules-chms-f001) | CHMS-F001 | `campuses`, `person_campus_affiliations`; `archiveCampus` | TS-F001-08 to 12, 38 | Approved; design Proposed; tests NOT RUN |
| BR-07 | [D-02](domains/D-02-church.md#approved-business-rules-chms-f001) | CHMS-F001 | `campuses_name_ci_uq`; `createCampus`, `renameCampus` | TS-F001-06, 07 | Approved; campus-name rules proposed as PPD-01, awaiting confirmation (RR-16); tests NOT RUN |
| BR-08 | [D-03](domains/D-03-people.md#approved-business-rules-chms-f001) | CHMS-F001 | `people.display_name`, `given_name`, `family_name` | TS-F001-14, 15 | Approved; person-name length limits open (RR-16); tests NOT RUN |
| BR-09 | [D-02](domains/D-02-church.md#approved-business-rules-chms-f001) | CHMS-F001 | `churches`; `renameChurch`; identity triggers | TS-F001-01, 02, 04, 05, 36 | Approved; design Proposed; tests NOT RUN |
| BR-10 | [Decision register](../decisions/CHMS-F001-decision-register.md#1-approved-business-rules) | CHMS-F001 | Platform (ADR-007) | Compatibility proofs CP-01 to CP-09 | Approved; compatibility NOT VERIFIED |
| POL-01 | [Decision register](../decisions/CHMS-F001-decision-register.md#2-approved-policy-decisions) | CHMS-F001 | `audit_events`, `system_actor_categories` | TS-F001-01, 26 to 28, 38 | Approved; tests NOT RUN |
| POL-02 | [Decision register](../decisions/CHMS-F001-decision-register.md#2-approved-policy-decisions) | CHMS-F001 | `system_actor_categories` (test profile only) | TS-F001-27 | Approved; tests NOT RUN |
| POL-03 | [Decision register](../decisions/CHMS-F001-decision-register.md#2-approved-policy-decisions) | CHMS-F001 | `chms_audit_reader` | TS-F001-29 | Approved; tests NOT RUN |
| POL-04 | [Decision register](../decisions/CHMS-F001-decision-register.md#2-approved-policy-decisions) | CHMS-F001 | `audit_events` (append-only, no deletion) | TS-F001-29 | Approved; retention open (RR-17) |
| POL-05 | [Decision register](../decisions/CHMS-F001-decision-register.md#2-approved-policy-decisions) | CHMS-F001 | Bootstrap and restore procedure | TS-F001-36 | Approved; tests NOT RUN |
| POL-06 | [Decision register](../decisions/CHMS-F001-decision-register.md#2-approved-policy-decisions) | CHMS-F001 / F002 | No exposure in F001 (TD-10) | TS-F001-37 | Approved (planning only) |
| Campus scope must be checked | Repository invariant (`CLAUDE.md`); not a product-owner-approved requirement | CHMS-F001 | `listPeople(scope)`, `getPerson(scope)` | TS-F001-24, 25 | Traced; approval status unresolved |
| No sensitive data in logs or fixtures | Repository invariant (`CLAUDE.md`); not a product-owner-approved requirement | CHMS-F001 | Logs, audit | TS-F001-34 | Traced; approval status unresolved |

## Domain coverage

All 16 domains from the [requirements index](requirements-index.md) are listed individually. Release labels are copied from the index unchanged. The related open questions are grouped by topic and are informational.

| Domain | Area | Release (index) | Approved requirements | Feature | Related open questions | Status |
|---|---|---|---|---|---|---|
| [D-01](domains/D-01-iam.md) | IAM | MVP | None | — | RR-07, RR-13 | Unmapped; original requirements missing; required before CHMS-F002 |
| [D-02](domains/D-02-church.md) | Church management | MVP | BR-01, BR-06, BR-07, BR-09 (partial) | CHMS-F001 | RR-16 | Partially mapped (rows above); remainder unmapped |
| [D-03](domains/D-03-people.md) | People & households | MVP | BR-02, BR-03, BR-04, BR-05, BR-08 (partial) | CHMS-F001 | RR-10, RR-12, RR-16 | Partially mapped (rows above); remainder unmapped |
| [D-04](domains/D-04-ministries.md) | Ministries | MVP | None | — | — | Unmapped; original requirements missing |
| [D-05](domains/D-05-leadership.md) | Leadership & committees | Basic MVP; advanced Later | None | — | — | Unmapped; original requirements missing |
| [D-06](domains/D-06-groups.md) | Groups & fellowship | MVP | None | — | RR-05 | Unmapped; original requirements missing |
| [D-07](domains/D-07-events.md) | Events & scheduling | MVP | None | — | RR-08 | Unmapped; original requirements missing |
| [D-08](domains/D-08-attendance.md) | Attendance | MVP | None | — | RR-08, RR-09 | Unmapped; original requirements missing |
| [D-09](domains/D-09-giving.md) | Giving | MVP | None | — | RR-01, RR-02 | Unmapped; original requirements missing |
| [D-10](domains/D-10-communications.md) | Communications | Basic MVP | None | — | RR-03, RR-11 | Unmapped; original requirements missing |
| [D-11](domains/D-11-media.md) | Media & content | Basic MVP | None | — | RR-04, RR-14 | Unmapped; original requirements missing |
| [D-12](domains/D-12-reporting.md) | Reporting | Predefined MVP; custom builder Later | None | — | RR-05 | Unmapped; original requirements missing |
| [D-13](domains/D-13-administration.md) | Local administration | MVP | None | — | RR-06 | Unmapped; original requirements missing |
| [D-14](domains/D-14-integrations.md) | Integrations | SMTP MVP; others Later | None | — | RR-11 | Unmapped; original requirements missing |
| [D-15](domains/D-15-security.md) | Security, privacy & audit | MVP | None. POL-01 to POL-04 are F001 policies, not D-15 requirements | — | RR-07, RR-10, RR-15, RR-17 | Unmapped; original requirements missing |
| [D-16](domains/D-16-visitors.md) | Dedicated visitor follow-up | Later; basic visitor status in People MVP | None | — | RR-12 | Unmapped; original requirements missing |

RR-18 (identifier scheme) applies to every domain.

## CHMS-F001 Church, Campus and Person Foundation

**Domain links:**
- [D-02 approved business rules](domains/D-02-church.md#approved-business-rules-chms-f001)
- [D-03 approved business rules](domains/D-03-people.md#approved-business-rules-chms-f001)

**Feature documents:**
- [Specification](../features/CHMS-F001/specification.md)
- [Decision register](../decisions/CHMS-F001-decision-register.md)
- [Database design](../database/CHMS-F001-database-design.md)
- [Security review](../architecture/CHMS-F001-security-review.md)
- [Test matrix](../features/CHMS-F001/test-matrix.md)
- [Readiness report](../features/CHMS-F001/implementation-readiness.md)

**Relevant ADRs:**

| ADR | Status |
|---|---|
| [ADR-001](../architecture/adr/ADR-001-identifiers.md) | Recorded baseline; review pending |
| [ADR-002](../architecture/adr/ADR-002-retention.md) | Recorded baseline; review pending |
| [ADR-003](../architecture/adr/ADR-003-single-church-installation.md) | Proposed |
| [ADR-004](../architecture/adr/ADR-004-archive-invariants-and-transactions.md) | Proposed |
| [ADR-005](../architecture/adr/ADR-005-foundation-audit-trail.md) | Proposed |
| [ADR-006](../architecture/adr/ADR-006-database-roles-least-privilege.md) | Proposed |
| [ADR-007](../architecture/adr/ADR-007-f001-platform-baseline.md) | Proposed |
| [ADR-008](../architecture/adr/ADR-008-name-comparison-and-normalization.md) | Proposed |

**Deferred MVP requirements.** These are not delivered by F001 and remain MVP scope:

| Requirement | Domain | Tracking |
|---|---|---|
| Households and household membership | D-03 | [DB-01](../database/DB-01.md) entities |
| Person relationships | D-03 | DB-01 |
| Membership status and basic visitor status | D-03, D-16 | RR-12 |
| Contact details | D-03 | Original requirements missing |
| Date of birth and handling of minors | D-03 | Original requirements missing |
| Campus details (address, timezone) | D-02 | RR-08 (timezone semantics) |
| Duplicate detection and merge | D-03 | Original requirements missing |
| Erasure and retention | D-03, D-15 | RR-10 |
| Imports | D-03 | Original requirements missing |

**Outstanding questions** ([open-questions.md](../decisions/open-questions.md)):
- RR-07 and RR-13 (required before F002).
- RR-10 and RR-12 (deferred scope).
- RR-15: audit ownership.
- RR-16: campus-name rules proposed as PPD-01, awaiting confirmation; church-name and person-name rules open (blocks implementation).
- RR-17: audit retention.
- RR-18: identifier scheme.
