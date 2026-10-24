#!/usr/bin/env bash
# Isi wallet peran (dummy testnet) dari wallet deployer sampai saldo target. Hanya Monad testnet (chain 10143).
# Wallet yang sudah mencapai target dilewati, jadi aman dijalankan ulang.
#   bash scripts/isi-wallet-peran.sh            # tampilkan rencana lalu minta konfirmasi
#   DRY_RUN=1 bash scripts/isi-wallet-peran.sh  # hanya tampilkan rencana
# Faucet butuh > 10 MON karena reserve balance Monad (DEV-20).
set -euo pipefail
export PATH="$PATH:$HOME/.foundry/bin"
RPC="${RPC_URL:-https://testnet-rpc.monad.xyz}"
DEPLOYER=0xf94e039dc723De798F065cFC3202Eedb040D8415
WALLET=(--account printpitt-deployer --password-file "$HOME/.foundry/printpitt-deployer.pass")

[ "$(cast chain-id --rpc-url "$RPC")" = "10143" ] || { echo "Bukan Monad testnet (10143), berhenti."; exit 1; }

# peran alamat target_MON. Dari uji beban: relayer ~0,044 MON/pesanan, bot ~0,03 MON/order,
# faucet 0,05 MON/penonton + 10 MON reserve, toko ~0,02-0,03 MON/order.
TARGET=(
  "faucet  0x057BbDE8b0560f078058BF3A0d4ed0ACdE7786cB 30"
  "relayer 0xBD30D15C1A9FAD3f7Cf4a68cB941aD44fea693aE 20"
  "keeper  0x612F0C3b0e27668d84d10C79d91921C21bd068CB 3"
  "minter  0x382D1cfe4036f977C1d7A4ecF8B81E1e67F89e7d 3"
  "bot     0x8e6363dB5A36df6e269357Ce0699acDD6900935b 5"
  "toko-a  0xD9B470dd86E9876B59Ec4CCd797811D5a8f293e0 2"
  "toko-b  0x8B0a62CA2523E33a1B51E28069613f6039Ea1c7F 2"
)

total=0; rencana=()
for baris in "${TARGET[@]}"; do
  read -r peran alamat target <<<"$baris"
  saldo=$(cast balance "$alamat" --rpc-url "$RPC")
  kurang=$(python3 -c "print(max(0, int($target * 10**18) - $saldo))")
  printf '%-8s %s saldo %s MON, kirim %s MON\n' "$peran" "$alamat" "$(cast from-wei "$saldo")" "$(cast from-wei "$kurang")"
  if [ "$kurang" != "0" ]; then rencana+=("$peran $alamat $kurang"); total=$(python3 -c "print($total + $kurang)"); fi
done
sisa=$(cast balance "$DEPLOYER" --rpc-url "$RPC")
echo "Total kirim $(cast from-wei "$total") MON dari deployer (saldo $(cast from-wei "$sisa") MON)"
[ "${#rencana[@]}" -eq 0 ] && { echo "Semua wallet sudah mencapai target."; exit 0; }
python3 -c "import sys; sys.exit(0 if $sisa - $total > 11 * 10**18 else 1)" || { echo "Saldo deployer kurang (harus tetap > 11 MON setelah kirim)."; exit 1; }
[ "${DRY_RUN:-}" = "1" ] && { echo "DRY_RUN: tidak ada yang dikirim."; exit 0; }
read -r -p "Kirim sekarang? (ketik ya) " jawab
[ "$jawab" = "ya" ] || { echo "Batal."; exit 0; }

for baris in "${rencana[@]}"; do
  read -r peran alamat kurang <<<"$baris"
  hash=$(cast send "$alamat" --value "$kurang" "${WALLET[@]}" --rpc-url "$RPC" --json | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['transactionHash'], 'status', int(r['status'],16))")
  echo "$peran: $hash"
done
