import { DEFAULT_PORT } from '@m365portal/shared/limits';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { fontPreload } from './build/plugins/font-preload.ts';
import { nonceInline } from './build/plugins/nonce-inline.ts';
import { precompress } from './build/plugins/precompress.ts';

// Where `pnpm dev` finds the API server: the same PORT the server reads, with the same default
// (FR-A-016; @m365portal/shared/limits defines it once). The `dev` script of the server pins
// HOST=127.0.0.1.
const apiOrigin = `http://127.0.0.1:${process.env.PORT ?? String(DEFAULT_PORT)}`;

// The product version is the VERSION file at the repository root (AGENTS.md section 2). The bundle
// carries it as `__APP_VERSION__`; the API client compares it with the version the server reports and
// raises "update available" when they differ (E-21). The service worker is built with the same value.
const appVersion = readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim();

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  // The router plugin must come before the React plugin.
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    // The HTML template and the files next to the build (plan 8.2, 7.5). Order matters: the boot script
    // goes in first, the font preload after it, and the compressed siblings are made last.
    ...nonceInline(),
    fontPreload(),
    precompress(),
  ],
  // The server replaces the placeholder with a fresh nonce on every request. Vite adds the
  // attribute to its script, stylesheet and preload tags and emits <meta property="csp-nonce">.
  // The token is the one of the __M365_*__ placeholder family in specs/001-m365portal/plan.md
  // (PD-15, section 8.2): the HTML-shell code substitutes exactly this string, so changing it
  // here without changing it there leaves the nonce unreplaced and the CSP blocks every asset.
  html: { cspNonce: '__M365_NONCE__' },
  build: {
    // No asset becomes a data: URI: the CSP lists neither img-src nor font-src data: (plan 8.1), and
    // the files are cached forever under their hash anyway.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': apiOrigin, '/healthz': apiOrigin },
  },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    css: false,
  },
});
