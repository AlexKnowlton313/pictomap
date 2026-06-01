# Tile hosting migration: S3 + CloudFront → object store with cheaper egress

**Status:** proposal / not started · **Last updated:** 2026-05-31

This doc evaluates moving Pictomap's tile hosting off AWS (S3 + CloudFront) to a
cheaper object store — primarily **Cloudflare R2** or **Backblaze B2** — and
records the decision factors so we don't re-derive them later.

## Context

Pictomap serves large static PMTiles archives over HTTP range requests; there's
no tile server. Two pipelines write to `s3://alex-knowlton/pictomap/tiles/`:

- **Display tiles** (`tiles/build-display.sh`) — regional Protomaps subsets,
  z12–14, all layers. Large; the per-region build hard-fails above **30 GB** (a
  *CloudFront* per-object response cap).
- **Routing tiles** (`tiles/build-routing.sh`) — custom roads + ped paths, one
  high-resolution zoom. Much smaller (roads-only, single zoom).

Both are date-versioned and immutable, retained ~3 generations by the bucket's
**21-day lifecycle** (weekly builds). The app fetches `manifest.json` /
`routing-manifest.json` at a stable URL and resolves tile filenames *relative to
the manifest URL*, so the host is deliberately swappable. Prod serves
`/tiles/*` same-origin via CloudFront (`E1E554LKHU7HEM`); dev proxies `/tiles/*`
to that CloudFront in `vite.config.ts`.

## What actually drives cost

Today the bill is **storage-dominated, not egress-dominated**, because traffic
is low. We re-upload full generations weekly and retain a few hundred GB; the
display archives are the bulk. CloudFront egress is currently noise.

That flips if traffic grows: CloudFront egress (~$0.085/GB) is the priciest in
the market and is the cost that can balloon unboundedly. So the "cheapest host"
answer depends on the bottleneck — storage now, egress later.

## Options

Pricing is **approximate — confirm current rates before committing.**

| Host | Storage /GB/mo | Egress to users | Notes |
|------|----------------|-----------------|-------|
| **S3 + CloudFront** (current) | ~$0.023 | ~$0.085/GB | Priciest egress; 30 GB object cap |
| **Cloudflare R2** | ~$0.015 | **$0 (free egress)** | S3-compatible API; Protomaps' documented PMTiles host |
| **Backblaze B2** | ~$0.006 | $0 to Cloudflare (Bandwidth Alliance) | Cheapest storage; S3-compatible API |

At ~300 GB stored: S3 ≈ $7/mo, R2 ≈ $4.50/mo, B2 ≈ $1.80/mo — real but small in
absolute dollars. The large swing is egress at scale: 1 TB/mo of serving is
~$85 on CloudFront and **$0** on R2 or B2-behind-Cloudflare.

## Why a move is low-risk here

1. **PMTiles is built for this.** Static files + HTTP range requests, no server
   component — object store + CDN is the canonical pattern, and Protomaps
   explicitly documents R2/B2. Range requests work on all three.
2. **The deploy scripts already speak S3.** R2 and B2 expose S3-compatible APIs,
   so the `aws s3 cp` calls (now centralized in `tiles/lib.sh`'s `upload_archive`,
   plus `tiles/assemble-manifest.sh`) change by ~one line each — endpoint +
   credentials.
3. **Manifest-relative URLs.** Clients resolve tile filenames relative to the
   manifest URL, so re-pointing `/tiles/*` at a new origin needs no app change.
4. **The 30 GB cap is CloudFront-specific** and relaxes off CloudFront (R2/B2
   single-object limits are far higher).

### The one real gotcha: same-origin / CORS

The app assumes tiles are **same-origin** (no CORS headers configured). If the
app stays on CloudFront and only tiles move to Cloudflare, requests become
cross-origin and need CORS on the bucket/CDN. The clean version is moving app +
tiles **together** (e.g. Cloudflare Pages + R2) to preserve same-origin and
drop AWS entirely. A partial move is possible but must add CORS.

> Cloudflare CDN note: lower plans cap the *cacheable* object size, so a 30 GB
> archive may not edge-cache as a whole. With range requests this is mostly
> moot — and R2 origin reads are cheap (~$0.36/M) with free R2→Cloudflare
> egress — but verify range/large-object caching behavior on the target plan.

## Recommendation

- **If any traffic growth is expected → migrate to Cloudflare R2.** Sweet spot:
  S3-compatible (scripts barely change), cheaper storage, and free egress
  removes the only cost that can explode. It's also the Protomaps-blessed
  PMTiles host.
- **If it stays hobby-scale → don't migrate yet.** A few hundred GB on S3 is
  ~$5–10/mo. Take the free win instead (below) and revisit if egress shows up.

### Free quick win (no migration)

Drop the bucket lifecycle from **21 → 14 days** (3 generations → 2): ~⅓ off
storage, zero migration, no downside — clients only ever use the latest
generation listed in the manifest.

## Open decisions

- [ ] Confirm current R2 / B2 / S3+CloudFront pricing at our storage + traffic.
- [ ] Decide scope: tiles-only (adds CORS) vs. app + tiles together (same-origin).
- [ ] If migrating: parameterize the deploy scripts' S3 endpoint/credentials so
      they target either S3 or an S3-compatible store via env (no logic fork).
- [ ] Independent of host: trim retained generations (21 → 14 days).

## References

- `tiles/build-display.sh`, `tiles/build-routing.sh`, `tiles/assemble-manifest.sh`, `tiles/lib.sh` — upload pipelines + shared scaffolding.
- `src/lib/tiles/manifest.ts` — manifest fetch + manifest-relative URL resolution.
- [`docs/tasks.md`](./tasks.md) — overall architecture and roadmap.
- `CLAUDE.md` § Deployment / Tiles architecture.
