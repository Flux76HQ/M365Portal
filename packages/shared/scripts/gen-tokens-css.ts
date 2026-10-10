// `pnpm tokens:generate` writes apps/web/src/styles/tokens.generated.css from the token modules;
// `pnpm tokens:check` (the same with --check) fails when the committed file is stale or missing.
//
//   tsx scripts/gen-tokens-css.ts [--check] [--file <path>]
//
// `--file` points at another stylesheet; the tests use it to prove the check fails on a stale copy.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTokensStylesheet } from '../src/tokens/css.js';

const defaultTarget = fileURLToPath(
  new URL('../../../apps/web/src/styles/tokens.generated.css', import.meta.url),
);

const args = process.argv.slice(2);
const check = args.includes('--check');
const fileIndex = args.indexOf('--file');
const fileArgument = fileIndex >= 0 ? args[fileIndex + 1] : undefined;
if (fileIndex >= 0 && (fileArgument === undefined || fileArgument.startsWith('--'))) {
  console.error('tokens: --file needs a path');
  process.exit(2);
}
const target = fileArgument === undefined ? defaultTarget : resolve(fileArgument);
const expected = renderTokensStylesheet();

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The first line at which two texts differ, 1-based. */
function firstDifference(actual: string, wanted: string): number {
  const actualLines = actual.split('\n');
  const wantedLines = wanted.split('\n');
  const length = Math.max(actualLines.length, wantedLines.length);
  for (let index = 0; index < length; index += 1) {
    if (actualLines[index] !== wantedLines[index]) return index + 1;
  }
  return 0;
}

if (check) {
  const actual = readIfPresent(target);
  if (actual === undefined) {
    console.error(`tokens: ${target} is missing; run pnpm tokens:generate`);
    process.exitCode = 1;
  } else if (actual !== expected) {
    console.error(
      `tokens: ${target} is stale (first difference at line ${String(firstDifference(actual, expected))}); run pnpm tokens:generate`,
    );
    process.exitCode = 1;
  } else {
    console.log('tokens: tokens.generated.css is up to date');
  }
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, expected);
  console.log(`tokens: wrote ${target}`);
}
