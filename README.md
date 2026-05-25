# Pictomap

Turn an uploaded image (silhouette, logo, drawing) into a runnable route. Drag the shape over the map at your location; we trace it, snap it to nearby roads/trails using a custom shape-aware matcher, and export GPX.

See [`tasks.md`](./tasks.md) for the full architecture, design decisions, and roadmap.

## Quick start

```bash
cp .env.example .env
# edit .env — set VITE_PMTILES_URL to a PMTiles archive URL (see Tile data below)
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

`VITE_PMTILES_URL` must point to a PMTiles archive containing at least Protomaps' road geometry at zoom 14+. Options:

- **Quick start** — point at a build from `https://build.protomaps.com/` (publicly-hosted daily world builds). Good for dev.
- **Production** — build your own with `planetiler` from a Geofabrik OSM extract and host on S3 + CloudFront. See `tasks.md` § Tile data.

## Stack

Svelte 5 + TypeScript + Vite • MapLibre GL JS + Protomaps PMTiles • custom in-browser HMM map matcher • localStorage + IndexedDB persistence • Sentry (optional). No backend.
