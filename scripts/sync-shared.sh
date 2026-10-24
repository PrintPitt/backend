#!/usr/bin/env bash
# Pull the latest @printpitt/shared package from the contracts repo (default ../contracts) and store it as a tarball in vendor/.
# Used while the repos are private: the Docker/Railway build needs no GitHub access to other repos.
# Run after ABIs/addresses change (new deploy + node script/export.mjs in the contracts repo), then commit vendor/ and package-lock.json.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACTS="${CONTRACTS_DIR:-$HERE/../contracts}"
SHARED="$CONTRACTS/shared"
[ -f "$SHARED/package.json" ] || { echo "Cannot find $SHARED (set CONTRACTS_DIR)"; exit 1; }
[ -d "$SHARED/node_modules" ] || npm --prefix "$SHARED" install --no-audit --no-fund
npm --prefix "$SHARED" run build
rm -f "$HERE"/vendor/printpitt-shared-*.tgz
TGZ="$(cd "$SHARED" && npm pack --pack-destination "$HERE/vendor" --silent)"
cd "$HERE"
npm install --no-audit --no-fund "./vendor/$TGZ"
echo "vendor/$TGZ installed"
