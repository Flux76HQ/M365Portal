// The static app shell in the HTML (plan 14.2 tactic 5; FR-A-154, FR-A-155, FR-A-158; T-A-173).
//
// `index.html` carries the markup of the shell (sidebar, banner, header) inside `#root`, so the first
// paint is the shell and its text, not an empty page that waits for 300 kB of JavaScript. This plugin
// does the two build-time parts:
//   - it fills the `{{en:key}}` / `{{nl:key}}` tokens from the catalogues (no user-visible literal lives
//     in the web code; a missing key fails the build), HTML escaped, both languages side by side;
//   - it puts the small inline script (`src/boot/static-shell.ts`) after the shell, so the
//     organisation name and the preview banner are right at first paint.
// React's `createRoot(...).render` replaces the content of `#root`, so the shell vanishes the moment the
// application has its first tree. The shell is `aria-hidden` and `inert`: it is a picture, not a page.
import { build as bundle } from 'esbuild';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { NONCE_PLACEHOLDER } from './nonce-inline.ts';

type Locale = 'en' | 'nl';
const TOKEN = /\{\{(en|nl):([A-Za-z0-9_.]+)\}\}/g;

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

type Catalogue = Readonly<Record<string, unknown>>;

/** Replaces every `{{lang:key}}` token with the escaped catalogue text. A missing key throws. */
export function fillCatalogueTokens(
  html: string,
  catalogues: Readonly<Record<Locale, Catalogue>>,
): string {
  return html.replace(TOKEN, (_token, locale: Locale, key: string) => {
    const value = catalogues[locale][key];
    if (typeof value !== 'string' || value === '') {
      throw new Error(`static shell: the ${locale} catalogue has no text for "${key}"`);
    }
    return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
  });
}

/** Compiles `src/boot/static-shell.ts` into the inline classic script. */
export async function compileStaticShellScript(webRoot: string): Promise<string> {
  const result = await bundle({
    stdin: {
      contents: `import { revealStaticShell } from './src/boot/static-shell.ts';\nrevealStaticShell(document);`,
      resolveDir: webRoot,
      sourcefile: 'static-shell-entry.ts',
      loader: 'ts',
    },
    absWorkingDir: webRoot,
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2019',
    write: false,
    legalComments: 'none',
    logLevel: 'silent',
  });
  const code = result.outputFiles[0]?.text.trim() ?? '';
  if (code === '' || /<\/script/i.test(code))
    throw new Error('the static shell script is empty or unsafe');
  return code;
}

function readCatalogue(webRoot: string, locale: Locale): Catalogue {
  const file = join(webRoot, '..', '..', 'packages/shared/src/i18n/locales', `${locale}.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as Catalogue;
}

const ROOT_END = /(<div id="root">[\s\S]*?<\/div>\s*)(?=<noscript>)/;

export function staticShell(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'm365portal:static-shell',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    transformIndexHtml: {
      order: 'post',
      async handler(html) {
        const filled = fillCatalogueTokens(html, {
          en: readCatalogue(config.root, 'en'),
          nl: readCatalogue(config.root, 'nl'),
        });
        const code = await compileStaticShellScript(config.root);
        if (!ROOT_END.test(filled))
          throw new Error('index.html: #root is not followed by <noscript>');
        return filled.replace(
          ROOT_END,
          (root) => `${root}<script nonce="${NONCE_PLACEHOLDER}">${code}</script>\n    `,
        );
      },
    },
  };
}
