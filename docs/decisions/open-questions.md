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
