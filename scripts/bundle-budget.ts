// BUNDLE BUDGET (FR-A-155, plan 14.1, T-A-259). Reads the production build of the web app
// (apps/web/dist) and compares three numbers with scripts/bundle-budget.json:
//
//   initialJsGzipBytes       every JavaScript file the first HTML response makes the browser load
//                            (the module entry plus its modulepreload chunks), gzip level 9, summed;
//   entryCssRawBytes         the entry CSS, raw: every inline <style> block of index.html plus any
//                            linked stylesheet file;
//   firstLoadBrotliBytes     what a first visit to `/` transfers: the HTML, the linked CSS and the
//                            initial JavaScript, Brotli quality 11 (the build's own precompression),
//                            plus the preloaded font as shipped (woff2 is already compressed).
//
// The budget only ratchets DOWN: with a base ref (BUNDLE_BUDGET_BASE_REF, `--base-ref`, or the
// GITHUB_BASE_REF of a pull request) the budget file is compared with the base's copy, and any value
// that went up fails. Lazy route chunks are not part of the first load and are not measured here.
//
// Usage: pnpm bundle:check [--dist apps/web/dist] [--budget scripts/bundle-budget.json]
//                          [--base-ref origin/main] [--print]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

export const METRICS = ['initialJsGzipBytes', 'entryCssRawBytes', 'firstLoadBrotliBytes'] as const;
export type Metric = (typeof METRICS)[number];
export type Measurement = Record<Metric, number>;

export interface Budget extends Measurement {
  // Free text for people (the spec targets and how the numbers were calibrated); never compared.
  note?: string;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const REMEDIATION: Record<Metric, string> = {
  initialJsGzipBytes:
    'Move code out of the entry: lazy-load route components and heavy libraries (plan 14.2), import Radix and icons by path, and check with `pnpm build` that no large module landed in a modulepreload chunk.',
  entryCssRawBytes:
    'Trim the entry CSS: no unused utility layers, no duplicated tokens, no CSS that only one route needs (it belongs to that route chunk).',
  firstLoadBrotliBytes:
    'Reduce what `/` transfers on a first visit: HTML (inline data), initial JavaScript and the preloaded font; plan 14.2 lists the tactics in order.',
};

export function gzipSize(data: Buffer): number {
  return gzipSync(data, { level: 9 }).length;
}

export function brotliSize(data: Buffer): number {
  return brotliCompressSync(data, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  }).length;
}

function attributes(tag: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of tag.matchAll(/([a-zA-Z:-]+)(?:="([^"]*)")?/g)) {
    result.set(match[1] ?? '', match[2] ?? '');
  }
  return result;
}

interface Assets {
  scripts: string[];
  stylesheets: string[];
  fonts: string[];
  inlineCss: string[];
}

export function findAssets(html: string): Assets {
  const assets: Assets = { scripts: [], stylesheets: [], fonts: [], inlineCss: [] };
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
    assets.inlineCss.push(match[1] ?? '');
  }
  for (const match of html.matchAll(/<(script|link)\b([^>]*)>/g)) {
    const tag = match[1];
    const attrs = attributes(match[2] ?? '');
    const target = attrs.get('src') ?? attrs.get('href');
    if (!target?.startsWith('/')) continue;
    if (tag === 'script' && attrs.get('type') === 'module') assets.scripts.push(target);
    if (tag === 'link') {
      const rel = attrs.get('rel');
      if (rel === 'modulepreload') assets.scripts.push(target);
      else if (rel === 'stylesheet') assets.stylesheets.push(target);
      else if (rel === 'preload' && attrs.get('as') === 'font') assets.fonts.push(target);
    }
  }
  assets.scripts = [...new Set(assets.scripts)];
  return assets;
}

function readAsset(distDir: string, urlPath: string): Buffer {
  const file = join(distDir, urlPath.split('?')[0] ?? urlPath);
  if (!existsSync(file)) {
    throw new Error(
      `${urlPath} is referenced by index.html but missing from ${distDir}: run pnpm build first`,
    );
  }
  return readFileSync(file);
}

export function measure(distDir: string): Measurement {
  const indexFile = join(distDir, 'index.html');
  if (!existsSync(indexFile)) {
    throw new Error(
      `${indexFile} is missing: run pnpm build first (the budget reads the real build)`,
    );
  }
  const html = readFileSync(indexFile);
  const assets = findAssets(html.toString('utf8'));
  if (assets.scripts.length === 0) {
    throw new Error('index.html references no module script: the build output is not a Vite build');
  }
  const scripts = assets.scripts.map((path) => readAsset(distDir, path));
  const stylesheets = assets.stylesheets.map((path) => readAsset(distDir, path));
  const fonts = assets.fonts.map((path) => readAsset(distDir, path));

  const initialJsGzipBytes = scripts.reduce((sum, file) => sum + gzipSize(file), 0);
  const entryCssRawBytes =
    assets.inlineCss.reduce((sum, css) => sum + Buffer.byteLength(css), 0) +
    stylesheets.reduce((sum, file) => sum + file.length, 0);
  const firstLoadBrotliBytes =
    brotliSize(html) +
    stylesheets.reduce((sum, file) => sum + brotliSize(file), 0) +
    scripts.reduce((sum, file) => sum + brotliSize(file), 0) +
    fonts.reduce((sum, file) => sum + file.length, 0);
  return { initialJsGzipBytes, entryCssRawBytes, firstLoadBrotliBytes };
}

