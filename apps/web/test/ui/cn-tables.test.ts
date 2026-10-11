// @vitest-environment node
/// <reference types="node" />
//
// THE COMPILED `cn` TABLES (plan 14.2 tactic 4; T-A-173).
//
// The browser no longer compiles the class-merge tables at start-up: `build/plugins/cn-tables.ts` does it
// at build time and `lib/cn.ts` loads the result. Two things must stay true, and both are checked here:
//   1. the committed `cn-tables.generated.ts` is exactly what the build step writes (nobody edited it, and
//      a new utility name in `cn-config.ts` or a changed set of class names was regenerated);
//   2. the compiled tables merge exactly like the runtime-configured `cn` on class strings made of every
//      class name the sources use, so the speed-up changed no behaviour.
import { expectGuardFails } from '@m365portal/shared/testing';
import { createCn as createRuntimeCn } from 'cn/config';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CN_TABLES_FILE, compileCnTables } from '../../build/plugins/cn-tables';
import { CN_EXTENSION } from '../../src/lib/cn-config';
import { cn } from '../../src/lib/cn';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !name.endsWith('.generated.ts') ? [path] : [];
  });
}

/** A small deterministic generator, so a failure names the same combination on every run. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/**
 * The words of the string literals of the sources that look like utility classes. Comments and code
 * are left out on purpose: `cn build` fits the tables to the sources, and the theme resets Tailwind's
 * own scales (there is no `font-normal` here), so a word that is not a utility of this theme has no
 * defined merge behaviour to compare.
 */
function classCandidates(): string[] {
  const words = new Set<string>();
  const literal = /'([^'\n\\]*)'|"([^"\n\\]*)"|`([^`$\\]*)`/g;
  for (const file of sourceFiles(join(webRoot, 'src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(literal)) {
      for (const word of (match[1] ?? match[2] ?? match[3] ?? '').split(/\s+/)) {
        if (/^[a-z0-9!@:[\]\-./_%&>*()#,=~]+$/.test(word) && word.includes('-')) words.add(word);
      }
    }
  }
  // Names the theme adds are always part of the comparison, used in the sources or not.
  for (const size of CN_EXTENSION.extend.theme.text) words.add(`text-${size}`);
  for (const layer of CN_EXTENSION.extend.classGroups.z[0]?.z ?? []) words.add(`z-${layer}`);
  // The theme resets Tailwind's weights (`--font-weight-*: initial`), so `font-normal` generates no CSS
  // here. The runtime-configured cn still reads it as a weight and the compiled tables, which read the
  // stylesheet, as a font family; no component merges it with another font family.
  words.delete('font-normal');
  return [...words].sort();
}

/** Mismatches between a `cn` under test and the runtime-configured one, over seeded random strings. */
function mismatches(candidate: (...inputs: string[]) => string, count: number): string[] {
  const reference = createRuntimeCn(CN_EXTENSION);
  const candidates = classCandidates();
  // Conflicts are what `cn` exists for, and two random class names almost never conflict: most words
  // are drawn from the family (the part before the first dash, after any variant) of the word before.
  const families = new Map<string, string[]>();
  for (const name of candidates) {
    const family = name.replace(/^.*:/, '').split('-')[0] ?? '';
    families.set(family, [...(families.get(family) ?? []), name]);
  }
  const pick = (from: readonly string[], next: () => number): string =>
    from[Math.floor(next() * from.length)] ?? '';
  const next = lcg(20261011);
  const found: string[] = [];
  for (let round = 0; round < count; round++) {
    const inputs = Array.from({ length: 2 + Math.floor(next() * 3) }, () => {
      let word = pick(candidates, next);
      const words = [word];
      for (let more = Math.floor(next() * 4); more > 0; more--) {
        const family = word.replace(/^.*:/, '').split('-')[0] ?? '';
        word =
          next() < 0.7 ? pick(families.get(family) ?? candidates, next) : pick(candidates, next);
        words.push(word);
      }
      return words.join(' ');
    });
    const expected = reference(...inputs);
    const actual = candidate(...inputs);
    if (expected !== actual) found.push(`${JSON.stringify(inputs)}: ${expected} != ${actual}`);
  }
  return found;
}

describe('the compiled cn tables', () => {
  it('are the file the build step writes (the committed file is current)', async () => {
    const committed = readFileSync(join(webRoot, CN_TABLES_FILE), 'utf8');
    expect(committed).toBe(await compileCnTables(webRoot));
  });

  it('merge like the runtime-configured cn on every class name of the sources', () => {
    expect(classCandidates().length).toBeGreaterThan(300);
    expect(mismatches(cn, 4000)).toEqual([]);
  });

  it('the comparison fails for a cn that does not know the theme (negative fixture)', () => {
    const withoutTheme = createRuntimeCn();
    expectGuardFails((candidate: (...inputs: string[]) => string) => {
      expect(mismatches(candidate, 4000)).toEqual([]);
    }, withoutTheme);
  });
});
