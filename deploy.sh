#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

npm run build

# --exclude "tiles/*" so --delete never touches the regional PMTiles, which are
# uploaded by the separate deploy-tiles.sh pipeline and never present in dist/.
aws s3 sync dist/ s3://alex-knowlton/pictomap/ --delete --exclude "tiles/*"

aws cloudfront create-invalidation \
  --distribution-id E1E554LKHU7HEM \
  --paths "/*"

