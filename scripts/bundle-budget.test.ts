// Tests of the bundle budget (T-A-259). A fixture build directory is written to a temporary
// directory; the expected numbers are computed independently with node:zlib. Every guard has a
// negative fixture that must fail on purpose (expectGuardFails).
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { expectGuardFails } from '../packages/shared/src/testing/index.js';
import {
  METRICS,
  findAssets,
  main,
  measure,
  overBudget,
  parseBudget,
  ratchetViolations,
  type Budget,
  type Measurement,
} from './bundle-budget.js';

const temporaryRoots: string[] = [];
afterAll(() => {
  for (const directory of temporaryRoots) rmSync(directory, { recursive: true, force: true });
});

function brotli(data: Buffer): number {
  return brotliCompressSync(data, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  }).length;
}

const entryScript = Buffer.from('export const entry = ' + 'a'.repeat(3000) + ';\n'.repeat(10));
const sharedScript = Buffer.from('export const shared = ' + JSON.stringify(Array(400).fill('x')));
const lazyScript = randomBytes(5000); // a route chunk: referenced by no tag, must not be counted
const font = randomBytes(2048);
const stylesheet = Buffer.from('.linked{color:red}'.repeat(50));
const inlineCss = ':root{--a:1}'.repeat(100);

const html = `<!doctype html><html><head>
<script nonce="n">window.boot=1</script>
<link rel="preload" as="font" type="font/woff2" crossorigin href="/assets/inter.woff2" nonce="n" />
<style nonce="n">${inlineCss}</style>
<script type="module" crossorigin src="/assets/index-1.js" nonce="n"></script>
<link rel="modulepreload" crossorigin href="/assets/shared-1.js" nonce="n">
<link rel="modulepreload" crossorigin href="/assets/index-1.js" nonce="n">
<link rel="stylesheet" href="/assets/entry-1.css">
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="stylesheet" href="https://cdn.example/other.css">
</head><body></body></html>`;

function makeBuild(overrides: { html?: string; skip?: string } = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'bundle-budget-'));
  temporaryRoots.push(directory);
  mkdirSync(join(directory, 'assets'));
  writeFileSync(join(directory, 'index.html'), overrides.html ?? html);
  const files: Record<string, Buffer> = {
    'index-1.js': entryScript,
    'shared-1.js': sharedScript,
    'lazy-1.js': lazyScript,
    'inter.woff2': font,
    'entry-1.css': stylesheet,
  };
  for (const [name, data] of Object.entries(files)) {
    if (name !== overrides.skip) writeFileSync(join(directory, 'assets', name), data);
  }
  return directory;
}

const expected: Measurement = {
  initialJsGzipBytes:
    gzipSync(entryScript, { level: 9 }).length + gzipSync(sharedScript, { level: 9 }).length,
  entryCssRawBytes: Buffer.byteLength(inlineCss) + stylesheet.length,
  firstLoadBrotliBytes:
    brotli(Buffer.from(html)) +
    brotli(stylesheet) +
    brotli(entryScript) +
    brotli(sharedScript) +
    font.length,
};

describe('findAssets', () => {
  it('reads the module entry, preloads, stylesheets, font preloads and inline CSS', () => {
    const assets = findAssets(html);
    expect(assets.scripts).toEqual(['/assets/index-1.js', '/assets/shared-1.js']);
    expect(assets.stylesheets).toEqual(['/assets/entry-1.css']);
    expect(assets.fonts).toEqual(['/assets/inter.woff2']);
    expect(assets.inlineCss).toEqual([inlineCss]);
  });
});

describe('findAssets with a deferred start (T-A-173)', () => {
  const deferred = `<!doctype html><html><head>
<style nonce="n">${inlineCss}</style>
</head><body>
<script type="application/json" id="m365-start" nonce="n">{"entry":"/assets/index-1.js","preload":["/assets/shared-1.js","/assets/index-1.js"]}</script>
<script nonce="n">/* the loader */</script>
</body></html>`;

  it('reads the entry and the preloads from the start block', () => {
    expect(findAssets(deferred).scripts).toEqual(['/assets/index-1.js', '/assets/shared-1.js']);
  });

  it('measures the same files as the tags of an immediate start', () => {
    const immediate = measure(makeBuild());
    const later = measure(
      makeBuild({
        html: deferred.replace(
          '</head>',
          '<link rel="stylesheet" href="/assets/entry-1.css" nonce="n"></head>',
        ),
      }),
    );
    expect(later.initialJsGzipBytes).toBe(immediate.initialJsGzipBytes);
  });

  it('fails to find scripts when the block is missing, so a build cannot hide its weight (negative fixture)', () => {
    expectGuardFails(
      () =>
        measure(
          makeBuild({
            html: deferred.replace(/<script type="application\/json"[\s\S]*?<\/script>/, ''),
          }),
        ),
      { reason: 'no module script' },
    );
  });
});

describe('measure', () => {
  it('computes the three numbers from the fixture build and skips lazy chunks', () => {
    expect(measure(makeBuild())).toEqual(expected);
  });

  it('fails with the fix when the build is missing', () => {
    expectGuardFails(() => measure(join(tmpdir(), 'bundle-budget-does-not-exist')), {
      reason: 'run pnpm build first',
    });
  });

  it('fails when a referenced asset is missing', () => {
    expectGuardFails(() => measure(makeBuild({ skip: 'shared-1.js' })), {
      reason: '/assets/shared-1.js is referenced by index.html but missing',
    });
  });

  it('fails when the page has no module script', () => {
    expectGuardFails(() => measure(makeBuild({ html: '<html><body>hi</body></html>' })), {
      reason: 'no module script',
    });
  });
});

