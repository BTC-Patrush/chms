# ChMS — Claude Code project instructions

## Mission
Build a secure, self-hosted, single-church, multi-campus Church Management System as a modular monolith. Do not start implementation until the relevant specifications are approved.

## Stack
In use, with exact versions in `package.json`, `.nvmrc` and `compose.yaml`: Ubuntu, Docker Compose, Node.js 24 LTS, Next.js (App Router), TypeScript (strict), React, PostgreSQL 18, Drizzle ORM and drizzle-kit, node-postgres, Vitest, ESLint, Prettier.
Planned, not yet in use: shadcn/ui, Better Auth, protected file storage, SMTP, separate worker.
Before adding or upgrading a dependency, verify the version and its security advisories.

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

## Engineering conventions
- **Checks:** `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run test:db` (needs the local cluster; see README), `npm run build`, and `python3 scripts/check_repo_hygiene.py`. CI runs the same.
- **Dependencies:** pin exact versions, at least 14 days old unless a security fix requires newer. Dependency install scripts stay disabled (`.npmrc`), and `npm audit` must stay clean.
- **Migrations:**
  - They live in `./drizzle`. `drizzle-kit generate` produces tables; `--custom` produces roles, grants, functions and triggers. Use only a relative `--out`.
  - They are applied only by an operator connected as `chms_owner`. Never use `drizzle-kit push`, and never migrate from application code.
  - Migrations are additive and reviewed. A generated migration must not recreate schema `chms`, which M00 owns.
  - drizzle-kit can exit 0 after an error, so check its output.
- **Provisioning:** `db/provision/*.sql` is privileged and run by an operator as a superuser. It is never part of the migration chain.
- **Transactions:**
  - Services use `withTransaction` (`src/db/transaction.ts`). Never catch a database error inside a transaction callback and continue (drizzle-orm #6572), and never nest transactions.
  - Declare the actor with `set_config('chms.actor_category', …, true)`, never a session `SET`.
  - Map errors outside the transaction by SQLSTATE plus constraint name. Archiving a still-referenced row raises `23001`; an insert referencing an archived row raises `23503`.
  - Retry only in a new transaction.
- **Tests:**
  - Use real PostgreSQL 18, only on the loopback disposable cluster. Never mock the database.
  - Confirm concurrent interleavings with `pg_blocking_pids()`, reading backend PIDs before issuing the statement that blocks.
- **SQL text:** keep source, SQL and generated DDL ASCII. Build non-ASCII characters and regular-expression escapes from code points; editors and tools have silently decoded `\u` escapes.
- **Documents:** correct an accepted ADR only by appending an erratum; never rewrite its decision. In other documents, correct the value in place and keep the original wording in an errata note.
- **Approval-gated commands:** run `drizzle-kit`, `psql`, `pg_dump`, `pg_restore`, `docker compose exec`, `docker compose down` and `git push` directly, so the permission prompt appears. Never wrap them to avoid it.

## Agent and skill routing
Use `.claude/agents/` for bounded specialist delegation and `.claude/skills/` for repeatable procedures. Specialist reviews are not independent security assurance. Use human review and executable checks.

## Current status
CHMS-F001 (backend foundation) is implemented on `feat/chms-f001-foundation` and in review (PR #3, not merged). Toolchain, CI, PostgreSQL 18 compatibility proofs, migration M00 (roles, grants, audit), M01a (F001 tables), the F001 internal services (`src/church`, `src/people`), the operator CLI (`src/commands`, `npm run chms`) and the restore drill (`tests/recovery`) exist. Any RLS prototype and any production environment do not. Progress, open questions and next steps are in `PROGRESS.md`.
