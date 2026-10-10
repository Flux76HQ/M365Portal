# Stack probe (2026-10-10)

Throwaway probe: does the chosen stack compose **on this machine**, with versions resolved today via `npm view` / `pnpm view`?
Nothing in the repo was touched except this file. The probe lives in the session scratchpad
(`.../scratchpad/probe/`, ephemeral): `c1`..`c11` are per-check experiments, `ws` is the integrated pnpm workspace,
`ws-clean` is the final clean copy that was installed from a frozen lockfile, built, tested and containerised.

**Bottom line.** The stack composes and runs in a read-only, cap-dropped distroless container (7/7 Playwright tests, axe clean,
strict nonce CSP + Trusted Types enforced, no violations). It does **not** compose with the newest tools in four places that the plan
must pin around: TypeScript 7, ESLint 9, Playwright 1.64, jsdom. Two product targets are **not** met out of the box:
LCP < 2.0 s (measured 2.1-2.6 s) and a comfortable Lighthouse >= 95 (measured 95-98, at the edge). See "Failures".

## 1. Environment

| Item | Value |
|---|---|
| Host | Linux 6.18 x64, glibc 2.39, gcc/make/python3 present (probe hid them from PATH for installs, see check 2) |
| Node / pnpm | 22.22.0 / 10.28.0 (corepack). `npm`: 10.9.4 |
| Runtime image | `gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e` (Node 22.22.0, glibc 2.36, uid 65532, no shell, no fonts, no curl) |
| Builder image | `node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392` (Node 22.23.3: builder and runtime Node patch versions differ, harmless here) |
| Browser | Chromium 141.0.7390.37, revision 1194, `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` |
| Network | github.com HTML = 403 via proxy; ui.shadcn.com, registry.npmjs.org, raw.githubusercontent.com = 200. Inside `docker build` the sandbox TLS interception is untrusted (`SELF_SIGNED_CERT_IN_CHAIN`): a sandbox artifact, solved by adding the CA bundle to the build stage only. |
| Not testable here | arm64 (buildx shows linux/amd64 only), a real M365 tenant, Trivy/cosign/SBOM (not in scope of the probe) |

## 2. Results per check

