#!/usr/bin/env bash
# Sapu sisa saldo hot wallet mainnet (Monad 143) ke wallet pribadi setelah demo. Dijalankan oleh pemilik dana.
#   TUJUAN=0x… bash scripts/sapu-mainnet.sh            # tampilkan rencana lalu minta konfirmasi
#   TUJUAN=0x… DRY_RUN=1 bash scripts/sapu-mainnet.sh  # hanya rencana
#   SAPU_DEPLOYER=1 …                                   # ikut sapu deployer/operator (sisakan 0,2 MON untuk operasi)
# Sebelum menyapu, hentikan backend-mainnet supaya faucet/relayer/keeper tidak mengirim tx bersamaan:
#   railway variable set FAUCET_MAX_TOTAL=0 --skip-deploys --service backend-mainnet
#   railway variable set KEEPER=off --service backend-mainnet
# Urutan per wallet: token IDRX asli dulu (butuh MON untuk gas), lalu MON dikurangi biaya gas.
set -euo pipefail
export PATH="$PATH:$HOME/.foundry/bin"
RPC="${RPC_URL:-https://rpc.monad.xyz}"
IDRX=0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22
: "${TUJUAN:?Set TUJUAN=<alamat wallet pribadi>}"
[ "$(cast chain-id --rpc-url "$RPC")" = "143" ] || { echo "Bukan Monad mainnet (143), berhenti."; exit 1; }
cast to-check-sum-address "$TUJUAN" >/dev/null || { echo "TUJUAN bukan alamat valid"; exit 1; }

AKUN=(faucet relayer keeper kas toko-demo)
[ "${SAPU_DEPLOYER:-}" = "1" ] && AKUN+=(deployer)
GAS_PRICE=$(cast gas-price --rpc-url "$RPC")
MAX_FEE=$((GAS_PRICE * 2))                      # Monad menagih gas limit × harga efektif (≤ max fee)
BIAYA_MON=$((21000 * MAX_FEE)); BIAYA_TOKEN=$((100000 * MAX_FEE))

rencana=()
for r in "${AKUN[@]}"; do
  n="printpitt-main-$r"; pw="$HOME/.foundry/$n.pass"
  [ -e "$HOME/.foundry/keystores/$n" ] || { echo "$r: keystore tidak ada, dilewati"; continue; }
  a=$(cast wallet address --account "$n" --password-file "$pw")
  mon=$(cast balance "$a" --rpc-url "$RPC"); idrx=$(cast call $IDRX 'balanceOf(address)(uint256)' "$a" --rpc-url "$RPC" | cut -d' ' -f1)
  sisa=0; [ "$r" = "deployer" ] && sisa=200000000000000000
  biaya=$BIAYA_MON; [ "$idrx" != "0" ] && biaya=$((BIAYA_MON + BIAYA_TOKEN))
  kirim=$(python3 -c "print(max(0, $mon - $biaya - $sisa))")
  printf '%-10s %s  MON %s → kirim %s  ·  IDRX %s\n' "$r" "$a" "$(cast from-wei "$mon")" "$(cast from-wei "$kirim")" "$(python3 -c "print($idrx/100)")"
  rencana+=("$n $a $kirim $idrx")
done
echo "Tujuan: $TUJUAN (chain 143)"
[ "${DRY_RUN:-}" = "1" ] && { echo "DRY_RUN: tidak ada yang dikirim."; exit 0; }
read -r -p "Kirim semua sekarang? (ketik ya) " jawab
[ "$jawab" = "ya" ] || { echo "Batal."; exit 0; }

for baris in "${rencana[@]}"; do
  read -r n a kirim idrx <<<"$baris"
  W=(--account "$n" --password-file "$HOME/.foundry/$n.pass" --rpc-url "$RPC")
  if [ "$idrx" != "0" ]; then
    cast send $IDRX 'transfer(address,uint256)' "$TUJUAN" "$idrx" --gas-limit 100000 --gas-price $MAX_FEE "${W[@]}" --json \
      | python3 -c "import sys,json; r=json.load(sys.stdin); print('${n#printpitt-main-} IDRX', r['transactionHash'], 'status', int(r['status'],16))"
  fi
  if [ "$kirim" != "0" ]; then
    cast send "$TUJUAN" --value "$kirim" --gas-limit 21000 --gas-price $MAX_FEE "${W[@]}" --json \
      | python3 -c "import sys,json; r=json.load(sys.stdin); print('${n#printpitt-main-} MON', r['transactionHash'], 'status', int(r['status'],16))"
  fi
done
echo "Selesai. Sisa debu gas di tiap wallet wajar."
