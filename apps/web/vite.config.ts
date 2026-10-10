import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Where `pnpm dev` finds the API server: the same PORT the server reads (FR-A-016; its default is
// 8080, see apps/server/src/listen.ts). The `dev` script of the server pins HOST=127.0.0.1.
const apiOrigin = `http://127.0.0.1:${process.env.PORT ?? '8080'}`;

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
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
