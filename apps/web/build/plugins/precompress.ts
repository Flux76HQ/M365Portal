// Brotli and gzip siblings for the build output (plan 7.5, stack-probe "Runtime").
//
// The server serves static files with `serveStatic({ precompressed: true })`, which looks for
// `<file>.br` and `<file>.gz` next to a file and answers with them when the client accepts the
// encoding. Hono's own `compress()` has no Brotli, and compressing at the highest level per request
// would burn the CPU the app does not have, so it is done once here, at build time. Fonts (woff2) and
// images are compressed formats already and are left alone.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import type { Plugin } from 'vite';

const brotli = promisify(brotliCompress);
const deflate = promisify(gzip);

/** The file types worth compressing: text. */
const COMPRESSIBLE = /\.(?:js|css|svg|json|html)$/;

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    }),
  );
  return nested.flat();
}

/** Writes `<file>.br` and `<file>.gz` for every compressible file below `directory`. Returns the files made. */
export async function precompressDirectory(directory: string): Promise<string[]> {
  const written: string[] = [];
  for (const file of await filesUnder(directory)) {
    if (!COMPRESSIBLE.test(file)) continue;
    const content = await readFile(file);
    const [br, gz] = await Promise.all([
      brotli(content, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: content.length,
        },
      }),
      deflate(content, { level: constants.Z_BEST_COMPRESSION }),
    ]);
    await Promise.all([writeFile(`${file}.br`, br), writeFile(`${file}.gz`, gz)]);
    written.push(`${file}.br`, `${file}.gz`);
  }
  return written;
}

export function precompress(): Plugin {
  let outDir = '';
  let writes = true;

  return {
    name: 'm365portal:precompress',
    apply: 'build',

    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      writes = config.build.write;
    },

    // After every other plugin has written its files (the service worker included).
    closeBundle: {
      order: 'post',
      async handler() {
        if (!writes) return;
        try {
          await stat(outDir);
        } catch {
          return;
        }
        await precompressDirectory(outDir);
      },
    },
  };
}
