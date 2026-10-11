// Starts the application after the first paint (plan 14.2 tactics 5 and 6; FR-A-155, FR-A-158; T-A-173).
//
// The HTML already holds everything the first paint needs: the critical CSS inline and the static
// shell (build/plugins/static-shell.ts). The application's JavaScript is not needed to paint, and
// requested in the head it competes with the HTML and the font for the connection and, on a slow phone,
// is the reason the first paint waits. So the module script and the `modulepreload` links Vite wrote
// are taken out of the head. In their place the document has
//   - a data block `<script type="application/json" id="m365-start">` that names the entry module and
//     the files to preload (the entry's imports and the chunks of the start-up stages), and
//   - one small inline script that, after the first frame has been presented, adds the preload links in
//     one go (the files download in parallel, not in a chain) and `import()`s the entry.
// The block is the contract for tooling: `scripts/bundle-budget.ts` and `test/build-output.test.ts` read
// it to know what the HTML makes the browser load.
//
// `import()` is not a Trusted Types sink and a module script from a same-origin URL is what the CSP
// (`script-src 'self'`) allows; a `<script src>` made with `createElement` would need a policy. If the
// frame callbacks never run (a hidden tab), a timer starts the application anyway.
import type { Plugin } from 'vite';
import { NONCE_PLACEHOLDER } from './nonce-inline.ts';

const ENTRY_SCRIPT = /[ \t]*<script type="module" crossorigin src="([^"]+)"[^>]*><\/script>\s*/;
const PRELOAD_LINK = /[ \t]*<link rel="modulepreload" crossorigin href="([^"]+)"[^>]*>\s*/g;
/** The modules the start-up imports one after the other (src/main.tsx, src/boot/stage-*.ts). */
const STAGE_MODULE = /[\\/]src[\\/]boot[\\/]stage-[\w-]+\.ts$/;

/** The id of the data block that names what the loader starts. */
export const START_BLOCK_ID = 'm365-start';

/**
 * The inline loader: a classic script that must run before any module has loaded. It reads what to
 * start from the data block, so the loader is the same text in every build.
 */
export const LOADER_SCRIPT =
  `(function(){var s=0,d;try{d=JSON.parse(document.getElementById("${START_BLOCK_ID}").textContent)}catch(_){return}` +
  'function go(){if(s)return;s=1;var p=d.preload;' +
  'for(var i=0;i<p.length;i++){var l=document.createElement("link");l.rel="modulepreload";l.crossOrigin="";l.href=p[i];document.head.appendChild(l)}' +
  'import(d.entry)}' +
  'requestAnimationFrame(function(){requestAnimationFrame(function(){setTimeout(go,0)})});setTimeout(go,1500)})()';

/** The JSON text of the start block: the entry module and the files to preload, as URL paths. */
export function startBlock(entry: string, preloads: readonly string[]): string {
  // `<` cannot occur in a build's file names, and is escaped anyway so the block can never close itself.
  return JSON.stringify({ entry, preload: preloads }).replace(/</g, '\\u003c');
}

interface BundleChunk {
  readonly type: string;
  readonly fileName: string;
  readonly imports?: readonly string[];
  readonly moduleIds?: readonly string[];
}

/**
 * The chunks of the stage modules and everything those import (statically, transitively), as file
 * names. These are what the start-up needs in the next few hundred milliseconds, and nothing else: the
 * lazy routes are not in it.
 */
export function stageChunkFiles(bundle: Readonly<Record<string, unknown>>): string[] {
  const chunks = new Map<string, BundleChunk>();
  for (const item of Object.values(bundle)) {
    const chunk = item as BundleChunk;
    if (chunk.type === 'chunk') chunks.set(chunk.fileName, chunk);
  }
  const wanted = new Set<string>();
  const visit = (fileName: string): void => {
    if (wanted.has(fileName)) return;
    wanted.add(fileName);
    for (const imported of chunks.get(fileName)?.imports ?? []) visit(imported);
  };
  for (const chunk of chunks.values()) {
    if (chunk.moduleIds?.some((id) => STAGE_MODULE.test(id)) === true) visit(chunk.fileName);
  }
  return [...wanted];
}

export function deferEntry(): Plugin {
  return {
    name: 'm365portal:defer-entry',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        const entry = ENTRY_SCRIPT.exec(html)?.[1];
        if (entry === undefined) throw new Error('the built index.html has no module script');
        const preloads = new Set([...html.matchAll(PRELOAD_LINK)].map((match) => match[1] ?? ''));
        for (const file of stageChunkFiles(context.bundle ?? {})) preloads.add(`/${file}`);
        const stripped = html.replace(ENTRY_SCRIPT, '').replace(PRELOAD_LINK, '');
        const block =
          `<script type="application/json" id="${START_BLOCK_ID}" nonce="${NONCE_PLACEHOLDER}">` +
          `${startBlock(entry, [...preloads])}</script>\n    `;
        const loader = `<script nonce="${NONCE_PLACEHOLDER}">${LOADER_SCRIPT}</script>\n    `;
        const end = stripped.lastIndexOf('</body>');
        if (end < 0) throw new Error('the built index.html has no </body>');
        return stripped.slice(0, end) + block + loader + stripped.slice(end);
      },
    },
  };
}