export function parseBudget(text: string, source: string): Budget {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  for (const metric of METRICS) {
    const value = record[metric];
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`${source}: ${metric} must be a positive integer number of bytes`);
    }
  }
  return record as unknown as Budget;
}

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/** Problems of a measurement against the budget; an empty list means within budget. */
export function overBudget(measured: Measurement, budget: Budget): string[] {
  const problems: string[] = [];
  for (const metric of METRICS) {
    if (measured[metric] > budget[metric]) {
      problems.push(
        `${metric}: ${String(measured[metric])} B (${kib(measured[metric])}) is over the budget of ` +
          `${String(budget[metric])} B (${kib(budget[metric])}). ${REMEDIATION[metric]}`,
      );
    }
  }
  return problems;
}

/** Problems of the budget file against the base ref's copy: any value that went up fails. */
export function ratchetViolations(current: Budget, base: Budget): string[] {
  const problems: string[] = [];
  for (const metric of METRICS) {
    if (current[metric] > base[metric]) {
      problems.push(
        `${metric}: the budget went up from ${String(base[metric])} B to ${String(current[metric])} B. ` +
          'The budget only ratchets down: reduce the bundle instead of raising the number.',
      );
    }
  }
  return problems;
}

function resolveBaseRef(explicit: string | undefined): string | undefined {
  if (explicit) return explicit;
  const fromEnvironment = process.env.BUNDLE_BUDGET_BASE_REF;
  if (fromEnvironment) return fromEnvironment;
  const pullRequestBase = process.env.GITHUB_BASE_REF;
  return pullRequestBase ? `origin/${pullRequestBase}` : undefined;
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', stdio: 'pipe' });
}

/** The budget file at the base ref, or undefined when the base does not have one yet. */
function baseBudget(ref: string): Budget | undefined {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    // A shallow pull-request checkout has no base commit: fetch just that one.
    const branch = ref.replace(/^origin\//, '');
    try {
      git(['fetch', '--no-tags', '--depth=1', 'origin', branch]);
    } catch {
      throw new Error(
        `cannot resolve the base ref ${ref} (shallow checkout?): fetch it or use fetch-depth: 0`,
      );
    }
  }
  let text: string;
  try {
    text = git(['show', `${ref}:scripts/bundle-budget.json`]);
  } catch {
    return undefined;
  }
  return parseBudget(text, `${ref}:scripts/bundle-budget.json`);
}

interface Options {
  dist: string;
  budget: string;
  baseRef: string | undefined;
  print: boolean;
}

function parseArguments(argv: string[]): Options {
  const options: Options = {
    dist: join(repositoryRoot, 'apps', 'web', 'dist'),
    budget: join(repositoryRoot, 'scripts', 'bundle-budget.json'),
    baseRef: undefined,
    print: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--print') options.print = true;
    else if (flag === '--dist' && value) {
      options.dist = resolve(value);
      index += 1;
    } else if (flag === '--budget' && value) {
      options.budget = resolve(value);
      index += 1;
    } else if (flag === '--base-ref' && value) {
      options.baseRef = value;
      index += 1;
    } else throw new Error(`unknown or incomplete argument ${String(flag)}`);
  }
  return options;
}

export function main(argv: string[]): number {
  const options = parseArguments(argv);
  const measured = measure(options.dist);
  for (const metric of METRICS) {
    console.log(`${metric}: ${String(measured[metric])} B (${kib(measured[metric])})`);
  }
  if (options.print) return 0;

  const budget = parseBudget(readFileSync(options.budget, 'utf8'), options.budget);
  const problems = overBudget(measured, budget);

  const baseRef = resolveBaseRef(options.baseRef);
  if (baseRef) {
    const base = baseBudget(baseRef);
    if (base) problems.push(...ratchetViolations(budget, base));
    else console.log(`ratchet: ${baseRef} has no bundle budget yet, nothing to compare`);
  } else {
    console.log('ratchet: no base ref (set BUNDLE_BUDGET_BASE_REF or pass --base-ref); skipped');
  }

  for (const problem of problems) console.error(`bundle budget: ${problem}`);
  if (problems.length === 0) console.log('bundle budget: within budget');
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`bundle budget: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
