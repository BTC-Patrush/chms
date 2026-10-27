import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Static boundaries for CHMS-F001 (TS-F001-35 and TS-F001-37 static parts): no HTTP exposure
 * (TD-10) and no migrations from application code (ADR-007).
 */
const sourceFiles = readdirSync('src', { recursive: true, encoding: 'utf8' })
  .filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f))
  .map((f) => join('src', f));

describe('static boundaries', () => {
  it('has no page, route handler or server action (TD-10, AC-F001-28)', () => {
    const exposed = sourceFiles.filter(
      (f) =>
        /(^|\/)(page|route|default|template)\.(tsx?|jsx?)$/.test(f) ||
        /^\s*['"]use server['"]/m.test(readFileSync(f, 'utf8')),
    );
    expect(exposed).toEqual([]);
    expect(sourceFiles.filter((f) => f.startsWith('src/app/'))).toEqual(['src/app/layout.tsx']);
  });

  it('never migrates from application code (ADR-007)', () => {
    const migrating = sourceFiles.filter((f) =>
      /drizzle-orm\/[\w-]+\/migrator|drizzle-kit/.test(readFileSync(f, 'utf8')),
    );
    expect(migrating).toEqual([]);
  });
});
