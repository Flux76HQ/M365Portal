import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Tests live in test/ (plan 4.3), never next to the sources.
    include: ['test/**/*.test.ts'],
    // Some guards compile a TypeScript project (exports.test.ts) or lint through the real config.
    testTimeout: 60_000,
  },
});
