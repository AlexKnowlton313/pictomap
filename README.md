# Pictomap

Turn an uploaded image (silhouette, logo, drawing) into a runnable route. Drag the shape over the map at your location; we trace it, snap it to nearby roads/trails using a custom shape-aware matcher, and export GPX.

See [`tasks.md`](./tasks.md) for the full architecture, design decisions, and roadmap.

## Quick start

```bash
cp .env.example .env   # defaults work — Vite proxies /tiles/* to prod CloudFront
npm install
npm run dev
```

Open the printed `https://localhost:<port>` URL. **HTTPS is required** — the dev server uses `vite-plugin-mkcert` to issue a local self-signed cert because `navigator.geolocation` refuses to run on plain HTTP. On first run, mkcert installs a local CA; accept any system prompts. If your browser still warns, click through (it's the local cert).

## Scripts

| Script           | Purpose                                       |
| ---------------- | --------------------------------------------- |
| `npm run dev`    | HTTPS dev server with HMR                     |
| `npm run check`  | svelte-check + TypeScript type-check          |
| `npm run build`  | Type-check, then produce a production `dist/` |
| `npm run preview`| Serve the built `dist/` locally               |

## Tile data

Tiles are split into regional PMTiles archives (see `tiles/regions.json`) and a `manifest.json` at a stable URL. The app fetches the manifest at startup, geolocates, and picks the region whose bbox contains the user. Each regional archive must stay under CloudFront's 30GB per-object response cap — `deploy-tiles.sh` fails loudly otherwise so we know to split the bbox further.

- `./deploy-tiles.sh` — extract regions from Protomaps' daily planet build via `pmtiles extract --bbox=`, upload to S3, refresh the manifest. Also runs weekly via `.github/workflows/deploy-tiles.yml`.
- `VITE_TILES_MANIFEST_URL` — optional override, defaults to `/tiles/manifest.json`. Vite proxies `/tiles/*` to prod CloudFront so the default works in dev.

## Stack

Svelte 5 + TypeScript + Vite • MapLibre GL JS + Protomaps PMTiles • custom in-browser HMM map matcher • localStorage + IndexedDB persistence • Sentry (optional). No backend.
