// Flat config for the whole workspace. One typed-lint run covers every package.
//
// Layout of this file (order matters, later entries win):
//   1. ignores            generated files and build output
//   2. baseline           eslint recommended for every file, typescript-eslint strict + stylistic
//                         (type-aware, projectService) for TypeScript only
//   3. globals            one entry per runtime, kept apart from every other entry on purpose:
//                         spreading a config that sets `languageOptions` replaces the whole object
//                         and silently drops `globals`
//   4. web only           react-hooks and jsx-a11y (never applied to server, shared or e2e)
//   5. relaxations        test files only (the config-file entry is absent because nothing needs it)
//   6. eslint-config-prettier last, so formatting rules never fight Prettier
//
// The guards above are proven by tools/lint-canary: it lints deliberately wrong code through
// this very file and fails when a guard stops firing.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/coverage/**',
    '**/routeTree.gen.ts',
    '**/playwright-report/**',
    '**/test-results/**',
    '**/blob-report/**',
  ]),

  { linterOptions: { reportUnusedDisableDirectives: 'error' } },

  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },

  {
    files: [
      '**/*.{js,mjs,cjs}',
      '*.ts',
      'apps/server/**/*.ts',
      'apps/web/*.ts',
      'e2e/**/*.ts',
      'tools/**/*.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  { files: ['apps/web/src/**/*.{ts,tsx}'], languageOptions: { globals: globals.browser } },
  { files: ['packages/shared/**/*.ts'], languageOptions: { globals: globals.es2021 } },

  { files: ['apps/web/**/*.{ts,tsx}'], extends: [reactHooks.configs.flat.recommended] },
  { files: ['apps/web/**/*.tsx'], extends: [jsxA11y.flatConfigs.recommended] },

  {
    files: ['**/*.test.{ts,tsx}', 'e2e/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  prettier,
]);
