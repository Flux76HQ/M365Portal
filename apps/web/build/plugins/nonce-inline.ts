// Turns Vite's index.html into the shell template the server fills per request (plan 8.2, PD-15, C8).
//
// What Vite itself does (html.cspNonce in vite.config.ts): it stamps `nonce="__M365_NONCE__"` on the
// script, stylesheet and preload tags it writes and adds `<meta property="csp-nonce">`. What this
// plugin adds on top, in the production build:
//   - the entry CSS becomes `<style nonce="__M365_NONCE__">` in the document, and the stylesheet file
//     is not shipped: no stylesheet round trip before first paint (FR-A-158, LCP tactic 2);
//   - the boot script (src/boot/boot-script.ts, compiled by esbuild) becomes an inline classic
//     `<script nonce="__M365_NONCE__">` ahead of every style and script, so the theme and `lang` are
//     right before the first paint (FR-A-121, FR-A-113).
// In `vite dev` there is no server to fill the placeholders, so they get harmless development values.
//
// The six placeholders are the contract with the server's shell renderer (tasks.md C8, T-A-091):
// `__M365_NONCE__` (on every tag), and once each `__M365_TITLE__`, `__M365_THEME_CSS__`,
// `__M365_ICON_LINKS__`, `__M365_THEME_COLOR__`, `__M365_BOOT_JSON__`. They are written in index.html.
import { build as bundle } from 'esbuild';
import { join } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

/** The token the server replaces with a fresh nonce on every request. */
export const NONCE_PLACEHOLDER = '__M365_NONCE__';

export interface CompiledBootScript {
  /** The minified classic script. */
  readonly code: string;
  /** Every source file that went into it (paths as esbuild reports them, relative to the web root). */
  readonly inputs: readonly string[];
}

// The entry of the inline script, written here because it exists only for the build. It wires the
// pure function of boot-script.ts to the real browser. `getBrowserStorage` is the one function of
// lib/storage.ts that touches storage (guarded), so the lint rule still has a single exception.
const BOOT_ENTRY = `
import { disableZodJit, runBootScript } from './src/boot/boot-script.ts';
import { getBrowserStorage } from './src/lib/storage.ts';

disableZodJit(globalThis);
runBootScript({
  storage: getBrowserStorage(),
  matchMedia: typeof window.matchMedia === 'function' ? (query) => window.matchMedia(query) : null,
  languages: navigator.languages,
  root: document.documentElement,
});
`;

