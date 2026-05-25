import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import mkcert from 'vite-plugin-mkcert';

// Geolocation requires HTTPS — even on localhost in some browsers — so the
// dev server runs over HTTPS by default via vite-plugin-mkcert (self-signed,
// installs a local CA the first time it runs).
export default defineConfig({
  plugins: [svelte(), mkcert()],
  server: {
    host: true,
    https: {},
    // build.protomaps.com serves PMTiles but does not send CORS headers, so
    // direct browser range requests are blocked. Proxy through the dev server
    // so the browser sees a same-origin response. Dev-only; prod must point
    // at a CORS-enabled host (see tasks.md § Tile data).
    proxy: {
      '/pmtiles': {
        target: 'https://build.protomaps.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/pmtiles/, ''),
      },
    },
  },
  worker: {
    format: 'es',
  },
});
