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
    // Proxy /tiles/* to the production CloudFront so dev fetches the manifest
    // and PMTiles files same-origin (no CORS setup required for local dev).
    // Prod serves /tiles/* from the same CloudFront as the app, so the same
    // /tiles/manifest.json path works there too.
    proxy: {
      '/tiles': {
        target: 'https://pictomap.alex-knowlton.com',
        changeOrigin: true,
      },
    },
  },
  worker: {
    format: 'es',
  },
});
