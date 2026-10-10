/// <reference types="node" />
//
// MOTION (FR-A-122; plan 9.4; T-A-124).
//
// FR-A-122: every animation lasts at most 200 ms with spring-like easing, all motion goes through
// one helper, `MotionConfig reducedMotion="user"` plus a CSS reset, and nothing animates under
// reduced motion. The CSS reset is tested in styles.test.ts and in e2e/reduced-motion.spec.ts (the
// real browser: `document.getAnimations()` is empty after interactions). This file tests the
// JavaScript half:
//   1. lib/motion.ts builds every transition from the motion tokens and nothing else;
//   2. under prefers-reduced-motion every transition collapses to zero, whichever name is asked for;
//   3. MotionProvider mounts LazyMotion with the domAnimation features (strict, so a stray `motion.*`
//      component cannot drag the full feature set into the entry chunk) and MotionConfig with
//      reducedMotion="user" and the CSP nonce;
//   4. a source scan of components/ui, components/data-table and lib refuses a literal duration, a
//      literal easing or a transition object anywhere but in lib/motion.ts (+ negative fixtures).
import { expectGuardFails } from '@m365portal/shared/testing';
import { DURATION_MS, EASING, MAX_DURATION_MS, SPRING_MOTION } from '@m365portal/shared/tokens';
import { render, screen, waitFor } from '@testing-library/react';
import * as m from 'motion/react-m';
import { createElement, type ComponentProps } from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TRANSITION_NAMES,
  transitionFor,
  transitions,
  useTransition,
  type TransitionName,
} from '../src/lib/motion';
import { MotionProvider } from '../src/components/ui/motion-provider';

// ---------------------------------------------------------------------------------------------
// Spies on the two Motion components the provider is built from. They call through, so the rest of
// the file still runs the real library.
// ---------------------------------------------------------------------------------------------

const seen = vi.hoisted(() => ({
  lazy: [] as Record<string, unknown>[],
  config: [] as Record<string, unknown>[],
}));

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return {
    ...actual,
    LazyMotion: (props: ComponentProps<typeof actual.LazyMotion>) => {
      seen.lazy.push({ ...props });
      return createElement(actual.LazyMotion, props);
    },
    MotionConfig: (props: ComponentProps<typeof actual.MotionConfig>) => {
      seen.config.push({ ...props });
      return createElement(actual.MotionConfig, props);
    },
  };
});

const webRoot = join(import.meta.dirname, '..');

// ---------------------------------------------------------------------------------------------
// 1. The transitions come from the tokens
// ---------------------------------------------------------------------------------------------

type TransitionTable = Readonly<
  Record<string, { duration?: number; type?: string; bounce?: number }>
>;