/** Compiles the boot script from TypeScript with esbuild. `webRoot` is the directory of apps/web. */
export async function compileBootScript(webRoot: string): Promise<CompiledBootScript> {
  const result = await bundle({
    stdin: { contents: BOOT_ENTRY, resolveDir: webRoot, sourcefile: 'boot-entry.ts', loader: 'ts' },
    absWorkingDir: webRoot,
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    // Old enough for every browser the app supports; the boot script uses nothing newer anyway.
    target: 'es2019',
    write: false,
    metafile: true,
    legalComments: 'none',
    logLevel: 'silent',
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error('esbuild produced no output for the boot script');
  const code = output.text.trim();
  // The script sits in a <script> element: a closing tag inside it would end the element early.
  if (/<\/script/i.test(code)) throw new Error('the boot script contains a closing script tag');
  return { code, inputs: Object.keys(result.metafile.inputs) };
}

/** Values for the placeholders in `vite dev`, where no server fills them. */
const DEVELOPMENT_VALUES: Readonly<Record<string, string>> = {
  [NONCE_PLACEHOLDER]: '',
  __M365_TITLE__: 'M365Portal',
  __M365_THEME_CSS__: '',
  __M365_ICON_LINKS__: '',
  __M365_THEME_COLOR__: '#ffffff',
  __M365_BOOT_JSON__: '',
};

function fillDevelopmentPlaceholders(html: string): string {
  return html.replace(/__M365_[A-Z_]+__/g, (token) => DEVELOPMENT_VALUES[token] ?? token);
}

/** Inserts `markup` immediately before the first `<title>`; the template always has one. */
export function insertBeforeTitle(html: string, markup: string): string {
  const index = html.indexOf('<title>');
  if (index < 0) throw new Error('index.html has no <title>: the shell template needs one');
  return html.slice(0, index) + markup + html.slice(index);
}

/**
 * Replaces each `<link rel="stylesheet" href="/assets/x.css">` of an emitted stylesheet with the
 * stylesheet's text in a `<style>`, and returns the file names it inlined.
 */
function inlineStylesheets(
  html: string,
  bundleAssets: Record<string, { type: string; source?: string | Uint8Array }>,
  base: string,
): { html: string; inlined: string[] } {
  const inlined: string[] = [];
  const replaced = html.replace(/<link\b[^>]*\brel="stylesheet"[^>]*>/g, (tag) => {
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    if (href?.startsWith(base) !== true) return tag;
    const fileName = href.slice(base.length);
    const asset = bundleAssets[fileName];
    if (asset?.type !== 'asset' || asset.source === undefined) return tag;
    const css =
      typeof asset.source === 'string' ? asset.source : Buffer.from(asset.source).toString('utf8');
    // The text sits in a <style> element: a closing tag inside it would end the element early.
    if (/<\/style/i.test(css)) throw new Error(`${fileName} contains a closing style tag`);
    inlined.push(fileName);
    return `<style nonce="${NONCE_PLACEHOLDER}">${css.trim()}</style>`;
  });
  return { html: replaced, inlined };
}

/**
 * Takes the inlined stylesheets out of the chunks' list of imported CSS. Vite builds the dependency list
 * of every dynamic `import()` from that list, and a lazy chunk with an `import()` of its own (the
 * Appearance page, T-A-214) would otherwise preload a stylesheet file that is not shipped: "Unable to
 * preload CSS", and the import fails with it. This runs while the HTML is generated, before Vite's
 * import analysis builds those lists.
 */
function forgetInlinedStylesheets(
  bundle: Record<string, { type: string; viteMetadata?: { importedCss?: Set<string> } }>,
  inlined: readonly string[],
): void {
  for (const item of Object.values(bundle)) {
    if (item.type !== 'chunk') continue;
    for (const fileName of inlined) item.viteMetadata?.importedCss?.delete(fileName);
  }
}

// Vite reads every <style> of index.html as CSS and minifies it, and `__M365_THEME_CSS__` is not CSS.
// The element is therefore set aside as a comment before Vite looks at the document and put back
// afterwards. (A comment inside the element would not do: the server replaces the token, so the CSS
// it writes would land inside the comment.)
const THEME_STYLE = /<style\b[^>]*>\s*__M365_THEME_CSS__\s*<\/style>/;
const THEME_STYLE_MARK = '<!--m365:theme-style-->';

/** Two plugins: one sets the theme style aside before Vite reads the document, one does the rest after. */
export function nonceInline(): Plugin[] {
  let config: ResolvedConfig;
  let themeStyle = '';
  const inlinedStylesheets = new Set<string>();
  let compiled: Promise<CompiledBootScript> | undefined;

  const setAside: Plugin = {
    name: 'm365portal:nonce-inline:set-aside',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const match = THEME_STYLE.exec(html);
        if (match === null) {
          throw new Error(
            'index.html lost its <style nonce> with the __M365_THEME_CSS__ placeholder',
          );
        }
        themeStyle = match[0];
        return html.replace(THEME_STYLE, THEME_STYLE_MARK);
      },
    },
  };

  const inline: Plugin = {
    name: 'm365portal:nonce-inline',

    configResolved(resolved) {
      config = resolved;
    },

    transformIndexHtml: {
      order: 'post',
      async handler(html, context) {
        const restored = html.replace(THEME_STYLE_MARK, () => themeStyle);
        compiled ??= compileBootScript(join(config.root));
        const { code } = await compiled;
        const withScript = insertBeforeTitle(
          restored,
          `<script nonce="${NONCE_PLACEHOLDER}">${code}</script>\n    `,
        );
        // Development: no server, no bundle. Fill the placeholders so the page works as it is.
        if (context.bundle === undefined) return fillDevelopmentPlaceholders(withScript);

        const { html: result, inlined } = inlineStylesheets(
          withScript,
          context.bundle,
          config.base,
        );
        for (const fileName of inlined) inlinedStylesheets.add(fileName);
        forgetInlinedStylesheets(context.bundle, inlined);
        return result;
      },
    },

    // The inlined stylesheet is part of the page now; shipping the file as well would only add bytes.
    generateBundle: {
      order: 'post',
      handler(_options, output) {
        for (const fileName of inlinedStylesheets) Reflect.deleteProperty(output, fileName);
        inlinedStylesheets.clear();
      },
    },
  };

  return [setAside, inline];
}
