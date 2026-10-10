// `cn`: join class names and resolve Tailwind conflicts (the last conflicting utility wins), the one
// helper every component uses for `className`. It is the `cn` package (a drop-in for clsx plus
// tailwind-merge) configured with the utility names of OUR theme (styles/app.css), because the
// default tables know only Tailwind's own names: without this, `cn('text-body', 'text-fg')` would
// drop `text-body` (both look like `text-<colour>`) and `cn('shadow-1', 'shadow-2')` would keep both.
// The lists come from the tokens, so a new type size, layer or shadow level is known here at once.
import {
  DURATION_MS,
  EASING,
  FONT_WEIGHTS,
  SHADOW_LEVELS,
  TYPE_SCALE,
  Z_LAYERS,
} from '@m365portal/shared/tokens';
import { createCn } from 'cn/config';

export type { ClassValue } from 'cn';

export const cn = createCn({
  extend: {
    theme: {
      text: Object.keys(TYPE_SCALE),
      'font-weight': Object.keys(FONT_WEIGHTS),
      shadow: SHADOW_LEVELS.map(String),
      ease: Object.keys(EASING),
      // h-control, min-h-target, h-row-compact ... (styles/app.css: --spacing-*)
      spacing: ['control', 'target', 'row-compact', 'row-comfortable'],
      // max-w-content (--container-content)
      container: ['content'],
    },
    classGroups: {
      z: [{ z: Object.keys(Z_LAYERS) }],
      duration: [{ duration: Object.keys(DURATION_MS) }],
    },
  },
});
