# Claude Code setup — Ubuntu

## 1. Verify tools
```bash
uname -a
git --version
docker --version
docker compose version
node --version
claude --version
```

Do not assume installed versions are compatible; verify against official current documentation.

## 2. Initialize a separate repository
```bash
cd ~/projects/chms
git init -b main
git add .
git commit -m "chore: initialize ChMS engineering knowledge base"
```

Create a **new private remote repository** after local review; publish only when license, sensitive data and security review are complete. Never copy `.env` from other projects.

## 3. Claude Code
Run `claude` from the repository root. Confirm `.claude/agents/` and `.claude/skills/` load using the installed version's supported commands. Agent tool permissions and skill metadata may vary by release.

## 4. Plugins — verify in the installed marketplace
Start with GitHub, Context7, Playwright and TypeScript LSP if compatible. Consider Code Review and Security Guidance. Inspect publisher, permissions and version. Use `/plugin` in Claude Code to discover. Avoid overlapping orchestration plugins initially. Do not connect production databases to generic MCP tools.

## 5. First dry run
Ask Claude to audit requirements coverage and report unresolved decisions **without editing files or executing migrations**.

## 6. Later engineering gates
Implement lint, typecheck, unit/integration/E2E tests, migration checks, dependency/secret scans, CI, branch protection and isolated RLS adversarial tests. None are installed by this starter kit.
