// Flat config for the whole workspace. One typed-lint run covers every package.
//
// Layout of this file (order matters, later entries win):
//   1. ignores            generated files and build output, anchored to where they really are: a
//                         source folder that merely shares a name with one (apps/web/src/features/
//                         coverage) is linted
//   2. baseline           eslint recommended for every file, typescript-eslint strict + stylistic
//                         (type-aware, projectService) for TypeScript only
//   3. globals            one entry per runtime, kept apart from every other entry on purpose:
//                         spreading a config that sets `languageOptions` replaces the whole object
//                         and silently drops `globals`
//   4. web only           react-hooks and jsx-a11y (never applied to server, shared or e2e)
//   5. relaxations        test files only (the config-file entry is absent because nothing needs it)
//   6. local rules        eslint-rules/: one entry per rule file, scoped by the rule's own `scope`
//                         export (the loader builds the entries; a new rule is a new file, this
//                         file does not change)
//   7. eslint-config-prettier last, so formatting rules never fight Prettier
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
import { configs as localRuleConfigs } from './eslint-rules/index.js';

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    // Build output and coverage reports sit directly in the root or in a package, never deeper.
    'dist/**',
    'coverage/**',
    'apps/*/dist/**',
    'apps/*/coverage/**',
    'packages/*/dist/**',
    'packages/*/coverage/**',
    // The router generator writes this file and opens it with a bare eslint-disable comment.
    'apps/web/src/routeTree.gen.ts',
    // Playwright output.
    'e2e/playwright-report/**',
    'e2e/test-results/**',
    'e2e/blob-report/**',
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
  // espree reads JSX only when it is told to, and no default pattern of ESLint matches *.jsx.
  { files: ['**/*.jsx'], languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } },
  {
    files: ['apps/web/{src,public}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    languageOptions: { globals: globals.browser },
  },
  { files: ['packages/shared/**/*.ts'], languageOptions: { globals: globals.es2021 } },

  {
    files: ['apps/web/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    extends: [reactHooks.configs.flat.recommended],
  },
  { files: ['apps/web/**/*.{tsx,jsx}'], extends: [jsxA11y.flatConfigs.recommended] },

  {
    files: ['**/*.test.{ts,tsx}', 'e2e/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  ...localRuleConfigs,

  prettier,
]);
