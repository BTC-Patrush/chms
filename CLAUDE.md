# ChMS — Claude Code project instructions

## Mission
Build a secure, self-hosted, single-church, multi-campus Church Management System as a modular monolith. Do not start implementation until the relevant specifications are approved.

## Planned stack (verify versions before implementation)
Ubuntu, Docker Compose, Next.js, TypeScript, React, shadcn/ui, PostgreSQL, Drizzle ORM, Better Auth, protected file storage, SMTP, separate worker.

## Sources of truth
1. `docs/requirements/` — **only explicitly approved requirements**
2. `docs/architecture/adr/` — accepted ADRs
3. `docs/database/` — reviewed database contracts
4. `docs/features/` — approved feature specifications
5. Code and passing tests — implementation evidence, never a substitute for requirements

**Drafts and proposals are not approved.** If documents conflict or lack a decision, stop, record the issue in `docs/decisions/open-questions.md`, and ask for approval. Never silently shrink MVP scope.

## Non-negotiable invariants
- Person records are separate from authentication accounts; leadership does not automatically grant IAM permissions.
- Same-church references must be enforced; campus scope must be checked.
- Mandatory independent financial verification, including Administrators; no self-verification or approved override.
- SMTP acceptance is not inbox delivery; UNKNOWN outcomes are not automatically retried.
- Public content needs independent authorized approval of the exact revision and media.
- No secrets or sensitive member/donor data in logs or test fixtures.
- Do not claim RLS is secure merely because an application-set GUC contains a user ID.
- No production deployment, destructive migration, restore, secret rotation or privileged change without explicit human authorization.

## Workflow
Before work: read domain requirements, accepted ADRs, relevant DB and feature docs; inspect repository; present bounded plan and risks.
During work: preserve boundaries; implement smallest approved change; add negative and positive tests; keep commits reviewable.
Before completion: run relevant lint, typecheck, tests and security checks; report exact commands/results and changed files; update traceability. Never invent successful test results.

## Agent and skill routing
Use `.claude/agents/` for bounded specialist delegation and `.claude/skills/` for repeatable procedures. Specialist reviews are not independent security assurance. Use human review and executable checks.

## Current status
Documentation-first starter kit. No application, database migrations, RLS prototype, CI pipeline, or production environment has been implemented.
