#!/usr/bin/env bash
# Rebuild the locally hosted, pinned Media Chrome bundle without runtime CDNs.
set -euo pipefail
player_build_dir=$(mktemp -d)
trap 'rm -rf "$player_build_dir"' EXIT
player_repo_dir=$(cd "$(dirname "$0")/.." && pwd)
npm install --prefix "$player_build_dir" --no-audit --no-fund media-chrome@4.19.3 esbuild@0.25.12
"$player_build_dir/node_modules/.bin/esbuild" "$player_build_dir/node_modules/media-chrome/dist/index.js" \
  --bundle --format=esm --minify --target=es2020 \
  --outfile="$player_repo_dir/app/static/vendor/media-chrome-4.19.3.js"
cp "$player_build_dir/node_modules/media-chrome/LICENSE" "$player_repo_dir/app/static/vendor/media-chrome-LICENSE.txt"
