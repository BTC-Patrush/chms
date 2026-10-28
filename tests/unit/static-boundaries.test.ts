import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Static boundaries for CHMS-F001 (TS-F001-35 and TS-F001-37 static parts): no HTTP exposure
 * (TD-10), F001 services imported by nothing but service modules and tests, and no migrations
 * from application code (ADR-007).
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

  it('imports F001 services only from service modules and tests (TD-10, AC-F001-28)', () => {
    // Adding a top-level source directory, such as operator command entry points, must be a
    // reviewed change to this list.
    const serviceModules = ['church', 'db', 'domain', 'people'];
    const topLevel = new Set(sourceFiles.map((f) => f.split('/')[1]));
    expect([...topLevel].sort()).toEqual(['app', ...serviceModules]);
    const importsServices = new RegExp(
      `from\\s+['"][./]*(?:src/)?(?:${serviceModules.join('|')})/`,
    );
    const outside = sourceFiles.filter((f) => !serviceModules.includes(f.split('/')[1] ?? ''));
    expect(outside.filter((f) => importsServices.test(readFileSync(f, 'utf8')))).toEqual([]);
  });

  it('has no path that deletes, truncates, drops or upserts rows (POL-05, TS-F001-36 static part)', () => {
    const destructive =
      /\b(DELETE\s+FROM|TRUNCATE|DROP\s+\w+|ON\s+CONFLICT)\b|\.(delete|onConflict\w*)\(/i;
    expect(sourceFiles.filter((f) => destructive.test(readFileSync(f, 'utf8')))).toEqual([]);
  });

  it('never migrates from application code (ADR-007)', () => {
    const migrating = sourceFiles.filter((f) =>
      /drizzle-orm\/[\w-]+\/migrator|drizzle-kit/.test(readFileSync(f, 'utf8')),
    );
    expect(migrating).toEqual([]);
  });
});
