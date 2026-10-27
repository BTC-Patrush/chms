# ADR-001 — Identifiers
Status: Accepted, with amendment
Date: 2026-10-27
Decision: PostgreSQL-generated UUIDv7 primary keys for church-owned records, using the PostgreSQL 18 `uuidv7()` function as the column default; enforce same-church references with composite FKs where appropriate.
Amendment on acceptance (2026-10-27): UUIDv7 replaces UUIDv4. Ids are generated only by the database; the application cannot supply them ([ADR-006](ADR-006-database-roles-least-privilege.md)).
Consequences:
- `uuidv7()` is new in PostgreSQL 18 ([ADR-007](ADR-007-f001-platform-baseline.md)); proof CP-02 confirms it on the pinned image.
- PostgreSQL 18 documents `uuidv7()` as a "time-ordered UUID" whose timestamp uses "UNIX timestamp with millisecond precision", and `uuid_extract_timestamp()` reads it back ([UUID functions](https://www.postgresql.org/docs/18/functions-uuid.html), checked 2026-10-27). Anyone who can see an id can therefore learn approximately when the record was created. F001 exposes no ids (TD-10); exposure in later features is tracked as SR-12 in the [security review](../CHMS-F001-security-review.md).
- Tests check the version with `uuid_extract_version(id) = 7` (TS-F001-13).
History: added in commit `778ce37` (2026-10-26) as a recorded baseline with no approval record. Original text:
> Status: Recorded baseline; verify approval against original source.
> Decision: PostgreSQL-generated UUIDv4 primary keys for church-owned records; enforce same-church references with composite FKs where appropriate.

Approvers: Patrush (product owner), 2026-10-27.
