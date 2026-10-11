import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Test support that every test file runs behind (T-B-062 no-egress guard, T-B-063 MSW).
    setupFiles: ['./test/support/install-no-egress.ts'],
  },
});
