import { readFileSync } from 'node:fs';

/**
 * Injected by esbuild (`define`, see build.mjs) from the repository's VERSION file. It does not
 * exist under tsx (dev) or Vitest, where the VERSION file is read directly at startup instead.
 */
declare const __APP_VERSION__: string | undefined;

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** Validate and normalise the content of a VERSION file. Throws when it is not MAJOR.MINOR.PATCH. */
export function parseVersion(raw: string): string {
  const version = raw.trim();
  if (!VERSION_PATTERN.test(version)) {
    throw new Error('VERSION must contain MAJOR.MINOR.PATCH');
  }
  return version;
}

function resolveVersion(): string {
  if (typeof __APP_VERSION__ === 'string') return parseVersion(__APP_VERSION__);
  // src/version.ts -> apps/server/src -> repository root
  return parseVersion(readFileSync(new URL('../../../VERSION', import.meta.url), 'utf8'));
}

export const APP_VERSION: string = resolveVersion();
