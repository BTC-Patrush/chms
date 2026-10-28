import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        // Real PostgreSQL 18 on the local disposable cluster (compose.yaml); never mocked.
        test: {
          name: 'db',
          include: ['tests/db/**/*.test.ts'],
          // Provisions the CHMS-F001 roles once per run (db/provision/01-cluster-roles.sql).
          globalSetup: ['tests/support/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
