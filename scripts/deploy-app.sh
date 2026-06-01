#!/usr/bin/env bash
# Build the app and publish it to S3 + invalidate CloudFront.
# Tile archives are uploaded by the separate tiles/build-*.sh pipelines and are
# never present in dist/, so the app deploy leaves them untouched.
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root

echo "==> Building (npm run build)"
npm run build

# --exclude "tiles/*" so --delete never touches the regional PMTiles, which are
# uploaded by tiles/build-display.sh / tiles/build-routing.sh and not in dist/.
echo "==> Syncing dist/ to S3"
aws s3 sync dist/ s3://alex-knowlton/pictomap/ --delete --exclude "tiles/*"

echo "==> Invalidating CloudFront"
aws cloudfront create-invalidation \
  --distribution-id E1E554LKHU7HEM \
  --paths "/*"

echo "==> Done"
