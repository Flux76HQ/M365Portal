import { defineConfig } from 'vitest/config';

// Root-level tests only (tools/). Every package runs its own tests through its own `test` script.
export default defineConfig({
  test: {
    include: ['tools/**/*.test.ts'],
    // Typed linting starts a TypeScript project service: slow on a cold cache.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
