# ChMS — Church Management System

Documentation-first, Claude Code-assisted engineering starter kit for a self-hosted single-church, multi-campus ChMS.

**Status:** CHMS-F001 implementation in progress: toolchain, PostgreSQL 18 compatibility tests and migration M00 (roles, grants, audit trail). The F001 tables (M01a), services and any production environment do not exist yet.

## Local development
Requires Node.js 24.22.1 (`.nvmrc`) and Docker with Compose v2. No paid cloud service is needed.

```bash
nvm use        # Node.js version from .nvmrc
npm ci         # exact versions from package-lock.json; dependency install scripts are disabled (.npmrc)

# Disposable local PostgreSQL 18 (compose.yaml), listening on 127.0.0.1 only.
# Never point it at production data. The password file must be readable by the
# container, so keep it in a private directory.
install -d -m 700 ~/.config/chms
(umask 022 && openssl rand -hex 24 > ~/.config/chms/pg-admin-password)
export CHMS_PG_ADMIN_PASSWORD_FILE=~/.config/chms/pg-admin-password
docker compose up --detach --wait

npm run format:check && npm run lint && npm run typecheck
npm run test:unit
npm run test:db    # creates and drops its own databases on the local cluster
npm run build
```
Database tests refuse any host other than `127.0.0.1`. They provision the roles below on the local cluster with random passwords. Next.js telemetry can be disabled with `NEXT_TELEMETRY_DISABLED=1` (CI does).

## Database provisioning and migrations
These are privileged steps (`CLAUDE.md`, ADR-006). Run them only with explicit human authorization.

1. As a superuser, once per cluster: `psql -v ON_ERROR_STOP=1 -f db/provision/01-cluster-roles.sql`. This creates `chms_owner`, `chms_app`, `chms_audit_writer` and `chms_audit_reader`, and sets no passwords.
2. Set the login passwords for `chms_owner` and `chms_app`, for example with psql's `\password`.
3. Create the database. Then, as a superuser connected to it: `psql -v ON_ERROR_STOP=1 -d <database> -f db/provision/02-database-privileges.sql`.
4. As `chms_owner`: `npx drizzle-kit migrate`, with the connection string in `CHMS_MIGRATION_DATABASE_URL` (keep the password out of shell history). Migrations never run on application startup, and `drizzle-kit push` is never used.

Authorized audit readers are granted per login: `GRANT CONNECT ON DATABASE <database> TO <login>;` and `GRANT chms_audit_reader TO <login>;` (POL-03). A full operations runbook is deferred (B-09).

## Ubuntu setup
```bash
mkdir -p ~/projects
cd ~/projects
# Extract the supplied chms starter ZIP here; it contains a chms/ folder.
cd chms
git init -b main
git add .
git commit -m "chore: initialize ChMS engineering knowledge base"
claude
```
Requires Git and Claude Code already installed. Git identity must be configured for commits. Do not copy existing project `.env` files.

Read `docs/operations/claude-code-setup.md` and `docs/decisions/open-questions.md` before asking Claude to implement features.

## First Claude prompt
> Audit this documentation-only repository. Read CLAUDE.md, requirements index, ADRs and open questions. Produce a coverage report of missing approved specifications and contradictions. Do not write application code, install packages, run migrations or modify configuration.

## Important
Agent/skill files are guidance, not executable controls. The security model and CI gates require implementation and verification.