| # | Check | Result | Key evidence |
|---|---|---|---|
| 1 | hono + zod + zod-openapi | PASS | zod **4** required. `@hono/zod-openapi` 1.6.3 peers `zod ^4`; with zod 3.25.76 it crashes at runtime (`schema._zod.parent` undefined). OpenAPI 3.1: `app.doc31(path, cfg)` and `app.getOpenAPI31Document(cfg)` (found in `dist/index.d.mts`); `.doc()`/`getOpenAPIDocument` stay 3.0. Plain-zod schemas from a shared package work with `.meta({ id })` as component names. Per-request nonce: `secureHeaders({ contentSecurityPolicy: { scriptSrc: [NONCE] } })`, read `c.get('secureHeadersNonce')`, `replaceAll('__CSP_NONCE__', nonce)` on a template read once at startup (nonce differs per request, verified in unit + e2e). `bodyLimit({ maxSize, onError })` returns 413 for Content-Length and for chunked bodies without Content-Length (tested over real HTTP). |
| 2 | drizzle + better-sqlite3 + drizzle-kit | PASS with one data-loss pitfall | better-sqlite3 13.0.3 ships **prebuilds inside the npm tarball** (no install script, no prebuild-install, no GitHub download). Installed with gcc/make/python3 removed from PATH. Loads on glibc x64, runs inside distroless read-only with `--cap-drop ALL`, WAL works on the bind-mounted `/data`. Runtime migrator + WAL + schema export all work. See pitfalls P12-P14. |
| 3 | sharp + SVG + fonts + GIF | PASS (with `<text>` FAIL in distroless) | sharp 0.35.5 (libvips 8.18.7, librsvg 2.63.2, cgif). SVG rect+path -> PNG ok; `fit:'inside'` ok; metadata stripped by default; `limitInputPixels` rejects a 48 kB / 400 MP PNG bomb in 3 ms and a 60000x60000 SVG. **`<text>` does not render in distroless** (`Fontconfig error: Cannot load default config file`, 72 dark px instead of ~2000). Glyph-path fallback works, byte-identical PNG on host and distroless. Animated GIF works: `sharp(frames[], { join: { animated: true } }).gif({ delay: [...], loop: 0 })`. |
| 4 | Tailwind v4 + React 19 + Vite + TS; shadcn | PASS | Vite 8.3.4 + plugin-react 6.1.2 + Tailwind 4.3.3 + TS 6.0.3 build. shadcn CLI 4.21.4 works through the proxy (`init -t vite -b radix -p nova -y`; add/eject verified). Unified `radix-ui` **1.7.0** is current (shadcn 4 with `-b radix` imports `Slot` etc. from `radix-ui`); only one copy of each `@radix-ui/*` primitive resolves. |
| 5 | TanStack Router/Query/Table | PASS with a generation step | Router 1.170.42 + plugin 1.168.43 + Query 5.104.1 + Table **9**.2.8 on React 19.3.0. Clean checkout: **vitest and `vite build` generate `routeTree.gen.ts` themselves**; **typecheck (4 TS errors) and typed lint (2 errors) fail until it exists** -> `tsr generate` (`@tanstack/router-cli` 1.167.41, shares router-generator 1.167.41 with the plugin) or commit the file. |
| 6 | Vitest/RTL, Playwright, axe, Lighthouse | PASS (tooling); performance targets partly missed | Vitest 5.0.3 + happy-dom 20.14.6 + RTL 16.3.3 on React 19: 9 web + 7 server tests pass. Playwright **1.56.1** launches the preinstalled Chromium 141 headless, takes screenshots, and runs axe (tags wcag2a, wcag2aa, wcag21aa, wcag22aa) clean on the dashboard and users routes in light and real dark (8/8 e2e tests, also 7/7 against the container before the extra dashboard axe test was added). Lighthouse 13.5.0 CLI runs headless with `CHROME_PATH`, `--chrome-flags="--headless=new --no-sandbox"`. |
| 7 | Inter variable fonts | PASS | Files: `inter-<subset>-<axes>-<style>.woff2`. wght axis: latin **48,256 B**, latin-ext **85,068 B** (opsz/standard axis sets are larger: 72,920 / 133,336 B). Only two subsets are emitted when imported through own `@font-face` rules (see snippet). |
| 8 | ESLint flat + typed lint + a11y + hooks + Prettier | PASS with TS 6 and ESLint 10 | See P1-P3. 22 s for typed lint of 4 packages. |
| 9 | pino + libsodium | PASS | Plain Node 22 ESM and tsx both import fine. XChaCha20-Poly1305 roundtrip, tamper and wrong-AAD both rejected. pino `redact` with `censor`. |
| 10 | ESM/TS execution, build, deploy | PASS | tsx for dev, esbuild bundle for prod, `pnpm deploy --prod --legacy`, distroless runs `dist/index.js`. Real multi-stage `docker build` verified (197 MB). |

## 3. Pins (exact, all verified together unless noted)

Toolchain: `node` 22.x (image 22.22.0), `pnpm` 10.28.0 (`packageManager`), save-exact.

