# PrintPitt · backend

Satu service Node (`node:http`, tanpa database) untuk Railway: faucet MON, top-up Rupiah → tIDRX (simulasi API mint IDRX),
relayer pesanan tanpa gas, keeper `expire`, order bot, dan status. Spesifikasi lengkap: repo `PrintPitt/vault` →
`04-Architecture/Desain Backend.md`.

## Jalankan

```bash
npm install
cp .env.example .env     # isi nilai lokal; di Railway isi lewat Variables, jangan commit
npm start                # node src/server.ts (Node >= 23.6)
```

## Uji lokal (anvil)

Butuh Foundry dan repo `PrintPitt/contracts` di sebelah repo ini (atau set `CONTRACTS_DIR`).

```bash
npm test                 # anvil → deploy → service → 35 pengecekan
```

## `@printpitt/shared`

Dipasang dari `vendor/printpitt-shared-*.tgz`, supaya build Railway tidak butuh akses ke repo private lain.
Setelah ABI/alamat berubah di repo contracts: `npm run sync-shared`, lalu commit `vendor/` dan `package-lock.json`.

## Deploy

`railway.json` + `Dockerfile` di root. Replika harus 1 (antrean nonce ada di memori).
