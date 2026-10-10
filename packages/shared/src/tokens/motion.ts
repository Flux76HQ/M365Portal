// Motion tokens (FR-A-122, plan 10.3). Every animation lasts at most 200 ms with a spring-like
// easing. The web package creates its transitions in one helper (apps/web/src/lib/motion.ts) from
// these values and nothing else; nothing animates under prefers-reduced-motion.

/** The longest any animation may last. Asserted by shared/tokens.test.ts. */
export const MAX_DURATION_MS = 200;

export const DURATION_MS = Object.freeze({ instant: 0, fast: 100, base: 150, slow: 200 } as const);

/** Cubic-bezier control points: [x1, y1, x2, y2]. */
export type BezierPoints = readonly [number, number, number, number];

export const EASING = Object.freeze({
  standard: Object.freeze([0.2, 0, 0, 1] as const),
  /** Overshoots slightly (y1 above 1): the spring-like feel for CSS. */
  spring: Object.freeze([0.22, 1.2, 0.36, 1] as const),
} as const satisfies Record<string, BezierPoints>);

/** A duration-based spring for Motion: the same 200 ms ceiling, a small bounce. */
export const SPRING_MOTION = Object.freeze({ durationMs: 200, bounce: 0.2 } as const);

/** `[0.2, 0, 0, 1]` becomes `cubic-bezier(0.2, 0, 0, 1)`. */
export function cubicBezier(points: BezierPoints): string {
  return `cubic-bezier(${points.map((point) => String(point)).join(', ')})`;
}