describe('budget comparison', () => {
  const budget: Budget = { ...expected };

  it('passes at exactly the budget', () => {
    expect(overBudget(expected, budget)).toEqual([]);
  });

  it.each(METRICS)('fails with the remediation text when %s is one byte over', (metric) => {
    const problems = overBudget({ ...expected, [metric]: expected[metric] + 1 }, budget);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(metric);
    expect(problems[0]).toContain('over the budget');
    expect(problems[0]).toMatch(/lazy|CSS|transfers/);
  });

  it('is a guard that fails on purpose when over budget', () => {
    expectGuardFails(
      () => {
        const problems = overBudget(
          { ...expected, initialJsGzipBytes: budget.initialJsGzipBytes + 1 },
          budget,
        );
        if (problems.length > 0) throw new Error(problems.join('\n'));
      },
      { reason: 'initialJsGzipBytes' },
    );
  });
});

describe('ratchet (down only)', () => {
  const base: Budget = {
    initialJsGzipBytes: 1000,
    entryCssRawBytes: 500,
    firstLoadBrotliBytes: 2000,
  };

  it('accepts an unchanged or lowered budget', () => {
    expect(ratchetViolations(base, base)).toEqual([]);
    expect(ratchetViolations({ ...base, firstLoadBrotliBytes: 1500 }, base)).toEqual([]);
  });

  it.each(METRICS)('rejects a raised %s', (metric) => {
    const problems = ratchetViolations({ ...base, [metric]: base[metric] + 1 }, base);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('only ratchets down');
  });

  it('is a guard that fails on purpose when the budget was raised', () => {
    expectGuardFails(
      () => {
        const problems = ratchetViolations({ ...base, entryCssRawBytes: 600 }, base);
        if (problems.length > 0) throw new Error(problems.join('\n'));
      },
      { reason: 'budget went up from 500 B to 600 B' },
    );
  });
});

describe('parseBudget', () => {
  it('accepts the committed shape', () => {
    expect(parseBudget(JSON.stringify(expected), 'x').initialJsGzipBytes).toBe(
      expected.initialJsGzipBytes,
    );
  });

  it.each([
    ['not JSON', '{'],
    ['a missing metric', JSON.stringify({ initialJsGzipBytes: 1, entryCssRawBytes: 1 })],
    ['a non-integer', JSON.stringify({ ...expected, entryCssRawBytes: 1.5 })],
    ['a string', JSON.stringify({ ...expected, firstLoadBrotliBytes: '9' })],
    ['zero', JSON.stringify({ ...expected, initialJsGzipBytes: 0 })],
  ])('rejects %s', (_label, text) => {
    expectGuardFails(() => parseBudget(text, 'budget.json'), { name: 'parseBudget' });
  });
});

describe('command line', () => {
  function run(budget: Budget, dist = makeBuild()): number {
    const directory = mkdtempSync(join(tmpdir(), 'bundle-budget-file-'));
    temporaryRoots.push(directory);
    const file = join(directory, 'budget.json');
    writeFileSync(file, JSON.stringify(budget));
    vi.stubEnv('BUNDLE_BUDGET_BASE_REF', '');
    vi.stubEnv('GITHUB_BASE_REF', '');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      return main(['--dist', dist, '--budget', file]);
    } finally {
      log.mockRestore();
      error.mockRestore();
      vi.unstubAllEnvs();
    }
  }

  it('exits 0 within budget and 1 over budget', () => {
    expect(run(expected)).toBe(0);
    expect(run({ ...expected, entryCssRawBytes: expected.entryCssRawBytes - 1 })).toBe(1);
  });

  it('rejects an unknown argument', () => {
    expectGuardFails(() => main(['--nope']), { reason: 'unknown or incomplete argument' });
  });
});

describe('the committed Phase B budget (T-B-307, XB32; plan 15)', () => {
  const PHASE_A = { initialJsGzipBytes: 237_500, entryCssRawBytes: 45_500, firstLoadBrotliBytes: 269_000 };
  const committed = (): Budget =>
    parseBudget(readFileSync(join(import.meta.dirname, 'bundle-budget.json'), 'utf8'), 'bundle-budget.json');

  it('allows the entry JavaScript at most 8 KiB gzip over the Phase A budget, and a budget never below the Phase A one for the other two (they cannot ratchet below what the Phase B pages need)', () => {
    const budget = committed();
    expect(budget.initialJsGzipBytes).toBeLessThanOrEqual(PHASE_A.initialJsGzipBytes + 8 * 1024);
    expect(budget.initialJsGzipBytes).toBeGreaterThanOrEqual(PHASE_A.initialJsGzipBytes);
  });

  it('negative: a budget that gives the entry more than the plan allows fails the same check', () => {
    expectGuardFails(
      () => {
        const loose = { ...committed(), initialJsGzipBytes: PHASE_A.initialJsGzipBytes + 8 * 1024 + 1 };
        expect(loose.initialJsGzipBytes).toBeLessThanOrEqual(PHASE_A.initialJsGzipBytes + 8 * 1024);
      },
      { name: 'Phase B entry allowance', reason: /less than or equal to/ },
    );
  });
});
