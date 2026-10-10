// The one module that creates transitions (FR-A-122, plan 9.4). Every duration and easing comes from
// the motion tokens (packages/shared/src/tokens/motion.ts: at most 200 ms, spring-like easing), and a
// source scan in test/motion.test.tsx refuses a literal duration, easing or transition object in any
// other module of components/ui, components/data-table and lib.
//
// CSS-driven motion (hover colours, the enter and exit keyframes of overlays) uses the same tokens
// through utilities (duration-fast, ease-spring, animate-pop-in: styles/app.css and motion.css).
// What is built here is for the pieces that Motion drives: a component passes `useTransition(name)`
// as its `transition` and never writes a number.
//
// Under prefers-reduced-motion every transition collapses to zero, whichever name is asked for.
// MotionConfig reducedMotion="user" (MotionProvider) switches off transforms by itself, but it still
// lets opacity and colour animate; FR-A-122 says nothing animates, so the collapse is done here too.
import { DURATION_MS, EASING, SPRING_MOTION } from '@m365portal/shared/tokens';
import { useSyncExternalStore } from 'react';

/** A Motion transition, as far as this application uses it: tween with a bezier, or the spring. */
export interface TokenTransition {
  readonly duration: number;
  readonly ease?: readonly [number, number, number, number];
  readonly type?: 'spring';
  readonly bounce?: number;
}

function seconds(milliseconds: number): number {
  return milliseconds / 1000;
}

function tween(milliseconds: number): TokenTransition {
  return Object.freeze({ duration: seconds(milliseconds), ease: EASING.standard });
}

export const transitions = Object.freeze({
  instant: Object.freeze({ duration: seconds(DURATION_MS.instant) }),
  fast: tween(DURATION_MS.fast),
  base: tween(DURATION_MS.base),
  slow: tween(DURATION_MS.slow),
  spring: Object.freeze({
    type: 'spring',
    duration: seconds(SPRING_MOTION.durationMs),
    bounce: SPRING_MOTION.bounce,
  }),
} as const satisfies Record<string, TokenTransition>);

export type TransitionName = keyof typeof transitions;

export const TRANSITION_NAMES = Object.freeze(Object.keys(transitions) as TransitionName[]);

const REDUCED: TokenTransition = Object.freeze({ duration: 0 });

/** The transition for `name`, or none at all when the user asked for reduced motion. */
export function transitionFor(name: TransitionName, reduced: boolean): TokenTransition {
  return reduced ? REDUCED : transitions[name];
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}

function reducedMotionNow(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** True while the user asks for reduced motion; follows the setting live. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, reducedMotionNow, () => false);
}

/** The transition to hand to a Motion component: the named one, or none under reduced motion. */
export function useTransition(name: TransitionName): TokenTransition {
  return transitionFor(name, usePrefersReducedMotion());
}
