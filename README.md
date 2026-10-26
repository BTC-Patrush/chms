# ChMS — Church Management System

Documentation-first, Claude Code-assisted engineering starter kit for a self-hosted single-church, multi-campus ChMS.

**Status:** planning and architecture drafts; no application code or tested database yet.

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
