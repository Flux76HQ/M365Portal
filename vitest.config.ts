import { defineConfig } from 'vitest/config';

// Root-level tests only: repository tooling (tools/), the TypeScript tests of the repository scripts
// (scripts/, next to the Python governance tests) and the local ESLint rules (eslint-rules/). Every
// package runs its own tests through its own `test` script.
export default defineConfig({
  test: {
    include: ['tools/**/*.test.ts', 'scripts/**/*.test.ts', 'eslint-rules/**/*.test.ts'],
    // Typed linting starts a TypeScript project service: slow on a cold cache.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