| Group | Package@version |
|---|---|
| **root devDeps** | typescript@6.0.3, eslint@10.12.0, @eslint/js@10.0.1, typescript-eslint@8.71.1, eslint-plugin-jsx-a11y@6.10.2, eslint-plugin-react-hooks@7.1.1, eslint-config-prettier@10.1.8, globals@17.13.0, prettier@3.9.10 |
| **shared** | zod@4.6.5 |
| **server deps** | hono@4.13.13, @hono/node-server@2.1.4, @hono/zod-openapi@1.6.3, zod@4.6.5, drizzle-orm@0.45.4, better-sqlite3@13.0.3, sharp@0.35.5, pino@10.4.0, libsodium-wrappers@0.8.4 |
| **server devDeps** | drizzle-kit@0.31.11, @types/better-sqlite3@9.6.0, esbuild@0.28.2, tsx@4.23.15, vitest@5.0.3, @types/node@22.20.5, @m365portal/shared (workspace, inlined by esbuild) |
| **server, glyph generation (devDeps, verified standalone)** | opentype.js@2.0.0, @types/opentype.js@1.3.10, @fontsource/inter@5.3.0 (static `.woff`) |
| **server, verified standalone only** | @azure/msal-node@7.0.1, @microsoft/microsoft-graph-client@3.0.7, jose@6.2.12; test: msw@3.0.3 |
| **web deps** | react@19.3.0, react-dom@19.3.0, @tanstack/react-router@1.170.42, @tanstack/react-query@5.104.1, @tanstack/react-table@9.2.8, radix-ui@1.7.0, lucide-react@1.55.0, class-variance-authority@0.7.1, cn@0.4.0, cmdk@1.1.1, sonner@2.0.8 (+pnpm patch), tw-animate-css@1.4.0, @fontsource-variable/inter@5.3.0, react-hook-form@7.89.0, @hookform/resolvers@5.9.1, motion@14.1.0, zod@4.6.5 |
| **web devDeps** | vite@8.3.4, @vitejs/plugin-react@6.1.2, tailwindcss@4.3.3, @tailwindcss/vite@4.3.3, @tanstack/router-plugin@1.168.43, @tanstack/router-cli@1.167.41, vitest@5.0.3, happy-dom@20.14.6, @testing-library/react@16.3.3, @testing-library/dom@10.4.2, @testing-library/jest-dom@7.0.1, @testing-library/user-event@14.6.7, @types/react@19.3.0, @types/react-dom@19.3.0, @types/node@22.20.5, shadcn@4.21.4 (CLI only; run `shadcn eject` and drop it) |
| **e2e devDeps** | @playwright/test@1.56.1 (playwright-core 1.56.1), @axe-core/playwright@4.13.0, lighthouse@13.5.0 |
| **Resolved but NOT probed (UNVERIFIED)** | @opentelemetry/api@1.9.1, @opentelemetry/sdk-node@0.223.0, @vitest/coverage-v8@5.0.3 |

Rejected "latest" versions: `typescript@7.0.2`, `eslint@9.39.5` (deprecated), `@playwright/test@1.64.0`, `jsdom@30.1.2`, `@types/libsodium-wrappers` (stub), `drizzle-orm@1.0.0-rc.4` (rc tag, not evaluated).

## 4. Pitfalls found (each with fix)

### Versions and ecosystem
- **P1 TypeScript 7.0.2 is `latest` but has no JS API.** `require('typescript')` exports only `version`; typescript-eslint 8.71.1 (peer `<6.1.0`) aborts: "typescript-eslint does not support TS 7.0". TS 7 `tsc` itself typechecked the web projects fine. **Pin 6.0.3.** TS 6 also errors on `baseUrl` (TS5101): use `paths` only.
- **P2 ESLint 9.39.5 is flagged "no longer supported" by pnpm.** ESLint 10.12.0 works. `eslint-plugin-jsx-a11y` 6.10.2 (last release 2024-10-26) peers `eslint <=9`; empirically all its rules fire on ESLint 10. Needs `peerDependencyRules.allowedVersions: { eslint: '10' }`. Risk: unmaintained plugin; fallback is ESLint 9 (worked, deprecated).
- **P3 Playwright vs the preinstalled Chromium.** `browsers.json` of playwright-core: only **1.56.0 / 1.56.1** expect revision 1194 (141.0.7390.37). 1.64.0 expects 1248 and fails with "Executable doesn't exist", but ran fine against Chromium 141 with `launchOptions.executablePath`. Pin 1.56.1; CI installs the matching browser.
- **P4** `@types/libsodium-wrappers` is a deprecated stub; libsodium-wrappers 0.8.4 ships `.d.ts` and `.d.mts`. `@types/better-sqlite3` 9.6.0 (2026-08-01) is the match for better-sqlite3 13.x.
- **P5 shadcn CLI 4.21.4.** `init` prompts for a preset even with `-y` and **exits 0 doing nothing when stdin is closed**; pass `-p nova`. It installs `cn@0.4.0` (maintained by shadcn, young, "drop-in for clsx + tailwind-merge") instead of clsx/tailwind-merge, makes the `shadcn` package a runtime import (`@import "shadcn/tailwind.css"`, 640 lines; `shadcn eject` inlines it and drops the package, build verified), and its `sonner` wrapper imports `next-themes` (removed by hand).
- **P6** TanStack Table is a new major (9.2.8): `useTable({ features, columns, data })`, `tableFeatures({...})`, features must be registered, pulls `@tanstack/react-store`. **`exactOptionalPropertyTypes: true` breaks it** (`rowCount: number | undefined`): do not enable it.
- **P7** `jsdom` 30.1.2 fails 2 of 3 Radix tests (`ResizeObserver is not defined`, `target.hasPointerCapture is not a function`); **happy-dom 20.14.6 passes all 3 without polyfills.** jest-dom 7: `toBeEmpty` deprecated, use `toBeEmptyDOMElement`.
- **P8** MSW 3.0.3: option renamed `onUnhandledRequest` -> `onUnhandledFrame` (`server.listen({ onUnhandledFrame: 'error' })`, negative control verified). Vitest 5's optional peer `msw ^2.4.9` shows an "unmet peer" warning (cosmetic).

