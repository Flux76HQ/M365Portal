// @vitest-environment node
/// <reference types="node" />
//
// NO INLINE-STYLE SINK IN A DEPENDENCY (plan 8.1: `style-src 'self' 'nonce-...'` and
// `require-trusted-types-for 'script'`; chunk-s4c OP-1).
//
// Radix Select 2.3.8 rendered `<style dangerouslySetInnerHTML>` in its Viewport. Under Trusted Types that
// assignment throws ("TrustedHTML assignment") and the route lands in the error boundary; happy-dom
// cannot see it, so this test reads the SOURCE of every Radix package whose namespace the app imports.
// It fails on `dangerouslySetInnerHTML`, `innerHTML =` and on a `<style>` element that is created
// without a nonce. The fix is the pnpm patch under `patches/` plus the same rule in `styles/app.css`.
// The proof in a real browser (0 securitypolicyviolation events with the production CSP) is in the
// chunk note; this test keeps the regression from coming back with a dependency upgrade.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const require = createRequire(join(webRoot, 'package.json'));

/** Findings in the text of one built file; each is a Trusted Types sink or a nonce-less style. */
function findStyleSinks(source: string): readonly string[] {
  const findings: string[] = [];
  if (/dangerouslySetInnerHTML/.test(source)) findings.push('dangerouslySetInnerHTML');
  if (/\.innerHTML\s*=[^=]/.test(source)) findings.push('innerHTML assignment');
  if (/\.insertAdjacentHTML\(/.test(source)) findings.push('insertAdjacentHTML');
  // A style element made by hand must be given a nonce in the same file.
  if (
    /createElement\(\s*["']style["']\s*\)/.test(source) &&
    !/\.nonce\s*=|setAttribute\(\s*["']nonce["']/.test(source)
  ) {
    findings.push('style element without a nonce');
  }
  // JSX: <style> rendered by a component needs a nonce prop.
  if (/jsxs?\(\s*["']style["']\s*,\s*\{(?![^}]*nonce)/.test(source)) {
    findings.push('rendered <style> without a nonce');
  }
  return findings;
}

function radixPackageDirs(): Map<string, string> {
  const radixUiDir = dirname(require.resolve('radix-ui/package.json'));
  const radixRequire = createRequire(join(radixUiDir, 'package.json'));
  const manifest = JSON.parse(readFileSync(join(radixUiDir, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const dirs = new Map<string, string>();
  for (const name of Object.keys(manifest.dependencies)) {
    if (!name.startsWith('@radix-ui/react-')) continue;
    dirs.set(name, dirname(radixRequire.resolve(`${name}/package.json`)));
  }
  return dirs;
}

function namespaceOf(name: string): string {
  return name
    .replace('@radix-ui/react-', '')
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

/** The `radix-ui` namespaces the app imports (`import { Select as X, Slot } from 'radix-ui'`). */
function importedNamespaces(): Set<string> {
  const used = new Set<string>();
  for (const file of sourceFiles(join(webRoot, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]radix-ui['"]/g)) {
      for (const part of (match[1] ?? '').split(',')) {
        const name = part
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (name) used.add(name);
      }
    }
  }
  return used;
}

describe('no dependency renders an inline style through a Trusted Types sink', () => {
  it('finds the sink that Radix Select shipped (the detector can fail)', () => {
    const unpatched = `jsx("style", { dangerouslySetInnerHTML: { __html: "x" }, nonce })`;
    expectGuardFails(
      () => {
        const found = findStyleSinks(unpatched);
        if (found.length > 0) throw new Error(found.join(', '));
      },
      { reason: /dangerouslySetInnerHTML/ },
    );
    expect(findStyleSinks(`createElement("style")`)).toContain('style element without a nonce');
    expect(findStyleSinks(`el.innerHTML = x`)).toContain('innerHTML assignment');
    expect(findStyleSinks(`jsx("style", { children: css })`)).toContain(
      'rendered <style> without a nonce',
    );
    expect(findStyleSinks(`const s = createElement("style"); s.nonce = n;`)).toEqual([]);
  });

  it('every Radix package whose namespace the app imports is free of such sinks', () => {
    const used = importedNamespaces();
    expect(used.has('Select')).toBe(true);
    const checked: string[] = [];
    const problems: string[] = [];
    for (const [name, dir] of radixPackageDirs()) {
      if (!used.has(namespaceOf(name))) continue;
      const distDir = join(dir, 'dist');
      expect(existsSync(distDir), `${name} has a dist folder`).toBe(true);
      for (const file of readdirSync(distDir)) {
        if (!/^index\.(mjs|js)$/.test(file)) continue;
        for (const finding of findStyleSinks(readFileSync(join(distDir, file), 'utf8'))) {
          problems.push(`${name}/dist/${file}: ${finding}`);
        }
      }
      checked.push(name);
    }
    expect(checked, 'the select package was scanned').toContain('@radix-ui/react-select');
    expect(problems).toEqual([]);
  });

  it('carries the scrollbar rule of the removed Select style in our own stylesheet', () => {
    const css = readFileSync(join(webRoot, 'src/styles/app.css'), 'utf8');
    expect(css).toMatch(/\[data-radix-select-viewport\]\s*\{[^}]*scrollbar-width:\s*none/);
    expect(css).toMatch(
      /\[data-radix-select-viewport\]::-webkit-scrollbar\s*\{[^}]*display:\s*none/,
    );
  });
});
