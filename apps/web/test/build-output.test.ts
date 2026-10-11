/// <reference types="node" />
//
// BUILD OUTPUT (FR-A-095 client part, FR-A-123 preload, FR-A-155, FR-A-158; PD-15; plan 8.2; C8;
// T-A-164; E-18).
//
// Runs the real `vite build` of this package into a temporary directory, once, and reads what came
// out. The HTML file is a template that the server fills per request (C8): this test proves the
// template is shaped the way the server's single regex pass expects, that every tag the browser will
// execute or fetch carries the nonce placeholder, that the critical CSS and the boot script are
// inline, that only the Latin Inter file is preloaded, that the lazy routes are chunks of their own,
// and that the precompressed siblings exist.
import { expectGuardFails } from '@m365portal/shared/testing';
import { build } from 'vite';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileBootScript } from '../build/plugins/nonce-inline';

const WEB_ROOT = join(import.meta.dirname, '..');

// Inside the package, in a place git ignores (node_modules), like styles.test.ts does.
const SCRATCH_ROOT = join(WEB_ROOT, 'node_modules', '.tmp');
let outDir = '';

// ---------------------------------------------------------------------------------------------
// The contract the server fills (C8)
// ---------------------------------------------------------------------------------------------

const NONCE = '__M365_NONCE__';
/** Placeholders that occur exactly once in the template. The nonce is on every tag instead. */
const ONCE_PLACEHOLDERS = [
  '__M365_TITLE__',
  '__M365_THEME_CSS__',
  '__M365_ICON_LINKS__',
  '__M365_THEME_COLOR__',
  '__M365_BOOT_JSON__',
] as const;

// ---------------------------------------------------------------------------------------------
// Small HTML helpers (the template is machine-written: tags are on one line each)
// ---------------------------------------------------------------------------------------------

interface Tag {
  readonly name: string;
  readonly text: string;
  readonly attributes: ReadonlyMap<string, string>;
  /** Index of the tag in the document. */
  readonly index: number;
}

function attributesOf(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of text.matchAll(/\s([a-zA-Z:-]+)(?:="([^"]*)")?/g)) {
    attributes.set(match[1] ?? '', match[2] ?? '');
  }
  return attributes;
}

function tagsOf(html: string, names: readonly string[]): Tag[] {
  const pattern = new RegExp(`<(${names.join('|')})\\b[^>]*>`, 'g');
  return [...html.matchAll(pattern)].map((match) => ({
    name: match[1] ?? '',
    text: match[0],
    attributes: attributesOf(match[0]),
    index: match.index,
  }));
}

/** The text between a tag and its closing tag, for <style> and <script>. */
function contentAfter(html: string, tag: Tag): string {
  const start = tag.index + tag.text.length;
  const end = html.indexOf(`</${tag.name}>`, start);
  return html.slice(start, end);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------------------------
// Files of the build
// ---------------------------------------------------------------------------------------------

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

interface ManifestChunk {
  readonly file: string;
  readonly src?: string;
  readonly isEntry?: boolean;
  readonly isDynamicEntry?: boolean;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
}
type Manifest = Readonly<Record<string, ManifestChunk>>;

/** The keys of the chunks the entry chunk imports with a static `import`, transitively. */
function staticClosure(manifest: Manifest, from: string): Set<string> {
  const seen = new Set<string>();
  const visit = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    for (const next of manifest[key]?.imports ?? []) visit(next);
  };
  visit(from);
  return seen;
}

/** Routes that are not lazy chunks: the Dashboard, the No-access page and the root (FR-A-158). */
const EAGER_ROUTES = new Set(['__root', 'index', 'no-access']);

/** The route files of src/routes, as the route names a person would use (`settings.appearance`). */
function lazyRouteFiles(): string[] {
  const directory = join(WEB_ROOT, 'src', 'routes');
  return readdirSync(directory)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => name.replace(/\.tsx?$/, ''))
    .filter((name) => !EAGER_ROUTES.has(name) && !name.startsWith('-'));
}

/**
 * The guard behind "every lazy route is its own chunk that the entry does not import": throws,
 * listing every route that has no chunk of its own or that the entry chunk pulls in statically.
 */
