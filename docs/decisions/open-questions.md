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
| RR-15 | Audit trail ownership and migration order | CHMS-F001 proposes a foundation-owned `audit_events` in M00 (ADR-005, Proposed). DB-08 lists `audit_events` under M08 and DB-02 lists separate security events. Both stay unchanged until this is decided |
| RR-16 | Name text comparison and normalization | **Proposed product-owner decision, awaiting explicit confirmation** (PPD-01 in the [CHMS-F001 decision register](CHMS-F001-decision-register.md#3-proposed-product-owner-decisions-awaiting-confirmation)), covering campus names: unique within a church including archived records; leading and trailing whitespace trimmed; case-insensitive comparison; NFC normalization; length 1–120 characters after trimming; display capitalization preserved. The exact PostgreSQL implementation remains Proposed (ADR-008). Rules for church names and person names are not covered and remain open. Blocks F001 implementation until confirmed |
| RR-17 | Audit retention | No automatic deletion approved (POL-04). Audit is append-only and grows without bound; retention, archival and privacy effects undecided |
| RR-18 | Requirement identifier scheme | CHMS-F001 uses provisional, feature-scoped IDs (BR-xx, POL-xx, TD-xx, AC-F001-xx, TS-F001-xx). A repository-wide scheme is undecided |
