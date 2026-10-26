"""Repository hygiene checks for ChMS Claude Code and Git configuration.

Standard library only. Run locally with `python3 scripts/check_repo_hygiene.py`;
the repo-hygiene workflow runs the same command.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Approved tool ceiling per agent. Claude Code gives an agent every tool when
# `tools` is omitted and silently drops misspelled names, so both fail here.
ENGINEER = {"Read", "Grep", "Glob", "Edit", "Write", "Bash", "WebFetch", "WebSearch", "Skill"}
AGENT_TOOLS = {
    "architect": {"Read", "Grep", "Glob", "Edit", "Write", "WebFetch", "WebSearch", "Skill"},
    "documentation-engineer": {"Read", "Grep", "Glob", "Edit", "Write", "Skill"},
    "security-reviewer": {"Read", "Grep", "Glob", "Skill"},
    "qa-engineer": {"Read", "Grep", "Glob", "Edit", "Write", "Bash", "Skill"},
    "backend-engineer": ENGINEER,
    "frontend-engineer": ENGINEER,
    "database-engineer": ENGINEER,
    "devops-engineer": ENGINEER,
}

# Documented frontmatter fields (Claude Code 2.1.310). Unknown fields are
# ignored without an error, so a typo such as `disallowed_tools` fails here.
AGENT_FIELDS = set(
    "name description tools disallowedTools model permissionMode maxTurns autoCompactWindow "
    "skills mcpServers hooks memory background omitClaudeMd effort isolation color "
    "initialPrompt experimental".split()
)
SKILL_FIELDS = set(
    "name description when_to_use argument-hint arguments disable-model-invocation "
    "user-invocable allowed-tools disallowed-tools model effort context agent background "
    "hooks paths shell metadata license compatibility".split()
)

# Skill fields that act outside the invoking agent's tool allowlist: hooks and
# injected commands run shell, `context: fork` starts another agent type, and
# `allowed-tools` pre-approves tools even in untrusted folders. Any agent with
# the Skill tool, including the read-only security-reviewer, can invoke every
# project skill, so none may use them.
SKILL_ESCAPE_FIELDS = {"allowed-tools", "hooks", "context", "agent", "shell"}
SHELL_INJECTION = re.compile(r"(?:^|[ \t])!`|^[ \t]*```!", re.MULTILINE)

# Built-in commands and bundled skills (Claude Code 2.1.310 commands reference).
# A project skill with one of these names replaces the built-in.
RESERVED_SKILL_NAMES = set(
    """add-dir advisor agents artifact-capabilities artifact-diagramming artifacts
    auto-mode-setup autocompact autofix-pr background batch branch btw bug cd chrome
    claude-api claude-in-chrome clear code-review color compact config context copy cost
    dataviz debug deep-research design design-login design-sync desktop diff doctor effort
    exit export fast feedback fewer-permission-prompts focus fork goal heapdump help hooks
    ide import init insights install-github-app install-slack-app keybindings list-agents
    login logout loop mcp memory mobile model output-style passes permissions plan plugin
    plugin-authoring powerup pr-comments privacy-settings radio rate-limit-options recap
    release-notes reload-plugins reload-skills remote-control remote-env rename resume
    review rewind run run-skill-generator sandbox schedule scroll-speed security-review
    setup-bedrock setup-vertex simplify skill-doctor skills slides stats status statusline
    stickers stop subtask tasks team-onboarding teleport terminal-setup theme tui ultraplan
    ultrareview update-config upgrade usage usage-credits verify vim voice web-setup
    workflow-authoring workflows""".split()
)

REQUIRED_DENY = {
    "Read(.env)", "Read(.env.*)", "Edit(.env)", "Edit(.env.*)",
    "Read(secrets/**)", "Edit(secrets/**)", "Read(backups/**)", "Edit(backups/**)",
    "Read(storage/**)", "Edit(storage/**)",
}
REQUIRED_ASK = {"Edit(/.claude/**)", "Edit(/.github/**)", "Bash(git push *)", "Bash(rm *)"}
REQUIRED_GITIGNORE = {
    ".env", ".env.*", "secrets/", "backups/", "storage/", ".claude/settings.local.json",
    "*.pem", "*.key", "*.p12", "*.pfx", "*.dump", "*.sql.gz",
}
SENSITIVE_DIRS = {"secrets", "backups", "storage"}
SENSITIVE_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".dump", ".sql.gz")
MATRIX = ROOT / "docs" / "engineering" / "agent-skill-matrix.md"

errors = []


def fail(message):
    errors.append(message)


def frontmatter(path):
    """Return top-level frontmatter fields; list values become Python lists."""
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0] != "---":
        return None
    fields, key = {}, None
    for line in lines[1:]:
        if line == "---":
            return fields
        stripped = line.strip()
        if key and stripped.startswith("- "):
            fields[key] = (fields[key] or []) + [stripped[2:].strip()]
        elif line[:1] not in (" ", "\t", "") and ":" in line:
            key, _, value = line.partition(":")
            key = key.strip()
            fields[key] = value.strip() or None
    return None


def check_settings():
    path = ROOT / ".claude" / "settings.json"
    try:
        settings = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        fail(f"{path.relative_to(ROOT)}: unreadable or invalid JSON ({exc})")
        return
    permissions = settings.get("permissions", {})
    if settings.get("disableSkillShellExecution") is not True:
        fail("settings.json: disableSkillShellExecution must be true")
    if permissions.get("disableBypassPermissionsMode") != "disable":
        fail("settings.json: permissions.disableBypassPermissionsMode must be \"disable\"")
    for rule_type, required in (("deny", REQUIRED_DENY), ("ask", REQUIRED_ASK)):
        for rule in sorted(required - set(permissions.get(rule_type, []))):
            fail(f"settings.json: missing {rule_type} rule {rule}")


def check_agents():
    for path in sorted((ROOT / ".claude" / "agents").glob("*.md")):
        rel, fields = path.relative_to(ROOT), frontmatter(path)
        if fields is None:
            fail(f"{rel}: missing or unterminated frontmatter")
            continue
        for field in sorted(set(fields) - AGENT_FIELDS):
            fail(f"{rel}: unknown frontmatter field '{field}'")
        if fields.get("name") != path.stem:
            fail(f"{rel}: name must equal file name '{path.stem}'")
        if not fields.get("description"):
            fail(f"{rel}: missing description")
        if path.stem not in AGENT_TOOLS:
            fail(f"{rel}: no approved tool ceiling; add one to AGENT_TOOLS")
            continue
        tools = fields.get("tools")
        if not tools:
            fail(f"{rel}: missing tools allowlist (omitting it grants every tool)")
            continue
        listed = set(tools) if isinstance(tools, list) else {t.strip() for t in tools.split(",")}
        for tool in sorted(listed - AGENT_TOOLS[path.stem]):
            fail(f"{rel}: tool '{tool}' exceeds approved ceiling or is misspelled")


def check_skills():
    for path in sorted((ROOT / ".claude" / "skills").glob("*/SKILL.md")):
        rel, fields, directory = path.relative_to(ROOT), frontmatter(path), path.parent.name
        if fields is None:
            fail(f"{rel}: missing or unterminated frontmatter")
            continue
        for field in sorted(set(fields) - SKILL_FIELDS):
            fail(f"{rel}: unknown frontmatter field '{field}'")
        for field in sorted(set(fields) & SKILL_ESCAPE_FIELDS):
            fail(f"{rel}: '{field}' lets a skill act outside the invoking agent's tools")
        if SHELL_INJECTION.search(path.read_text(encoding="utf-8")):
            fail(f"{rel}: inline shell injection (!`command` or ```!) is not allowed")
        if fields.get("name") != directory:
            fail(f"{rel}: name must equal directory name '{directory}'")
        if not fields.get("description"):
            fail(f"{rel}: missing description")
        if directory in RESERVED_SKILL_NAMES:
            fail(f"{rel}: '{directory}' replaces a built-in Claude Code command")


def check_matrix():
    """Every agent and skill named in the routing matrix must exist."""
    rel = MATRIX.relative_to(ROOT)
    rows = re.findall(r"^\| *([a-z][a-z-]*) *\| *([a-z][a-z, -]*?) *\|$", MATRIX.read_text(encoding="utf-8"), re.MULTILINE)
    if not any(agent == "security-reviewer" for agent, _ in rows):
        fail(f"{rel}: no row for security-reviewer")
    for agent, skills in rows:
        if not (ROOT / ".claude" / "agents" / f"{agent}.md").is_file():
            fail(f"{rel}: agent '{agent}' has no definition in .claude/agents/")
        for skill in filter(None, (s.strip() for s in skills.split(","))):
            if not (ROOT / ".claude" / "skills" / skill / "SKILL.md").is_file():
                fail(f"{rel}: skill '{skill}' for {agent} has no definition in .claude/skills/")


def check_tracked_files():
    listing = subprocess.run(
        ["git", "ls-files", "-s", "-z"], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout
    # Git records only the executable bit, so write bits are a property of a
    # local checkout; a CI runner's umask says nothing about this repository.
    check_working_tree = os.environ.get("GITHUB_ACTIONS") != "true"
    directories = set()
    for entry in filter(None, listing.split("\0")):
        meta, _, name = entry.partition("\t")
        mode, parts = meta.split()[0], Path(name).parts
        if mode != "100644":
            fail(f"{name}: git mode {mode}, expected 100644 (no executables or symlinks)")
        base = parts[-1]
        if (base == ".env" or base.startswith(".env.")) and base != ".env.example":
            fail(f"{name}: environment file must not be tracked")
        if SENSITIVE_DIRS & set(parts[:-1]) or base.endswith(SENSITIVE_SUFFIXES):
            fail(f"{name}: sensitive path must not be tracked")
        if check_working_tree and (ROOT / name).exists() and (ROOT / name).stat().st_mode & 0o022:
            fail(f"{name}: group- or world-writable in the working tree")
        directories.update(Path(*parts[:i]) for i in range(1, len(parts)))
    for directory in sorted(directories) if check_working_tree else ():
        if (ROOT / directory).stat().st_mode & 0o022:
            fail(f"{directory}/: group- or world-writable in the working tree")


def check_gitignore():
    lines = set((ROOT / ".gitignore").read_text(encoding="utf-8").splitlines())
    for pattern in sorted(REQUIRED_GITIGNORE - lines):
        fail(f".gitignore: missing '{pattern}'")


def main():
    checks = (check_settings, check_agents, check_skills, check_matrix, check_tracked_files, check_gitignore)
    for check in checks:
        check()
    for message in errors:
        print(f"FAIL: {message}")
    if errors:
        print(f"{len(errors)} hygiene problem(s) found")
        return 1
    print(f"OK: repository hygiene checks passed ({len(checks)} groups)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