function assertRoutesAreLazyChunks(input: {
  readonly manifest: Manifest;
  readonly routes: readonly string[];
}): void {
  const { manifest, routes } = input;
  const entryKey = Object.keys(manifest).find((key) => manifest[key]?.isEntry === true);
  if (entryKey === undefined) throw new Error('the build has no entry chunk');
  const inEntry = staticClosure(manifest, entryKey);

  const problems: string[] = [];
  for (const route of routes) {
    const marker = `src/routes/${route}.tsx`;
    const keys = Object.keys(manifest).filter((key) => {
      const chunk = manifest[key];
      return key.includes(marker) || (chunk?.src?.includes(marker) ?? false);
    });
    if (keys.length === 0) {
      problems.push(`route ${route}: no chunk of its own`);
      continue;
    }
    for (const key of keys) {
      if (inEntry.has(key))
        problems.push(`route ${route}: the entry chunk imports ${key} statically`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
}

// ---------------------------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------------------------

let html = '';
let manifest: Manifest = {};
let files: string[] = [];

beforeAll(async () => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  outDir = mkdtempSync(join(SCRATCH_ROOT, 'build-output-'));
  await build({
    root: WEB_ROOT,
    configFile: join(WEB_ROOT, 'vite.config.ts'),
    logLevel: 'silent',
    build: { outDir, emptyOutDir: true, manifest: true },
  });
  html = readFileSync(join(outDir, 'index.html'), 'utf8');
  manifest = JSON.parse(readFileSync(join(outDir, '.vite', 'manifest.json'), 'utf8')) as Manifest;
  files = filesUnder(outDir);
}, 180_000);

afterAll(() => {
  if (outDir !== '') rmSync(outDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// The placeholders
// ---------------------------------------------------------------------------------------------

describe('the HTML template (C8)', () => {
  it('holds each of the five value placeholders exactly once', () => {
    for (const placeholder of ONCE_PLACEHOLDERS) {
      expect(occurrences(html, placeholder), placeholder).toBe(1);
    }
  });

  it('puts every placeholder where the server fills it: text, attribute or markup', () => {
    expect(html).toMatch(/<title>__M365_TITLE__<\/title>/);
    expect(html).toMatch(/<meta name="theme-color" content="__M365_THEME_COLOR__"\s*\/?>/);
    const themeStyle = tagsOf(html, ['style']).find((tag) =>
      contentAfter(html, tag).includes('__M365_THEME_CSS__'),
    );
    expect(themeStyle?.attributes.get('nonce')).toBe(NONCE);
    expect(contentAfter(html, themeStyle!).trim()).toBe('__M365_THEME_CSS__');
    const boot = tagsOf(html, ['script']).find((tag) => tag.attributes.get('id') === 'm365-boot');
    expect(boot?.attributes.get('type')).toBe('application/json');
    expect(boot?.attributes.get('nonce')).toBe(NONCE);
    expect(contentAfter(html, boot!).trim()).toBe('__M365_BOOT_JSON__');
  });

  it('has no other placeholder-like token the server would not know', () => {
    const known = new Set<string>([NONCE, ...ONCE_PLACEHOLDERS]);
    const found = new Set(html.match(/__M365_[A-Z_]+__/g) ?? []);
    expect([...found].filter((token) => !known.has(token))).toEqual([]);
  });

  it('keeps the document language and viewport', () => {
    expect(html).toMatch(/<html lang="en"/);
    expect(html).toContain('name="viewport"');
    expect(html).toContain('<meta charset="UTF-8"');
  });
});

describe('the nonce', () => {
  it('is on every script, stylesheet, style and preload tag', () => {
    const tags = tagsOf(html, ['script', 'style', 'link']).filter(
      (tag) =>
        tag.name !== 'link' ||
        ['stylesheet', 'preload', 'modulepreload'].includes(tag.attributes.get('rel') ?? ''),
    );

    expect(tags.length).toBeGreaterThanOrEqual(4);
    for (const tag of tags) {
      expect(tag.attributes.get('nonce'), tag.text).toBe(NONCE);
    }
  });

  it('is announced to the page by <meta property="csp-nonce">', () => {
    const meta = tagsOf(html, ['meta']).find(
      (tag) => tag.attributes.get('property') === 'csp-nonce',
    );
    expect(meta?.attributes.get('nonce')).toBe(NONCE);
  });
});

// ---------------------------------------------------------------------------------------------
// Inline code
// ---------------------------------------------------------------------------------------------

describe('the inlined entry CSS (FR-A-158)', () => {
  it('is a <style nonce> in the document and not a stylesheet link', () => {
    expect(
      tagsOf(html, ['link']).filter((tag) => tag.attributes.get('rel') === 'stylesheet'),
    ).toEqual([]);
    const styles = tagsOf(html, ['style']).filter(
      (tag) => !contentAfter(html, tag).includes('__M365_'),
    );
    expect(styles).toHaveLength(1);
    const css = contentAfter(html, styles[0]!);
    expect(css.length).toBeGreaterThan(10_000);
    expect(css).toContain('--surface-page');
    expect(css).toContain('Inter Variable');
  });

  it('references the fonts by absolute path, so it works inline on every route', () => {
    const css = contentAfter(
      html,
      tagsOf(html, ['style']).find((tag) => contentAfter(html, tag).includes('@font-face'))!,
    );
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((match) => match[1] ?? '');
    expect(urls.length).toBeGreaterThanOrEqual(2);
    for (const url of urls) expect(url.replace(/["']/g, ''), url).toMatch(/^\/assets\//);
  });

  it('does not ship the stylesheet file it inlined', () => {
    // `public/offline.css` is the one stylesheet file: the offline page cannot use the inlined one.
    expect(
      files.filter((file) => file.endsWith('.css') && !file.endsWith(`${sep}offline.css`)),
    ).toEqual([]);
  });

  it('is not referenced by any script as a file that is missing', () => {
    const referenced = files
      .filter((file) => file.endsWith('.js'))
      .flatMap((file) => readFileSync(file, 'utf8').match(/assets\/[A-Za-z0-9._-]+\.css/g) ?? []);
    for (const reference of referenced) {
      expect(
        files.some((file) => file.endsWith(reference)),
        reference,
      ).toBe(true);
    }
  });
});

describe('the inlined boot script (plan 8.2)', () => {
  const inlineScripts = () =>
    tagsOf(html, ['script']).filter(
      (tag) => !tag.attributes.has('src') && !tag.attributes.has('type'),
    );

  it('is one classic inline <script nonce> before the style and the entry script', () => {
    const scripts = inlineScripts();
    expect(scripts).toHaveLength(1);
    const boot = scripts[0]!;
    expect(boot.attributes.get('nonce')).toBe(NONCE);

    const firstStyle = tagsOf(html, ['style'])[0]!;
    const entry = tagsOf(html, ['script']).find((tag) => tag.attributes.get('type') === 'module')!;
    expect(boot.index).toBeLessThan(firstStyle.index);
    expect(boot.index).toBeLessThan(entry.index);
  });

  it('is compiled from boot-script.ts: it reads the two keys and sets the three attributes', () => {
    const code = contentAfter(html, inlineScripts()[0]!);

    expect(code).toContain('m365portal.theme');
    expect(code).toContain('m365portal.locale');
    expect(code).toContain('prefers-color-scheme: dark');
    expect(code).toMatch(/dataset\.theme/);
    expect(code).toMatch(/colorScheme/);
    expect(code).toMatch(/\.lang\s*=/);
    // Zod is told not to probe `new Function` before any module (and so any schema) exists (P17).
    expect(code).toContain('__zod_globalConfig');
    expect(code).toContain('jitless');
    expect(code).not.toContain('import ');
    expect(code).not.toContain('__M365_');
  });

  it('is small and imports only the storage keys, the language detection and its types', async () => {
    const compiled = await compileBootScript(WEB_ROOT);

    expect(compiled.code.length).toBeLessThan(1_500);
    expect(
      compiled.inputs.map((input) => input.replace(/^.*\/(?=src\/|\.\.\/)/, '')).sort(),
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/boot\/boot-script\.ts$/),
        expect.stringMatching(/lib\/storage\.ts$/),
        expect.stringMatching(/i18n\/detect\.ts$/),
      ]),
    );
    for (const input of compiled.inputs) {
      expect(input, input).not.toMatch(/node_modules\/(?:react|@tanstack|radix|motion)/);
      expect(input, input).not.toMatch(/locales\/|create-translator|\/theme\.ts|\/locale\.ts/);
    }
    expect(compiled.code).not.toContain('Intl.');
  });
});

// ---------------------------------------------------------------------------------------------
// Fonts (FR-A-123)
// ---------------------------------------------------------------------------------------------

describe('font preload', () => {
  it('preloads the Latin Inter file and nothing else', () => {
    const preloads = tagsOf(html, ['link']).filter(
      (tag) => tag.attributes.get('rel') === 'preload',
    );

    expect(preloads).toHaveLength(1);
    const link = preloads[0]!;
    expect(link.attributes.get('as')).toBe('font');
    expect(link.attributes.get('type')).toBe('font/woff2');
    expect(link.attributes.has('crossorigin')).toBe(true);
    expect(link.attributes.get('href')).toMatch(
      /^\/assets\/inter-latin-wght-normal-[\w-]+\.woff2$/,
    );
    expect(link.attributes.get('nonce')).toBe(NONCE);
  });

  it('ships the Latin-extended file too (for the characters that need it) but does not preload it', () => {
    const emitted = files.map((file) => relative(outDir, file));
    expect(
      emitted.some((file) => /^assets\/inter-latin-ext-wght-normal-[\w-]+\.woff2$/.test(file)),
    ).toBe(true);
    // The @font-face rule in the inlined CSS names it; no <link> does.
    expect(
      tagsOf(html, ['link']).filter((tag) =>
        (tag.attributes.get('href') ?? '').includes('latin-ext'),
      ),
    ).toEqual([]);
    const fontFiles = emitted.filter((file) => file.endsWith('.woff2'));
    expect(fontFiles).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Chunks (FR-A-158)
// ---------------------------------------------------------------------------------------------

describe('route chunks', () => {
  it('makes every route except the Dashboard, No-access and Not-found a chunk of its own, not imported by the entry', () => {
    assertRoutesAreLazyChunks({ manifest, routes: lazyRouteFiles() });
  });

  it('negative fixture: a route the entry imports statically fails the guard', () => {
    const fake: Manifest = {
      'index.html': { file: 'assets/index.js', isEntry: true, imports: ['src/routes/users.tsx'] },
      'src/routes/users.tsx': { file: 'assets/users.js', src: 'src/routes/users.tsx' },
    };

    expectGuardFails(
      assertRoutesAreLazyChunks,
      { manifest: fake, routes: ['users'] },
      {
        name: 'assertRoutesAreLazyChunks',
        reason: 'imports src/routes/users.tsx statically',
      },
    );
  });

  it('negative fixture: a route with no chunk of its own fails the guard', () => {
    const fake: Manifest = {
      'index.html': { file: 'assets/index.js', isEntry: true },
    };

    expectGuardFails(
      assertRoutesAreLazyChunks,
      { manifest: fake, routes: ['users'] },
      {
        name: 'assertRoutesAreLazyChunks',
        reason: 'route users: no chunk of its own',
      },
    );
  });

  it('has an entry chunk', () => {
    expect(Object.values(manifest).filter((chunk) => chunk.isEntry === true)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Precompression (plan 7.5)
// ---------------------------------------------------------------------------------------------

describe('precompressed siblings', () => {
  const COMPRESSIBLE = /\.(?:js|css|svg|json|html)$/;
  const originals = () =>
    files.filter((file) => COMPRESSIBLE.test(file)).filter((file) => !/\.(?:br|gz)$/.test(file));

  it('exist as .br and .gz for every js, css, svg, json and html file', () => {
    const sources = originals();
    expect(sources.map((file) => relative(outDir, file))).toEqual(
      expect.arrayContaining(['index.html']),
    );
    for (const file of sources) {
      expect(files, `${file}.br`).toContain(`${file}.br`);
      expect(files, `${file}.gz`).toContain(`${file}.gz`);
    }
  });

  it('decompress to the original bytes', () => {
    for (const file of originals()) {
      const original = readFileSync(file);
      expect(brotliDecompressSync(readFileSync(`${file}.br`)).equals(original), `${file}.br`).toBe(
        true,
      );
      expect(gunzipSync(readFileSync(`${file}.gz`)).equals(original), `${file}.gz`).toBe(true);
    }
  });

  it('are not made for fonts, which are compressed already, or for the siblings themselves', () => {
    expect(files.filter((file) => /\.woff2\.(?:br|gz)$/.test(file))).toEqual([]);
    expect(files.filter((file) => /\.(?:br|gz)\.(?:br|gz)$/.test(file))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The service worker and the offline page (FR-A-140, T-A-171)
// ---------------------------------------------------------------------------------------------

describe('the service worker', () => {
  const version = readFileSync(join(WEB_ROOT, '..', '..', 'VERSION'), 'utf8').trim();
  const worker = () => readFileSync(join(outDir, 'sw.js'), 'utf8');

  it('is emitted as /sw.js at the root, unhashed, with its compressed siblings', () => {
    expect(files).toContain(join(outDir, 'sw.js'));
    expect(files).toContain(join(outDir, 'sw.js.br'));
    expect(files).toContain(join(outDir, 'sw.js.gz'));
    expect(files.filter((file) => /sw-[\w-]+\.js$/.test(file))).toEqual([]);
  });

  it('carries the product version, so a new version changes the bytes and the cache names', () => {
    const text = worker();
    expect(text).not.toContain('__APP_VERSION__');
    expect(text).toContain(JSON.stringify(version));
    expect(text).toContain('m365portal-static-');
    expect(text).toContain('m365portal-offline-');
  });

  it('is one classic script: no import, no export, no reference to a source map', () => {
    const text = worker();
    expect(text).not.toMatch(/^\s*(?:import|export)\s/m);
    expect(text).not.toMatch(/\bimport\s*\(/);
    expect(text).not.toMatch(/sourceMappingURL/);
  });

  it('has the routing patterns and the update message, and knows no API path to cache', () => {
    const text = worker();
    expect(text).toContain('SKIP_WAITING');
    expect(text).toContain('/offline.html');
    expect(text).toMatch(/\^\\\/assets\\\//);
  });

  it('is not part of the app: no page script refers to it by import', () => {
    for (const file of files.filter((candidate) => /\/assets\/[^/]+\.js$/.test(candidate))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/from\s*["'][^"']*sw\.js["']/);
    }
  });
});

describe('the offline page', () => {
  it('is copied unchanged to the root, with its stylesheet and script', () => {
    for (const name of ['offline.html', 'offline.css', 'offline.js']) {
      expect(files, name).toContain(join(outDir, name));
      expect(readFileSync(join(outDir, name), 'utf8'), name).toBe(
        readFileSync(join(WEB_ROOT, 'public', name), 'utf8'),
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------
// No external URL, a message without JavaScript
// ---------------------------------------------------------------------------------------------

describe('what the page loads', () => {
  it('contains no absolute or protocol-relative URL in the HTML, and none in the CSS it inlines', () => {
    expect(html).not.toMatch(/(?:src|href|action|poster)="(?:[a-z][a-z0-9+.-]*:)?\/\//i);
    expect(html).not.toMatch(/url\(\s*["']?(?:https?:)?\/\//i);
    expect(html).not.toMatch(/@import\s+(?:url\()?["']?(?:https?:)?\/\//i);
  });

  it('contains no absolute URL that a script or a stylesheet would load', () => {
    for (const file of files.filter((candidate) => /\.(?:js|css)$/.test(candidate))) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/url\(\s*["']?https?:\/\//i);
      expect(text, file).not.toMatch(/@import\s+(?:url\()?["']?https?:\/\//i);
      expect(text, file).not.toMatch(/import\(\s*["']https?:\/\//i);
    }
  });

  it('says in Dutch and in English that JavaScript is needed', () => {
    const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(html)?.[1] ?? '';

    expect(noscript).toMatch(/lang="nl"[^>]*>[^<]*JavaScript[^<]*</);
    expect(noscript).toMatch(/lang="en"[^>]*>[^<]*JavaScript[^<]*</);
    expect(noscript).not.toMatch(/<script|style=/);
  });
});
