#!/usr/bin/env bash
# Test voucher mode + faucet access code + faucet total cap + HARGA_BAGI on anvil (anvil public test keys).
set -uo pipefail
export PATH="$PATH:$HOME/.foundry/bin"
BE="$(cd "$(dirname "$0")/.." && pwd)"; C="${CONTRACTS_DIR:-$BE/../contracts}"
RPC=http://127.0.0.1:8551; API=http://127.0.0.1:8791; DATA=$(mktemp -d)
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
K5=0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
K6=0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e
anvil --port 8551 --code-size-limit 131072 --silent >/dev/null 2>&1 & A=$!
trap 'kill $A ${SV:-} 2>/dev/null; pkill -f "PORT=8791" 2>/dev/null; lsof -ti :8791 | xargs kill 2>/dev/null; rm -rf "$DATA"' EXIT
for i in $(seq 100); do cast chain-id --rpc-url $RPC >/dev/null 2>&1 && break; sleep 0.1; done
cd $C && HARGA_BAGI=10 forge script script/Deploy.s.sol --rpc-url $RPC --private-key $K0 --broadcast >/dev/null 2>&1
FK=$(node -p "require('./deployments/31337.json').fotokopiKilat"); T=$(node -p "require('./deployments/31337.json').tidrx"); KAS=$(cast wallet address $K6)
echo "katalog 1 harga: $(cast call $FK 'hargaUntuk(uint8,uint16)(uint96,uint32)' 1 1 --rpc-url $RPC | head -1) (expect 50000 = Rp500)"
cast send $T 'mint(address,uint256)' $KAS 1200000 --private-key $K0 --rpc-url $RPC >/dev/null   # treasury holds Rp12,000
cd $BE && DATA_DIR=$DATA IDRX_MODE=voucher TOPUP_KODE=juri123 TOPUP_VOUCHER_RP=5000 FAUCET_KODE=juri123 FAUCET_MAX_TOTAL=0.1 FAUCET_AMOUNT=0.05 FAUCET_MIN_BALANCE=0 \
  RPC_URL=$RPC CONTRACT_ADDRESS=$FK TOKEN_ADDRESS=$T BATAS_ANTRE=45 PORT=8791 FAUCET_PRIVATE_KEY=$K5 MINTER_PRIVATE_KEY=$K6 KEEPER=off ALLOWED_ORIGIN='*' node src/server.ts > $DATA/log 2>&1 & SV=$!
for i in $(seq 100); do curl -sf $API/health >/dev/null && break; sleep 0.1; done
baru() { echo 0x$(openssl rand -hex 20); }
post() { curl -s -w ' %{http_code}' -X POST $API$1 -H 'content-type: application/json' -d "$2"; echo; }
J1=$(baru); J2=$(baru); J3=$(baru)
tu() { post /topup "$(printf '{"destinationWalletAddress":"%s","kode":"%s"}' "$1" "$2")"; }
fa() { post /faucet "$(printf '{"address":"%s","kode":"%s"}' "$1" "$2")"; }
echo "voucher without code: $(post /topup "$(printf '{"destinationWalletAddress":"%s"}' $J1)")"
echo "voucher wrong code:   $(tu $J1 x)"
R=$(tu $J1 juri123); echo "voucher right code:   ${R: -3}"
sleep 2; echo "saldo J1: $(cast call $T 'balanceOf(address)(uint256)' $J1 --rpc-url $RPC) (expect 500000 = Rp5,000)"
echo "voucher twice:        $(tu $J1 juri123)"
R=$(tu $J2 juri123); echo "voucher J2:           ${R: -3}"; sleep 2
echo "voucher with Rp2,000 left in treasury: $(tu $J3 juri123)"
echo "faucet without code:  $(post /faucet "$(printf '{"address":"%s"}' $J1)")"
R=$(fa $J1 juri123); echo "faucet right code #1: ${R: -3}"
R=$(fa $J2 juri123); echo "faucet right code #2: ${R: -3}"
echo "faucet over total cap 0.1: $(fa $J3 juri123)"
echo "status: $(curl -s $API/status | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['topup']['voucher'], 'faucet total', d['faucet']['total'], 'max', d['faucet']['maks'])")"
echo "--- log ---"; grep -vE "\[http\]" $DATA/log | tail -8
