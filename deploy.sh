#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

npm run build

aws s3 sync dist/ s3://alex-knowlton/pictomap/ --delete

aws cloudfront create-invalidation \
  --distribution-id E1E554LKHU7HEM \
  --paths "/*"