### pnpm / install / build
- **P9 better-sqlite3 13 tarball is 26.3 MB**: all 8 platform prebuilds + `deps/` + `src/`. Prune in the image stage (kept `linux-x64.node` only: 2.3 MB). Needs GLIBC <= 2.34, GLIBCXX 3.4.29 (distroless debian12 has 2.36). pnpm prints "Ignored build scripts: better-sqlite3" (harmless, nothing needs a build script); `ignoredBuiltDependencies: [better-sqlite3]` silences it, module still loads.
- **P10 pnpm installs both glibc and musl variants of sharp (+19 MB)** unless `supportedArchitectures: { libc: [glibc] }` is set in `pnpm-workspace.yaml`. A musl builder (node:22-alpine) must not be used for a glibc runtime.
- **P11 `pnpm deploy` is blocked in pnpm 10** (`ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`). Use `pnpm --filter <pkg> deploy --prod --legacy <dir>` (setting `inject-workspace-packages` would change all dev installs). Deploy copies the whole package directory (src, configs): copy only `node_modules`, `package.json`, `dist`, `drizzle`, `web` into the image. A failed deploy leaves partial output behind.
- `CI=true` makes pnpm default to `--frozen-lockfile` (good for CI, surprising for exploratory installs). Frozen install of the 5-project workspace took 4 s with a warm store, with no compilers on PATH.
- `pnpm audit --prod`: clean. `pnpm audit` (all): 2 findings, both dev-only chains: `braces <=3.0.3` via `shadcn > fast-glob > micromatch` (high) and `esbuild <=0.24.2` via `drizzle-kit > @esbuild-kit/*` (moderate). CI should gate on `--prod` and document these.
- Tailwind v4 automatic source detection **scans non-gitignored build output**: CSS was 68,014 B with `dist/` present and no `.gitignore` vs 63,645 B otherwise. `@import "tailwindcss" source(none); @source "../index.html"; @source ".";` is deterministic (63,645 B in both cases).
- `.js` import specifiers (NodeNext) are right for tsc/tsx/esbuild/vitest; `.ts` specifiers need `allowImportingTsExtensions`. Native `node src/index.ts` (Node 22.22 strips types by default) fails with `ERR_MODULE_NOT_FOUND` on `./app.js`; it works only with `.ts` specifiers + `erasableSyntaxOnly` (verified, but not chosen).

### Database
- **P12 DATA LOSS: drizzle migrations that rebuild a table cascade-delete children.** drizzle-kit generates `PRAGMA foreign_keys=OFF; CREATE TABLE __new_x ...; DROP TABLE x; RENAME` for e.g. adding UNIQUE or changing a default. The runtime migrator wraps every migration in `BEGIN ... COMMIT` (read in `sqlite-core/dialect.js`), where SQLite ignores `PRAGMA foreign_keys=OFF`. With `foreign_keys=ON` on the connection, upgrading a DB with 1 parent and 2 child rows left **0** children. Mitigation (verified, 2 -> 2 rows): run the migrator on a connection with `foreign_keys = OFF` (outside any transaction), then `PRAGMA foreign_key_check` (throw on violations), then `foreign_keys = ON`.
- **P13** The migrator compares only the **last applied** `created_at` with each journal `when`: a migration whose `when` is older than the latest applied one is skipped silently (from source, not demonstrated). Two branches adding migrations can hit this: the version-guard/upgrade test below covers it indirectly.
- **P14** `drizzle-orm` .d.ts files fail `tsc` with `skipLibCheck: false` (70 errors, all inside drizzle-orm: unused dialects need `gel`, `mysql2`, `pg` types). `skipLibCheck: true` is required. drizzle-kit CLI: `generate`, `migrate`, `up`, `check`, `drop`, `push`, `studio`, `introspect`, `export` (`export --sql` prints the full DDL of the current schema, diff against empty). The migrations folder (`drizzle/` with `meta/_journal.json`) must ship in the image; `migrate()` reads it at runtime.

