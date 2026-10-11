// The utility names of OUR theme (styles/app.css) that `cn` must know, as a `cn` config extension.
// One definition for the two users: the build step that compiles the merge tables
// (build/plugins/cn-tables.ts, so the browser does not compile anything at start-up) and the test that
// proves the compiled tables behave like the runtime-configured `cn`. The lists come from the tokens,
// so a new type size, layer or shadow level is known here at once.
import {
  DURATION_MS,
  EASING,
  FONT_WEIGHTS,
  SHADOW_LEVELS,
  TYPE_SCALE,
  Z_LAYERS,
} from '@m365portal/shared/tokens';

export const CN_EXTENSION = {
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
};
