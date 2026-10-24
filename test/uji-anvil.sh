#!/usr/bin/env bash
# Uji backend lokal: anvil -> deploy contract -> export -> service -> uji-backend.mjs -> bersih-bersih.
# Kunci yang dipakai adalah kunci uji publik bawaan anvil (#0 operator, #1/#2 toko, #3 bot, #4 keeper, #5 faucet,
# #6 minter tIDRX, #7 relayer),
# hanya untuk chain lokal 31337.
set -euo pipefail
export PATH="$PATH:$HOME/.foundry/bin"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# Repo contracts di sebelah repo backend (bisa diganti lewat CONTRACTS_DIR).
CONTRACTS="${CONTRACTS_DIR:-$HERE/../contracts}"
PORT_RPC=8549; PORT_API=8788; RPC="http://127.0.0.1:$PORT_RPC"
LOG="$(mktemp -t fk-backend-uji)"
DATA="$(mktemp -d -t fk-backend-data)"
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
K3=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
K4=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
K5=0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
K6=0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e
K7=0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356

anvil --port $PORT_RPC --silent >/dev/null 2>&1 & ANVIL=$!
SERVER=""
trap 'kill $ANVIL ${SERVER:-} 2>/dev/null || true; rm -f "$LOG"; rm -rf "$DATA"' EXIT
for i in $(seq 100); do cast chain-id --rpc-url $RPC >/dev/null 2>&1 && break; sleep 0.1; done

cd "$CONTRACTS"
HARGA_PRO=100000 TOKO_A=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 TOKO_B=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC MINTER=$(cast wallet address $K6) \
  forge script script/Deploy.s.sol --rpc-url $RPC --private-key $K0 --broadcast >/dev/null 2>&1
# Alamat dibaca dari hasil deploy, jadi tidak bergantung pada versi vendor/@printpitt/shared.
FK=$(node -p "require('./deployments/31337.json').fotokopiKilat"); TIDRX=$(node -p "require('./deployments/31337.json').tidrx")
echo "FotokopiKilat $FK · tIDRX $TIDRX"

cd "$HERE"
DATA_DIR="$DATA" DOKUMEN_KEY=$(openssl rand -hex 32) INDEKS_INTERVAL_MS=500 RPC_URL=$RPC CONTRACT_ADDRESS=$FK TOKEN_ADDRESS=$TIDRX BATAS_ANTRE=45 PORT=$PORT_API FAUCET_PRIVATE_KEY=$K5 KEEPER_PRIVATE_KEY=$K4 BOT_PRIVATE_KEY=$K3 \
  MINTER_PRIVATE_KEY=$K6 RELAYER_PRIVATE_KEY=$K7 \
  ALLOWED_ORIGIN=https://fotokopi-kilat.vercel.app ADMIN_TOKEN=uji-lokal RATE_LIMIT_PER_MIN=100 \
  node src/server.ts > "$LOG" 2>&1 & SERVER=$!
for i in $(seq 100); do curl -sf http://127.0.0.1:$PORT_API/health >/dev/null && break; sleep 0.1; done

BASE=http://127.0.0.1:$PORT_API RPC_URL=$RPC ADMIN_TOKEN=uji-lokal ORIGIN_OK=https://fotokopi-kilat.vercel.app \
  node test/uji-backend.mjs || GAGAL=1
echo "--- log service (ekor) ---"; { grep -E "keeper|receipt|rpc" "$LOG" || true; } | tail -8; tail -4 "$LOG"
exit "${GAGAL:-0}"
