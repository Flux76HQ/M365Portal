// Production build: bundle the application code and the workspace packages (@m365portal/shared)
// into dist/. Everything listed under "dependencies" in package.json stays external and is
// installed next to the bundle (`pnpm deploy --prod --legacy`); workspace packages are
// devDependencies on purpose, so they are inlined and nothing ships a workspace link.
//
// Entry points, each one a file of its own in dist/ (TA-09):
//   index        the server (`node dist/index.js`)
//   cli          `node dist/cli.js verify-audit`
//   healthcheck  the image HEALTHCHECK (`node dist/healthcheck.js`)
//   <name>       every `src/**/*-worker.ts` (the image worker of the branding upload runs in a child
//                process under Node's permission model, so it cannot share a chunk with the server)
// The workers are found by their file name, so a new worker needs no edit of this file.
// `--outdir <dir>` builds somewhere else (the lifecycle tests build into a scratch directory).
//
// The application version is read from the repository's VERSION file *here*, at build time, and
// compiled into the bundle as __APP_VERSION__ (see src/version.ts). The runtime image therefore
// needs no VERSION file. A Docker build stage must make VERSION available at the repository root.
import { build } from 'esbuild';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve every path against this package, not against the caller's working directory, so that
// `node apps/server/build.mjs` works from the repository root (a Dockerfile RUN) as well as `pnpm build`.
const packageDirectory = fileURLToPath(new URL('.', import.meta.url));

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const version = readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`VERSION must be MAJOR.MINOR.PATCH, found "${version}"`);
}

const argumentList = process.argv.slice(2);
const outdirAt = argumentList.indexOf('--outdir');
if (outdirAt >= 0 && argumentList[outdirAt + 1] === undefined) {
  throw new Error('--outdir needs a directory');
}
const outdir = outdirAt >= 0 ? resolve(argumentList[outdirAt + 1]) : join(packageDirectory, 'dist');

/** Every `*-worker.ts` below src/, as { 'image-worker': 'src/branding/image-worker.ts' }. */
function workerEntries(directory, found = {}) {
  for (const entry of readdirSync(join(packageDirectory, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) workerEntries(path, found);
    else if (entry.name.endsWith('-worker.ts')) {
      const name = basename(entry.name, '.ts');
      if (name in found)
        throw new Error(`two workers are named ${name}: ${found[name]} and ${path}`);
      found[name] = path;
    }
  }
  return found;
}

const entryPoints = {
  index: 'src/index.ts',
  cli: 'src/cli.ts',
  healthcheck: 'src/healthcheck.ts',
  ...workerEntries('src'),
};

const { metafile } = await build({
  absWorkingDir: packageDirectory,
  entryPoints,
  outdir,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: Object.keys(pkg.dependencies),
  define: { __APP_VERSION__: JSON.stringify(version) },
  legalComments: 'none',
  logLevel: 'info',
  metafile: true,
});

// Only the workspace packages may be inlined. Anything that esbuild pulled out of node_modules is a
// dependency that is not listed under "dependencies": it would be bundled silently and then ship
// without being installed, audited or pinned in the image. (A package that only the ROOT
// package.json installs, such as `globals`, resolves fine and passes lint and typecheck.)
// Workspace packages are symlinks that esbuild resolves to packages/*, so they never show up here.
const inlined = Object.keys(metafile.inputs).filter((input) => input.includes('node_modules/'));
if (inlined.length > 0) {
  rmSync(outdir, { recursive: true, force: true });
  throw new Error(
    `esbuild inlined code from node_modules that apps/server/package.json does not list under "dependencies":\n  ${inlined.join('\n  ')}\nDeclare the package as a dependency (it then stays external) or remove the import.`,
  );
}
