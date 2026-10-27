# D-03 — People

**Status: PARTIALLY APPROVED.** The CHMS-F001 business rules below were approved by the product owner on 2026-10-27. The original requirements are still missing, and every other section remains a draft placeholder, NOT APPROVED.

## Approved business rules (CHMS-F001)
Approved by the product owner on 2026-10-27. This is the authoritative text.

- **BR-02:** People records are independent of authentication accounts.
- **BR-03:** A person may have no campus affiliation or multiple active campus affiliations, but no more than one active primary affiliation.
- **BR-04:** Archiving a person atomically ends active affiliations and preserves historical records.
- **BR-05:** Unarchiving a person does not restore previous affiliations automatically.
- **BR-08:** A person requires a display name; structured name components are optional.

These approvals cover only the rules above. They do not approve technical mechanisms (see the [CHMS-F001 decision register](../../decisions/CHMS-F001-decision-register.md)) or any other D-03 requirement, and they do not change MVP scope. Feature: [CHMS-F001](../../features/CHMS-F001/specification.md). Deferred D-03 MVP items remain in scope: households and household membership, person relationships, membership and basic visitor status, contact details, date of birth and minors, duplicate detection and merge, erasure and retention, and imports ([traceability matrix](../traceability-matrix.md#chms-f001-church-campus-and-person-foundation)).

## Original requirements (verbatim or traceable)
TODO: Add authoritative source, version, acceptance criteria and explicit release scope.

## Known design notes
See `docs/database/` and `docs/decisions/open-questions.md`; these notes do not replace original requirements.

## Actors and authorization
TODO

## Business invariants
TODO

## Acceptance criteria
TODO

## Open decisions
TODO
