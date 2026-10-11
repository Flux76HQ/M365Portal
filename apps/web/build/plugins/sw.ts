// Compiles the service worker (src/sw/sw.ts) to `/sw.js` (FR-A-140, plan 9.8).
//
// The worker is not part of the app's module graph (nothing imports it), and its URL must be exactly
// `/sw.js` at the root: no hash, because the browser asks for that URL to find out whether there is a new
// version, and the scope of a worker is the folder it is served from. esbuild bundles it into one classic
// script with `__APP_VERSION__` defined, so a new product version changes the bytes of the file and the
// browser installs it. Cache names carry the same value (src/sw/sw.ts).
import { build as bundle } from 'esbuild';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/** The published name of the worker, at the root of the build output. */
export const SERVICE_WORKER_FILE = 'sw.js';

export interface CompileOptions {
  /** The directory of apps/web. */
  readonly webRoot: string;
  /** The product version (the VERSION file), the value of `__APP_VERSION__`. */
  readonly version: string;
}

export async function compileServiceWorker(options: CompileOptions): Promise<string> {
  const { webRoot, version } = options;
  const result = await bundle({
    entryPoints: [join(webRoot, 'src', 'sw', 'sw.ts')],
    absWorkingDir: webRoot,
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    define: { __APP_VERSION__: JSON.stringify(version) },
    write: false,
    legalComments: 'none',
    logLevel: 'silent',
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error('esbuild produced no output for the service worker');
  return output.text;
}

export function serviceWorker(options: { readonly version: string }): Plugin {
  let webRoot = '';
  return {
    name: 'm365portal:service-worker',
    apply: 'build',

    configResolved(config) {
      webRoot = config.root;
    },

    async generateBundle() {
      const source = await compileServiceWorker({ webRoot, version: options.version });
      this.emitFile({ type: 'asset', fileName: SERVICE_WORKER_FILE, source });
    },
  };
}
