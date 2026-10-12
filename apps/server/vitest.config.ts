import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Generous but bounded: a scrypt at the memory limit, a spawned server or an image decode takes
    // seconds when the whole suite runs in parallel; Vitest's 5 s default only measures the load.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Test support that every test file runs behind (T-B-062 no-egress guard, T-B-063 MSW).
    setupFiles: ['./test/support/install-no-egress.ts', './test/support/msw.ts'],
  },
});
