import { LazyMotion, MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';

// LazyMotion loads the feature bundle after the first render; `m` components from `motion/react-m`
// are static until then. `strict` makes a full `motion.*` component throw, which would pull the
// whole feature set into the entry chunk again.
function loadFeatures() {
  return import('./motion-features').then((module) => module.default);
}

export interface MotionProviderProps {
  /** The CSP nonce of the page (from the meta tag the server renders), for the styles Motion injects. */
  readonly nonce?: string;
  readonly children: ReactNode;
}

/**
 * Mounted once, near the root (root-providers.tsx). `reducedMotion="user"` follows the operating
 * system setting; lib/motion.ts collapses the transitions it builds in the same case, and
 * styles/a11y.css switches CSS animations off.
 */
export function MotionProvider({ nonce, children }: MotionProviderProps) {
  return (
    <MotionConfig reducedMotion="user" nonce={nonce}>
      <LazyMotion features={loadFeatures} strict>
        {children}
      </LazyMotion>
    </MotionConfig>
  );
}