/** Throws when a transition lasts longer than the ceiling or has no duration at all. */
function checkTransitionTable(table: TransitionTable): void {
  const problems: string[] = [];
  for (const [name, transition] of Object.entries(table)) {
    if (typeof transition.duration !== 'number') {
      problems.push(`${name} has no duration`);
    } else if (transition.duration * 1000 > MAX_DURATION_MS) {
      problems.push(
        `${name} lasts ${String(transition.duration * 1000)} ms, above ${String(MAX_DURATION_MS)} ms`,
      );
    }
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
}

describe('lib/motion.ts: transitions are built from the motion tokens', () => {
  it('has exactly the names the tokens have, plus the spring', () => {
    expect([...TRANSITION_NAMES].sort()).toEqual([...Object.keys(DURATION_MS), 'spring'].sort());
    expect(Object.keys(transitions).sort()).toEqual([...TRANSITION_NAMES].sort());
  });

  it('takes every duration from DURATION_MS (seconds for Motion) and the easing from EASING', () => {
    for (const name of Object.keys(DURATION_MS) as (keyof typeof DURATION_MS)[]) {
      const transition = transitions[name] as { duration: number; ease?: readonly number[] };
      expect(transition.duration, name).toBeCloseTo(DURATION_MS[name] / 1000, 6);
      if (name !== 'instant') expect(transition.ease, name).toEqual([...EASING.standard]);
    }
  });

  it('describes the spring with the duration-based spring of the tokens', () => {
    expect(transitions.spring).toEqual({
      type: 'spring',
      duration: SPRING_MOTION.durationMs / 1000,
      bounce: SPRING_MOTION.bounce,
    });
  });

  it('keeps every transition at or below 200 ms', () => {
    checkTransitionTable(transitions);
    for (const transition of Object.values(transitions)) {
      expect(transition.duration * 1000).toBeLessThanOrEqual(MAX_DURATION_MS);
    }
  });

  it('negative: a transition above 200 ms fails the check', () => {
    expectGuardFails(
      checkTransitionTable,
      { ...transitions, slowest: { duration: 0.3 } },
      { name: 'checkTransitionTable', reason: 'slowest lasts 300 ms' },
    );
  });

  it('negative: a transition without a duration fails the check', () => {
    expectGuardFails(
      checkTransitionTable,
      { broken: { type: 'spring' } },
      {
        name: 'checkTransitionTable',
        reason: 'broken has no duration',
      },
    );
  });

  it('is frozen: a component cannot change a transition for everybody', () => {
    expect(Object.isFrozen(transitions)).toBe(true);
    for (const transition of Object.values(transitions))
      expect(Object.isFrozen(transition)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Reduced motion
// ---------------------------------------------------------------------------------------------

const realMatchMedia = window.matchMedia;

/** Make `(prefers-reduced-motion: reduce)` match (or not) for the next render. */
function mockReducedMotion(reduce: boolean): void {
  window.matchMedia = (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
}

const realAnimate = Element.prototype.animate as typeof Element.prototype.animate | undefined;

afterEach(() => {
  window.matchMedia = realMatchMedia;
  if (realAnimate === undefined) Reflect.deleteProperty(Element.prototype, 'animate');
  else Element.prototype.animate = realAnimate;
});

function Probe({ name }: { readonly name: TransitionName }) {
  const transition = useTransition(name);
  return <output data-testid="transition">{JSON.stringify(transition)}</output>;
}

function transitionRendered(name: TransitionName): unknown {
  render(<Probe name={name} />);
  return JSON.parse(screen.getByTestId('transition').textContent) as unknown;
}

describe('reduced motion collapses every transition', () => {
  it('transitionFor(name, true) is instant for every name', () => {
    for (const name of TRANSITION_NAMES) {
      expect(transitionFor(name, true), name).toEqual({ duration: 0 });
    }
  });

  it('transitionFor(name, false) is the table entry itself', () => {
    for (const name of TRANSITION_NAMES)
      expect(transitionFor(name, false), name).toBe(transitions[name]);
  });

  it('useTransition follows the media query: full transition normally, zero under reduce', () => {
    mockReducedMotion(false);
    expect(transitionRendered('base')).toEqual(transitions.base);
    cleanupRender();

    mockReducedMotion(true);
    for (const name of TRANSITION_NAMES) {
      expect(transitionRendered(name), name).toEqual({ duration: 0 });
      cleanupRender();
    }
  });

  it('no animation starts under reduce: the element is at its final value, and WAAPI is not touched', async () => {
    const { animate, element } = mountFade(true);
    // The final value is only reached once LazyMotion has loaded its features and started the
    // (zero-length) transition, so waiting for it also proves the check below ran after the load.
    await waitFor(() => {
      expect(element().style.opacity).toBe('1');
    });
    expect(animate).not.toHaveBeenCalled();
  });

  it('positive control: without reduced motion the same component does start an animation', async () => {
    const { animate } = mountFade(false);
    await waitFor(() => {
      expect(animate).toHaveBeenCalled();
    });
  });
});

/** An object with the parts of `Animation` that Motion touches; it never finishes on its own. */
function stubAnimation() {
  return {
    finished: new Promise<void>(() => undefined),
    cancel: vi.fn(),
    finish: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    commitStyles: vi.fn(),
    persist: vi.fn(),
    reverse: vi.fn(),
    updatePlaybackRate: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    currentTime: 0,
    startTime: 0,
    playbackRate: 1,
    playState: 'running',
    effect: null,
    timeline: null,
    onfinish: null,
    oncancel: null,
  };
}

/**
 * Mounts an `m.div` that fades in with the helper's transition and reports what happens to the Web
 * Animations API. `Element.prototype.animate` is replaced for the rest of the file's tests: the
 * afterEach below puts it back.
 */
function mountFade(reduce: boolean) {
  const animate = vi.fn(() => stubAnimation());
  Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
  mockReducedMotion(reduce);
  function Fade() {
    const transition = useTransition('base');
    return (
      <m.div
        data-testid="fade"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={transition}
      />
    );
  }
  render(
    <MotionProvider nonce="n">
      <Fade />
    </MotionProvider>,
  );
  return { animate, element: () => screen.getByTestId('fade') };
}

/** Testing Library unmounts after each test, not after each render: clear between renders by hand. */
function cleanupRender(): void {
  document.body.innerHTML = '';
}

// ---------------------------------------------------------------------------------------------
// 3. The provider
// ---------------------------------------------------------------------------------------------

describe('MotionProvider', () => {
  beforeEach(() => {
    seen.lazy.length = 0;
    seen.config.length = 0;
    mockReducedMotion(false);
  });

  it('mounts LazyMotion with the domAnimation features, strict, around its children', async () => {
    render(
      <MotionProvider nonce="abc">
        <p>child</p>
      </MotionProvider>,
    );
    expect(screen.getByText('child')).toBeInTheDocument();

    const props = seen.lazy.at(-1);
    expect(props, 'LazyMotion was not rendered').toBeDefined();
    expect(props?.strict).toBe(true);

    const actual = await vi.importActual<typeof import('motion/react')>('motion/react');
    const features = props?.features;
    // A function means "load the bundle on demand" (kept out of the entry chunk): it must resolve
    // to domAnimation, not to domMax (layout and drag are not used and weigh more).
    const resolved =
      typeof features === 'function' ? await (features as () => Promise<unknown>)() : features;
    expect(resolved).toBe(actual.domAnimation);
    expect(resolved).not.toBe(actual.domMax);
  });

  it('mounts MotionConfig with reducedMotion="user" and the nonce it was given', () => {
    render(
      <MotionProvider nonce="nonce-for-the-test">
        <p>child</p>
      </MotionProvider>,
    );
    const props = seen.config.at(-1);
    expect(props?.reducedMotion).toBe('user');
    expect(props?.nonce).toBe('nonce-for-the-test');
  });

  it('works without a nonce (tests, the showcase) and still sets reducedMotion', () => {
    render(
      <MotionProvider>
        <p>child</p>
      </MotionProvider>,
    );
    const props = seen.config.at(-1);
    expect(props?.reducedMotion).toBe('user');
    expect(props?.nonce).toBeUndefined();
  });

  it('is strict: a full `motion.div` below it is refused, so the feature bundle stays lazy', async () => {
    const { motion } = await vi.importActual<typeof import('motion/react')>('motion/react');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() =>
        render(
          <MotionProvider>
            <motion.div>full component</motion.div>
          </MotionProvider>,
        ),
      ).toThrow(/strict|motion/i);
    } finally {
      errors.mockRestore();
    }
  });

  it('lets the lightweight m components animate once the features have loaded', async () => {
    render(
      <MotionProvider>
        <m.div
          data-testid="box"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={transitions.instant}
        />
      </MotionProvider>,
    );
    expect(screen.getByTestId('box').style.opacity).toBe('0');
    await waitFor(() => {
      expect(screen.getByTestId('box').style.opacity).toBe('1');
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 4. The source scan
// ---------------------------------------------------------------------------------------------

/** The folders whose files may not create a transition of their own. */
const SCANNED_FOLDERS = ['src/components/ui', 'src/components/data-table', 'src/lib'];
const MOTION_MODULE = 'src/lib/motion.ts';

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const FORBIDDEN: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /\b(?:duration|delay)-(?:\d|\[)/,
    why: 'a literal Tailwind duration or delay (use duration-fast|base|slow)',
  },
  {
    pattern: /\bease-\[|\bease-(?:in|out|in-out|linear)\b/,
    why: 'a literal easing (use ease-standard|spring)',
  },
  {
    pattern: /\banimate-(?:spin|ping|pulse|bounce|\[)/,
    why: 'a looping or custom animation (every animation lasts at most 200 ms)',
  },
  { pattern: /(?<![\w-])\d+(?:\.\d+)?m?s\b(?![-\w])/, why: 'a literal time value' },
  { pattern: /cubic-bezier\(|\bspring\(/, why: 'a literal easing function' },
  { pattern: /\btransition\s*=\s*\{\s*\{/, why: 'a transition object (build it in lib/motion.ts)' },
  { pattern: /\btransition\s*:\s*\{/, why: 'a transition object (build it in lib/motion.ts)' },
  { pattern: /\bduration\s*:\s*[\d.]/, why: 'a literal duration (take it from the motion tokens)' },
  { pattern: /\.animate\(|\bnew Animation\(/, why: 'a direct Web Animations call' },
];

/** Strips comments so a sentence such as "within 200 ms" in prose is not a finding. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function scanSource(file: string, source: string): Finding[] {
  if (file === MOTION_MODULE) return [];
  const findings: Finding[] = [];
  withoutComments(source)
    .split('\n')
    .forEach((text, index) => {
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(text))
          findings.push({ file, line: index + 1, text: `${why}: ${text.trim()}` });
      }
    });
  return findings;
}

function assertNoLiteralMotion(files: Readonly<Record<string, string>>): void {
  const findings = Object.entries(files).flatMap(([file, source]) => scanSource(file, source));
  if (findings.length > 0) {
    throw new Error(
      findings
        .map((finding) => `${finding.file}:${String(finding.line)} ${finding.text}`)
        .join('\n'),
    );
  }
}

function sourceFiles(folder: string): string[] {
  const root = join(webRoot, folder);
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:ts|tsx|css)$/.test(entry)) found.push(path);
    }
  };
  try {
    walk(root);
  } catch {
    // A folder that does not exist yet (data-table arrives later) has nothing to scan.
  }
  return found;
}

describe('source scan: lib/motion.ts is the only module that creates transitions', () => {
  it('finds no literal duration, easing, looping animation or transition object elsewhere', () => {
    const files: Record<string, string> = {};
    for (const folder of SCANNED_FOLDERS) {
      for (const path of sourceFiles(folder)) {
        files[relative(webRoot, path).split('\\').join('/')] = readFileSync(path, 'utf8');
      }
    }
    expect(Object.keys(files)).toContain(MOTION_MODULE);
    assertNoLiteralMotion(files);
  });

  it.each([
    [
      'a literal Tailwind duration',
      'export const a = "transition-colors duration-150";',
      'literal Tailwind duration',
    ],
    ['an arbitrary duration', 'export const a = "duration-[200ms]";', 'literal Tailwind duration'],
    ['a literal easing class', 'export const a = "ease-in-out";', 'literal easing'],
    ['a looping animation', 'export const a = "animate-spin";', 'looping or custom animation'],
    [
      'a time value in a style',
      'export const a = { transitionDuration: "150ms" };',
      'literal time value',
    ],
    [
      'a transition prop',
      'export const a = <m.div transition={{ duration: 0.2 }} />;',
      'transition object',
    ],
    [
      'a transition object',
      'export const a = { transition: { duration: 0.1 } };',
      'transition object',
    ],
    ['a duration number', 'const t = { duration: 0.2 };', 'literal duration'],
    ['a bezier', 'export const a = "cubic-bezier(0.2, 0, 0, 1)";', 'literal easing function'],
    ['a direct WAAPI call', 'element.animate([{ opacity: 0 }], 100);', 'Web Animations'],
  ])('negative: %s fails the scan', (_label, source, reason) => {
    expectGuardFails(
      assertNoLiteralMotion,
      { 'src/components/ui/dialog.tsx': source },
      {
        name: 'assertNoLiteralMotion',
        reason,
      },
    );
  });

  it('allows the token-named utilities and prose about milliseconds in comments', () => {
    assertNoLiteralMotion({
      'src/components/ui/button.tsx':
        '// every animation lasts at most 200 ms\nexport const a = "transition-colors duration-fast ease-standard animate-pop-in";',
    });
  });

  it('does not exempt other files than lib/motion.ts', () => {
    expect(
      scanSource(MOTION_MODULE, 'export const t = { transition: { duration: 0.1 } };'),
    ).toEqual([]);
    expect(
      scanSource('src/lib/other.ts', 'export const t = { transition: { duration: 0.1 } };'),
    ).not.toEqual([]);
  });
});
