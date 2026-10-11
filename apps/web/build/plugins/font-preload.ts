// Preloads the Latin Inter file (FR-A-123, FR-A-158; plan 14.2 tactic 3; OP-3 of chunk-s3b).
//
// Vite does not preload fonts, and the hashed file name is only known after the build, so this plugin
// reads it from the bundle and writes `<link rel="preload" as="font">` into the document. Only the
// Latin subset is preloaded: the Latin-extended file (85 kB) is fetched on demand through the
// `unicode-range` of its @font-face and must not cost a byte on a page that has no such character.
// A font preload needs `crossorigin` even for the same origin, and the nonce like every other tag.
import type { Plugin, ResolvedConfig } from 'vite';
import { NONCE_PLACEHOLDER, insertBeforeTitle } from './nonce-inline.ts';

/** The emitted file of the Latin subset of the variable font: `assets/inter-latin-wght-normal-<hash>.woff2`. */
const LATIN_FONT = /(?:^|\/)inter-latin-wght-normal-[\w-]+\.woff2$/;

export function fontPreload(): Plugin {
  let config: ResolvedConfig;

  return {
    name: 'm365portal:font-preload',
    apply: 'build',

    configResolved(resolved) {
      config = resolved;
    },

    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        const fonts = Object.keys(context.bundle ?? {}).filter((fileName) =>
          LATIN_FONT.test(fileName),
        );
        if (fonts.length !== 1) {
          throw new Error(
            `expected exactly one inter-latin-wght-normal woff2 in the build, found ${String(fonts.length)}: the font import in styles/fonts.css changed`,
          );
        }
        const link = `<link rel="preload" as="font" type="font/woff2" crossorigin href="${config.base}${fonts[0] ?? ''}" nonce="${NONCE_PLACEHOLDER}">\n    `;
        return insertBeforeTitle(html, link);
      },
    },
  };
}
