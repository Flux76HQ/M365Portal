import { DEFAULT_PORT } from '@m365portal/shared/limits';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Where `pnpm dev` finds the API server: the same PORT the server reads, with the same default
// (FR-A-016; @m365portal/shared/limits defines it once). The `dev` script of the server pins
// HOST=127.0.0.1.
const apiOrigin = `http://127.0.0.1:${process.env.PORT ?? String(DEFAULT_PORT)}`;

export default defineConfig({
  // The router plugin must come before the React plugin.
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  // The server replaces the placeholder with a fresh nonce on every request. Vite adds the
  // attribute to its script, stylesheet and preload tags and emits <meta property="csp-nonce">.
  // The token is the one of the __M365_*__ placeholder family in specs/001-m365portal/plan.md
  // (PD-15, section 8.2): the HTML-shell code substitutes exactly this string, so changing it
  // here without changing it there leaves the nonce unreplaced and the CSP blocks every asset.
  html: { cspNonce: '__M365_NONCE__' },
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
