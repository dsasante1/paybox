import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    pool: 'threads',
    testTimeout: 15_000,
  },
});