### Baseline §2 guard (schema export per shipped version + upgrade test)
Verified mechanism (all green, then red when broken):
1. At release, `drizzle-kit export --dialect sqlite --schema ./src/db/schema.ts > schema-snapshots/<VERSION>.sql`, with a header line `-- last-migration: <tag>`. (`generate` additionally writes `meta/NNNN_snapshot.json` per migration.)
2. Upgrade test: for each older snapshot, build a DB from that SQL, insert a `__drizzle_migrations` row with `created_at` = journal `when` of its last migration, seed child rows, run the migrator (FK off), then compare `PRAGMA table_xinfo / index_list / index_info / foreign_key_list` against a DB built from the newest snapshot, and assert `foreign_key_check` is empty and child rows are intact.
3. Negative control done: changing `DEFAULT true` to `DEFAULT false` inside migration 0002 turned the guard red for both older versions ("structure DRIFT").

### Web security (CSP nonce, Trusted Types)
- Vite `html.cspNonce: '__CSP_NONCE__'` adds the attribute to script, stylesheet and preload tags and emits `<meta property="csp-nonce" nonce="...">`.
- **P15 Radix scroll lock (`react-remove-scroll-bar` -> `react-style-singleton`) injects a `<style>` whose nonce comes from `get-nonce`, which only reads the global `__webpack_nonce__`** (grepped in the installed package). Under Vite nothing sets it, so opening a dialog raised a `style-src-elem` violation. Fix verified (violation count 3 -> 2 -> 0 together with P16): before rendering, `globalThis.__webpack_nonce__ = document.querySelector('meta[property="csp-nonce"]')?.nonce`.
- **P16 `sonner` 2.0.8 injects a `<style>` at module load without a nonce** (`__insertCSS`), violating `style-src 'self' 'nonce-...'` on every page. Fix verified: `pnpm patch sonner@2.0.8` so the style gets `style.nonce` from the meta tag (patch is 2 lines in `dist/index.mjs` and `index.js`). Alternative: build toasts on Radix Toast.
- **P17 Zod 4 probes `new Function('')` on first parse**; under `require-trusted-types-for 'script'` that is reported as a violation even though it is caught. Fix verified: `z.config({ jitless: true })` in the web entry (Zod's source says exactly this). Keep JIT on the server.
- Probe CSP (all enforced in Chromium 141, zero violations in dashboard, toast, dialog, table routes): `default-src 'none'; script-src 'nonce-X'; style-src 'self' 'nonce-X'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'`. React `style={{}}` props are CSSOM writes and are not blocked.
- hono `secureHeaders`: no `Permissions-Policy` unless `permissionsPolicy` is set; `X-Frame-Options` defaults to `SAMEORIGIN` (set `DENY`); nonce is padded base64 (`==`); default invalid-body response is the raw ZodError JSON, so set a `defaultHook`.
- **The probe hard-codes `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`. Do not copy that.** App-Guidance baseline §13 forbids `includeSubDomains` on hosts the project does not own; a self-hosted panel runs on arbitrary customer hosts. Make it configuration-driven with the narrow fallback.

### Testing
- **P18 `@axe-core/playwright`: `import AxeBuilder from` fails type-check under NodeNext** ("not constructable"); use `import { AxeBuilder } from '@axe-core/playwright'`.
- **P19 shadcn's dark variant is class based** (`@custom-variant dark (&:is(.dark *))`). `page.emulateMedia({ colorScheme: 'dark' })` does nothing: the first "dark" axe run and the dark screenshot were **byte-identical to light** (same sha256). Toggle `document.documentElement.classList.toggle('dark', ...)` and assert the computed background (`oklch(0.145 0 0)`).
- **P20 `toHaveScreenshot` default `threshold: 0.2` hid a real change.** A `--radius` change worth 132 pixels passed with `maxDiffPixels: 0`. With `threshold: 0` it fails (guard seen red, then green after restoring); baselines were stable over repeated runs (2 workers) and across two separate checkouts. Baselines are `*-chromium-linux.png`.
- **P21 System fonts give false greens.** This host has Inter installed system-wide. The e2e asserts the self-hosted font really loaded (`document.fonts` entry `Inter Variable` with status loaded, only `inter-latin-wght-normal*.woff2` fetched). The SPA requests the font late, so `document.fonts.ready` resolves too early: use `waitForFunction`.
- A typed ESLint config needs the route tree generated (see check 5): in the clean copy `pnpm lint` failed with 2 `no-unsafe-assignment` errors until `tsr generate` had run. Flat-config trap: spreading a config object (`...tseslint.configs.disableTypeChecked`, `...reactHooks.configs.flat.recommended`) **after** a `languageOptions` key replaces the whole object and silently drops `globals`; keep globals in their own entry. Rule clashes: `non-nullable-type-assertion-style` vs `no-non-null-assertion` (use an explicit null check), `no-misused-spread` on code-point iteration (documented disable), `dot-notation` on `process.env` (use dot access). shadcn's generated `input-group.tsx` violates `jsx-a11y/click-events-have-key-events` and `no-noninteractive-element-interactions` (probe turns both off for that file; the plan should rework the component). Do not put test files under `src/routes/` (treated as routes, warning).
- pnpm strictness caught `import type { z } from 'zod'` in web without a direct dependency: declare `zod` in web too (single instance 4.6.5; the zod 3.25.76 in the store is only `shadcn > @modelcontextprotocol/sdk`, dev).

### Images (sharp)
- **P22 distroless has no fonts and no fontconfig**: SVG `<text>` is broken, host renders it (false green). opentype.js 2.0.0 parses `.woff` but **not `.woff2`** ("requires an external decompressor"), so the generator reads `@fontsource/inter` static `inter-<subset>-700-normal.woff` (latin, latin-ext, cyrillic, greek). Table of **411 glyphs = 166 kB JSON (40 kB gz)**; A-Z0-9 only = 12.7 kB (5.3 kB gz). No kerning in the table (advance widths only). Characters outside the table are dropped: a product decision (fallback icon) is needed. `MÖ` rendered legibly, sha256 identical on host and distroless.
- sharp security results: `<image href>` to `file://`, relative paths and `http://` are **not** loaded; `<!ENTITY ... SYSTEM "file:///etc/hostname">` fails ("Entity 'xxe' not defined"); billion-laughs rejected ("Maximum entity amplification factor exceeded"); `<script>`/`onload` inert. `.rotate()` (no args) applies EXIF orientation before metadata is dropped (without it the orientation tag is lost and a rotated phone photo displays sideways). Format is sniffed from bytes (JPEG named `.png` reports `jpeg`). For animated output `info.height` is the stacked height: read frames from `metadata().pages / pageHeight`.
- Rasterising uploads to PNG (never storing or serving SVG) is safe by construction given the above; the sanitiser then only matters if SVG is kept.

### Runtime
- Distroless has no curl/wget: healthcheck via `/nodejs/bin/node -e "fetch(...)"` (verified `healthy`). `serveStatic` from `@hono/node-server` 2.1.4 accepts an **absolute** `root` and `precompressed: true` (serves `.br`/`.gz` siblings, sets `Vary`). hono's `compress()` has gzip/deflate only, so precompress Brotli at build time.
- The SPA fallback must not answer file-like paths: before the fix `/favicon.ico` and `/robots.txt` returned the HTML shell with 200 (Lighthouse: "robots.txt is not valid: 16 errors"). Unknown API paths and any path with an extension now return 404.
- Server graceful shutdown (SIGTERM) and restart keep `/data` (db, -wal, -shm) intact.

## 5. Lighthouse (Lighthouse 13.5.0, Chromium 141, default mobile preset, simulated slow 4G, 4x CPU)

| Build | Perf | A11y | BP | SEO | FCP | LCP | CLS |
|---|---|---|---|---|---|---|---|
| First build, no compression, no preload | 78 / 79 (`/`, `/users`) | 100 | 100 | 92 | 3.7 s | 4.1 s / 3.9 s | 0 / 0.045 |
| + Brotli precompress, font preload, real `robots.txt`/favicon | 98 / 96-97 | 100 | 100 | 63-66 | 1.8 s | 2.1-2.2 s | 0 / 0.045 |
| + react-hook-form, motion, zod on the home route | **93-94** / 95-98 | 100 | 100 | 63-66 | 2.0-2.1 s | 2.6-2.7 s | 0 / 0.045 |
| + `LazyMotion` + `domAnimation` (`motion/react-m`) | **95** x3 / 95-97 | 100 | 100 | 63-66 | 2.0 s | **2.6 s / 2.1 s** | 0 / 0.045 |

- Run-to-run spread is small on this machine (root 95,95,95; users 95,97,97; earlier 98 x4), but the home route sits **at** the 95 threshold.
- Compression was the biggest lever (transfer size equalled resource size before). Brotli payload: 140 kB (skeleton) -> 193 kB (with RHF/motion/zod). `LazyMotion` saved 11.8 kB Brotli (-48 kB raw) on the home route chunk.
- SEO falls to 63-66 because `robots.txt` says `Disallow: /` (intended for an admin panel). Do not gate CI on the SEO category.
- CLS 0.045 on `/users` comes from the table appearing after data; needs a skeleton with reserved height.
- Hypotheses to reach LCP < 2.0 s (NOT tested): static app-shell text in `index.html`, critical CSS inline (`<style nonce>`), preload of route chunks (a dynamic-import chunk costs one extra round trip), smaller first-route dependencies.
- Spot checks: `transfer == resource size` was the signature of missing compression; "unused JavaScript 190 KiB" was the top remaining opportunity.

## 6. Failures and what did not work (honest list)

1. TypeScript 7 (latest) cannot be used with typescript-eslint. ESLint 9 is deprecated, ESLint 10 works only with a forced peer on an unmaintained a11y plugin.
2. Playwright latest (1.64.0) does not match the preinstalled browser; pinned to 1.56.1 (8 minors behind). Visual baselines depend on Chromium 141, so CI must install the same revision (it will, via the pinned version).
3. **LCP < 2.0 s is not met (2.1-2.6 s) and Lighthouse >= 95 is met only narrowly** with a skeleton app; every added dependency on the first route moves the score.
4. The initial e2e run failed on CSP: sonner (P16), Radix scroll-lock style (P15), Zod JIT probe (P17); the first "dark" tests were not dark (P19); the first visual guard could not fail (P20). All fixed and re-proven, but they show the gates are only as good as their negative controls.
5. `pkill -f` inside my own shell killed the session shell twice (probe tooling mistake, not a stack issue); replaced with pid files.
6. Node's native type stripping works only with `.ts` specifiers; not chosen.
7. A real multi-stage `docker build` failed first on TLS interception (sandbox artifact), passed after trusting the CA in the build stage.

## 7. Recommendations (what the plan should adopt)

- **Dev:** `tsx watch src/index.ts` (verified restart on change), `vite` dev server with `/api` proxy. tsx does not typecheck: keep `tsc` as a separate step.
- **Prod build:** esbuild bundle to `dist/index.js` (ESM, `platform: node`, `target: node22`), externals = the server's `dependencies`; `@m365portal/shared` is a devDependency and is inlined, so `pnpm deploy --prod --legacy` ships no workspace link. Image: `CMD ["dist/index.js"]` on the distroless entrypoint.
- **Shared package:** `exports` pointing at `./src/index.ts` ("internal package"): consumed by Vite, tsx, vitest, tsc (bundler/NodeNext) and esbuild with no build step. Plain `zod` + `.meta({ id })` for OpenAPI component names.
- **Route tree:** commit `routeTree.gen.ts` **or** run `tsr generate` before typecheck and lint; add a CI freshness check (`tsr generate && git diff --exit-code`). vitest and vite do not need it.
- **Branding images:** rasterise uploads with sharp to PNG (`limitInputPixels`, `.rotate()`, default metadata stripping, content sniffing); monogram/PWA icons from a pre-generated glyph table (no runtime fonts). Generator is a dev script using opentype.js + `@fontsource/inter` `.woff`.
- **README demo GIF:** Playwright PNG frames -> `sharp(frames, { join: { animated: true } }).gif({ delay, loop: 0 })` (no extra tool).
- **CI order:** install (frozen) -> `tsr generate` -> lint -> typecheck -> unit -> build -> e2e (+ visual with `threshold: 0`) -> Lighthouse against the built container -> docker build -> `pnpm audit --prod`.
- **Performance budget:** treat Lighthouse as a regression gate with a margin (it was 95-98 here); budget the first-route JS and prefer `LazyMotion`; keep Brotli precompression and the font preload in the build.

### Config snippets (verified)

`pnpm-workspace.yaml`
```yaml
packages: [apps/*, packages/*, e2e]
supportedArchitectures: { libc: [glibc] }
ignoredBuiltDependencies: [better-sqlite3]
patchedDependencies: { sonner@2.0.8: patches/sonner@2.0.8.patch }
peerDependencyRules: { allowedVersions: { eslint: '10' } }
```

`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`, `skipLibCheck: true`, **no** `exactOptionalPropertyTypes`, no `baseUrl` (use `paths`).

Fonts (Vite resolves the bare specifier in CSS `url()`; only these two files are emitted):
```css
@font-face { font-family: 'Inter Variable'; font-weight: 100 900; font-display: swap;
  src: url('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2') format('woff2-variations');
  unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD; }
/* same for inter-latin-ext-wght-normal.woff2 with the latin-ext range from wght.css */
```

Migrations (runtime):
```ts
sqlite.pragma('journal_mode = WAL'); sqlite.pragma('busy_timeout = 5000');
sqlite.pragma('foreign_keys = OFF');                       // migrator opens its own BEGIN: PRAGMA inside is a no-op
migrate(drizzle(sqlite), { migrationsFolder });
if ((sqlite.pragma('foreign_key_check') as unknown[]).length) throw new Error('foreign_key_check failed');
sqlite.pragma('foreign_keys = ON');
```

CSP + nonce (hono): `secureHeaders({ contentSecurityPolicy: { scriptSrc: [NONCE], styleSrc: ["'self'", NONCE], ... requireTrustedTypesFor: ["'script'"], trustedTypes: ["'none'"] }, permissionsPolicy: {...}, xFrameOptions: 'DENY' })`, `app.get('*', c => c.html(template.replaceAll('__CSP_NONCE__', c.get('secureHeadersNonce') ?? '')))`.

Dockerfile (build stage, abridged): `corepack enable` -> copy manifests + lockfile + `patches/` -> `pnpm install --frozen-lockfile --filter "@m365portal/server..." --filter "@m365portal/web..."` -> build web and server -> `pnpm --filter @m365portal/server deploy --prod --legacy /out` -> copy `node_modules package.json dist drizzle` + `apps/web/dist` to `/app` -> delete `better-sqlite3/{deps,src,binding.gyp}` and every prebuild except `$TARGETARCH` (`linux-x64.node` / `linux-arm64.node`). Runtime stage: distroless `:nonroot` by digest, `HEALTHCHECK` via `/nodejs/bin/node -e fetch`. Run with `--read-only --cap-drop ALL --security-opt no-new-privileges -v data:/data`: verified (the `/data` volume must be writable by uid 65532).

## 8. UNVERIFIED / not probed

- **arm64 / multi-arch**: this host cannot run it. better-sqlite3 and sharp ship `linux-arm64` binaries (listed in their packages) but nothing was executed on arm64. The Dockerfile's `TARGETARCH` prune is untested for arm64.
- **Entra acceptance of the MSAL assertion.** msal-node 7.0.1 produced a `PS256` JWT with `x5t#S256`, `iss=sub=clientId`, `aud=https://login.microsoftonline.com/{tid}/oauth2/v2.0/token`, which matches Microsoft Learn "certificate credentials > Assertion format" (alg PS256, PSS padding). A Microsoft Q&A answer (community, not official docs) claims Entra still locates the certificate by the SHA-1 thumbprint (`x5t`) registered on the app, so a SHA-256-only registration might not authenticate. Not tested against a real tenant: decide in Phase B and record in `docs/open-points.md`.
- OpenTelemetry (versions resolved only), `@vitest/coverage-v8`, Trivy, cosign, SBOM, Dependabot/Renovate.
- drizzle-orm / drizzle-kit 1.0 RC (different migration folder format expected, not evaluated).
- `pnpm` 11 behaviour for ignored build scripts (strictness could change); `auto-install-peers` pulled `@opentelemetry/api` into the deployed tree (1.6 MB) via drizzle-orm's optional peer.
