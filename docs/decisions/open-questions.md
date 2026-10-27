# Requirements reconciliation register

All items are **open** until explicitly decided. Do not silently resolve them in code.

| ID | Topic | Current safe baseline / action |
|---|---|---|
| RR-01 | Administrator access to donor-level giving | Privacy vs broad Admin role unresolved; restrict pending decision |
| RR-02 | Single finance verifier | No exception approved; self-verification prohibited |
| RR-03 | Broadcast approval | Conflicting descriptions; preserve stricter risk-based approval pending original-source reconciliation |
| RR-04 | Media safeguarding and clearance | Define authorization/consent process before public sensitive media |
| RR-05 | Small-group report suppression | Threshold and differencing rules not decided |
| RR-06 | Backup RPO/RTO, retention, restore cadence | Requires operational decision |
| RR-07 | Trusted PostgreSQL actor context | Must pass adversarial prototype; plain SET LOCAL app.user_id insufficient |
| RR-08 | Multi-day events and attendance sessions | Clarify session and recurrence semantics |
| RR-09 | Aggregate attendance categories | Prevent double counting; define categories |
| RR-10 | Privacy retention and erasure | Domain-specific periods not approved |
| RR-11 | SMTP delivery evidence | SMTP accepted != delivered; UNKNOWN never auto-retry |
| RR-12 | Visitor follow-up | Dedicated D-16 module Later, visitor status in People MVP |
| RR-13 | Exact Better Auth schema and compatible versions | Verify installed releases before implementation |
| RR-14 | Public-content approval and revocation | Exact-revision independent approval; detailed clearance and cache invalidation pending |
| RR-15 | Audit trail ownership and migration order | For F001 tables, decided by ADR-005 (accepted 2026-10-27): a foundation-owned `audit_events` in M00. DB-08 lists `audit_events` under M08 and DB-02 lists separate security events; both stay unchanged, and ownership beyond F001 stays open (deferred, nonblocking for F001) |
| RR-16 | Name text comparison and normalization | **Closed for CHMS-F001** by the product owner, Patrush, on 2026-10-27 (PPD-01 in the [CHMS-F001 decision register](CHMS-F001-decision-register.md#3-approved-name-rules-closes-rr-16-for-f001)). For church, campus and person names: trim leading and trailing whitespace; reject empty names, control characters and invalid Unicode; normalize to NFC before storage; do not collapse internal whitespace; 1–100 characters after trimming. Case-insensitive uniqueness applies only where already required (campus names, BR-07), using `casefold()` if compatibility testing proves it `IMMUTABLE` and suitable for the unique index, otherwise `lower()` (ADR-008). Name rules for later features are not decided here |
| RR-17 | Audit retention | No automatic deletion approved (POL-04). Audit is append-only and grows without bound; retention, archival and privacy effects undecided. Deferred, nonblocking for F001 |
| RR-18 | Requirement identifier scheme | CHMS-F001 uses provisional, feature-scoped IDs (BR-xx, POL-xx, TD-xx, AC-F001-xx, TS-F001-xx). A repository-wide scheme is undecided. Deferred, nonblocking for F001 |
