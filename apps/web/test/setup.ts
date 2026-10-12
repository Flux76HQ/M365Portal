import '@testing-library/jest-dom/vitest';
import { LAZY_NAMESPACES, LOCALES, loadNamespace } from '@m365portal/shared/i18n';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// The lazy catalogues are loaded by the route loaders in the application. A test renders a page by its text, so
// every namespace is loaded up front; `test/lazy-namespaces.test.ts` proves that each route asks for its own.
// (Top-level, so that the text exists while a test file is collected as well as while it runs.)
for (const namespace of LAZY_NAMESPACES) {
  for (const locale of LOCALES) await loadNamespace(locale, namespace);
}

afterEach(() => {
  cleanup();
});
