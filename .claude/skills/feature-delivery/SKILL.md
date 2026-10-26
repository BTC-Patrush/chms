---
name: feature-delivery
description: Trace approved requirements to bounded implementation and tests; propose plan before code.
---

# Purpose
Trace approved requirements to bounded implementation and tests; propose plan before code.

## Inputs
Approved domain requirements, accepted ADRs, feature contract, relevant database design, repository state and existing tests.

## Procedure
1. Confirm source status and scope; stop on unresolved conflicts.
2. Inspect dependencies and security/privacy boundaries.
3. Produce a small plan and identify approvals required.
4. Perform only authorized changes, if any.
5. Run relevant positive, negative and integration checks.
6. Report exact commands/results, limitations and changed files.
7. Update traceability and request independent review.

## Guardrails
Never claim a test passed without execution. Never make destructive production changes. Never downgrade a security invariant to finish work.
