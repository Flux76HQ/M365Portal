// Production build: bundle the application code and the workspace packages (@m365portal/shared)
// into dist/index.js. Everything listed under "dependencies" in package.json stays external and is
// installed next to the bundle (`pnpm deploy --prod --legacy`); workspace packages are
// devDependencies on purpose, so they are inlined and nothing ships a workspace link.
//
// The application version is read from the repository's VERSION file *here*, at build time, and
// compiled into the bundle as __APP_VERSION__ (see src/version.ts). The runtime image therefore
// needs no VERSION file. A Docker build stage must make VERSION available at the repository root.
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Resolve every path against this package, not against the caller's working directory, so that
// `node apps/server/build.mjs` works from the repository root (a Dockerfile RUN) as well as `pnpm build`.
const packageDirectory = fileURLToPath(new URL('.', import.meta.url));

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const version = readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`VERSION must be MAJOR.MINOR.PATCH, found "${version}"`);
}

const { metafile } = await build({
  absWorkingDir: packageDirectory,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
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
  rmSync(new URL('dist', import.meta.url), { recursive: true, force: true });
  throw new Error(
    `esbuild inlined code from node_modules that apps/server/package.json does not list under "dependencies":\n  ${inlined.join('\n  ')}\nDeclare the package as a dependency (it then stays external) or remove the import.`,
  );
}
