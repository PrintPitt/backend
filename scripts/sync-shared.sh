#!/usr/bin/env bash
# Ambil package @printpitt/shared terbaru dari repo contracts (default ../contracts) dan simpan sebagai tarball di vendor/.
# Dipakai selama repo masih private: build Docker/Railway tidak butuh akses GitHub ke repo lain.
# Jalankan setelah ABI/alamat berubah (deploy baru + node script/export.mjs di repo contracts), lalu commit vendor/ dan package-lock.json.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACTS="${CONTRACTS_DIR:-$HERE/../contracts}"
SHARED="$CONTRACTS/shared"
[ -f "$SHARED/package.json" ] || { echo "Tidak menemukan $SHARED (set CONTRACTS_DIR)"; exit 1; }
[ -d "$SHARED/node_modules" ] || npm --prefix "$SHARED" install --no-audit --no-fund
npm --prefix "$SHARED" run build
rm -f "$HERE"/vendor/printpitt-shared-*.tgz
TGZ="$(cd "$SHARED" && npm pack --pack-destination "$HERE/vendor" --silent)"
cd "$HERE"
npm install --no-audit --no-fund "./vendor/$TGZ"
echo "vendor/$TGZ terpasang"
