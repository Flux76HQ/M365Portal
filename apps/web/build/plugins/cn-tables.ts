// Compiles the merge tables of `cn` at build time (plan 14.2 tactic 4: no work at start-up).
//
// `createCn` of `cn/config` compiles the class tables in the browser on the first call: about 150 ms of
// main-thread time on the 4x throttled mobile profile, plus 75 kB of compiler and default tables in the
// entry chunk. `cn build` does that work once, here, and the browser only loads typed arrays through
// `createCn` of `cn/engine`. The input is the application's own sources (the class names it uses) and
// `src/lib/cn-config.ts` (the utility names of the theme). The output is `src/lib/cn-tables.generated.ts`,
// committed; `test/ui/cn-tables.test.ts` fails when the committed file is not what this step writes and
// proves the compiled tables merge exactly like the runtime-configured `cn` on every class string of
// the sources.
import { build } from 'cn/build';
import { build as bundle } from 'esbuild';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/** Where the compiled tables are written, relative to the web root. */
export const CN_TABLES_FILE = 'src/lib/cn-tables.generated.ts';

/**
 * ESLint's strict rules are written for hand-made code. The generator's output uses non-null
 * assertions on typed-array reads; the directive names exactly the rules it trips (an unused name is itself an
 * error, so a generator change that drops one is noticed).
 */
const LINT_HEADER =
  '/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/restrict-plus-operands, @typescript-eslint/no-unsafe-assignment */\n';

/** The source of the compiled tables for the sources under `webRoot`. Does not write the real file. */
export async function compileCnTables(webRoot: string): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), 'm365portal-cn-'));
  try {
    // The config comes from TypeScript that imports the workspace's tokens (`.js` specifiers over
    // `.ts` files), which Node cannot load directly; esbuild bundles it into one module first.
    const bundled = await bundle({
      entryPoints: [join(webRoot, 'src/lib/cn-config.ts')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      logLevel: 'silent',
    });
    const config = join(scratch, 'cn-config.mjs');
    await writeFile(
      config,
      `${bundled.outputFiles[0]?.text ?? ''}\nexport default CN_EXTENSION;\n`,
    );
    const out = join(scratch, 'cn-tables.ts');
    const result = await build({
      cwd: webRoot,
      // The sources a class name can live in. Tests are not scanned: they must not widen the tables.
      content: ['src/**/*.{ts,tsx}', 'index.html'],
      out,
      config,
    });
    return (
      LINT_HEADER +
      result.source.replace(/from "\.\/cn-tables\.ts"/, 'from "./cn-tables.generated"')
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Writes the tables when they differ from the committed file. Returns true when the file changed. */
export async function writeCnTables(webRoot: string): Promise<boolean> {
  const file = join(webRoot, CN_TABLES_FILE);
  const source = await compileCnTables(webRoot);
  const current = await readFile(file, 'utf8').catch(() => '');
  if (current === source) return false;
  await writeFile(file, source);
  return true;
}

/** Vite: regenerate at the start of a build (and of the dev server), so the file never goes stale. */
export function cnTables(): Plugin {
  let root = '';
  return {
    name: 'm365portal:cn-tables',
    configResolved(resolved) {
      root = resolved.root;
    },
    async buildStart() {
      await writeCnTables(root);
    },
  };
}
