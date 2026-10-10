INSTALL PROTOCOL: how dependencies change in this repository. Read before running pnpm.
Dependency changes are serialised: two concurrent pnpm runs corrupt node_modules and the lockfile.
Add a dependency ONLY like this, from the repository root, with an EXACT version (no ^, ~ or latest; never --force; -D for devDependencies):
  flock "${TMPDIR:-/tmp}/m365portal-pnpm.lock" pnpm --filter <pkg> add <dep>@<exact version>
Wait for the lock, never run two at once. install, update and dedupe go through the same flock. Never hand-edit pnpm-lock.yaml.
Versions come from specs/001-m365portal/stack-probe.md; verify anything else first with: pnpm view <dep> version
Every package declares what it imports in ITS OWN package.json. The root devDependencies (vitest, globals, eslint, typescript, prettier, ...) resolve from every package, so lint, typecheck and build do not notice a missing declaration; pnpm test:tools does (tools/workspace-deps: src, configs, CSS, tsconfig types and extends). When it fails, add the dependency to the package it names with the command above; do not lean on the root.
apps/server/build.mjs fails the build when esbuild inlines anything from node_modules: only workspace packages are inlined, everything else must be listed under "dependencies" (it then stays external).
Every dependency needs a recorded reason (docs/architecture.md): keep the list short and the image small. Do not declare a dependency before its first use (an unused one is removed again). That includes its pin in the catalog of pnpm-workspace.yaml: pnpm add records the pin itself, so never pre-seed one.
Commit package.json, pnpm-workspace.yaml and pnpm-lock.yaml together. The VERSION bump belongs to the orchestrator.
After the change run: pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm format:check

REMOVING a dependency: do NOT run pnpm remove. Delete the line from the package's package.json and run: flock "${TMPDIR:-/tmp}/m365portal-pnpm.lock" pnpm install
Reason: pnpm-workspace.yaml sets supportedArchitectures.libc, which pnpm only honours when it fetches the full registry metadata. pnpm add and pnpm install do that; pnpm remove does not (pnpm 10.28), so it rewrites pnpm-lock.yaml without any "libc:" field and the next install also installs the musl variant of every native package (4 extra packages today, +19 MB once sharp is added). Check the diff of pnpm-lock.yaml after every change: it must not delete "libc:" lines.

SETTINGS that look arbitrary, and why they are there:
  catalogMode: strict      Every version is pinned once, in the catalog of pnpm-workspace.yaml. The add records the pin there and writes "catalog:" into package.json; a version that differs from the catalog entry is rejected. Do not edit around it.
  strictDepBuilds: true    A dependency whose install script is neither in ignoredBuiltDependencies nor in onlyBuiltDependencies fails the (frozen) install with ERR_PNPM_IGNORED_BUILDS instead of printing a warning that nobody reads.
  ignoredBuiltDependencies Currently [esbuild]: its postinstall is the only install script in the tree and is optional (it validates the platform binary and swaps in a faster shim, with an npm install fallback); build.mjs, tsx and Vite work without it. Add better-sqlite3 here when it is installed (it ships prebuilds and needs no build step). When a new package trips strictDepBuilds, find out what its script does and what breaks without it before you choose ignoredBuiltDependencies or onlyBuiltDependencies, and write the reason in this list.
  peerDependencyRules.allowedVersions  Currently { 'eslint-plugin-jsx-a11y>eslint': '10' }. eslint-plugin-jsx-a11y 6.10.2 (last release 2024-10-26, unmaintained) declares the peer eslint "<=9", but every rule of it fires on ESLint 10 (stack-probe P2), and ESLint 9 is deprecated. The key names the parent plugin on purpose: another plugin that genuinely does not support ESLint 10 is still reported as an unmet peer. Never widen it to a bare 'eslint' key. If the plugin stops working on a later ESLint, replace the plugin; the fallback ESLint 9 only buys time.
  supportedArchitectures.libc: [glibc]  Without it pnpm installs both the glibc and the musl variant of every native package (sharp: +19 MB, stack-probe P10). The runtime image is glibc (distroless debian12); a musl builder (node:22-alpine) must not be used for it. pnpm honours the setting only when it fetches full registry metadata, which pnpm add and pnpm install do and pnpm remove does not (see REMOVING a dependency above). Do not remove it, and check that pnpm-lock.yaml keeps its "libc:" lines.
  shell-emulator=true      (.npmrc) lets package scripts use the POSIX form "HOST=127.0.0.1 node dist/index.js" (the server's dev and start scripts) on Windows too.
  pnpm add rewrites pnpm-workspace.yaml: it sorts the keys and drops every comment (pnpm install keeps them). The reasons above are therefore also written there as comments; put the comments back before you commit.

Scripts:
  One package only: pnpm --filter @m365portal/<server|web|shared|e2e> <lint|typecheck|test|build>
  pnpm routes:generate rewrites apps/web/src/routeTree.gen.ts (committed; never edit it by hand). pnpm lint and pnpm typecheck run it first, so they never see a stale tree. pnpm routes:check (for CI) regenerates it and fails when the result differs from the committed file.
  pnpm e2e needs a fresh pnpm build first. In the agent sandbox it uses the preinstalled Chromium (do not run playwright install there); the CI e2e job installs the matching browser itself.
Never commit node_modules, dist, .env or secrets. Never put a token in .npmrc.
