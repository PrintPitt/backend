# PrintPitt · backend

A single Node service (`node:http`, no database) for Railway: MON faucet, Rupiah → tIDRX top-up (simulated IDRX mint API),
gasless order relayer, `expire` keeper, order bot, and status. Full spec: repo `PrintPitt/vault` →
`04-Architecture/Desain Backend.md`.

## Run

```bash
npm install
cp .env.example .env     # fill in local values; on Railway set them under Variables, never commit them
npm start                # node src/server.ts (Node >= 23.6)
```

## Local test (anvil)

Needs Foundry and the `PrintPitt/contracts` repo next to this one (or set `CONTRACTS_DIR`).

```bash
npm test                 # anvil → deploy → service → 35 checks
```

## `@printpitt/shared`

Installed from `vendor/printpitt-shared-*.tgz`, so the Railway build needs no access to other private repos.
After ABIs/addresses change in the contracts repo: `npm run sync-shared`, then commit `vendor/` and `package-lock.json`.

## Deploy

`railway.json` + `Dockerfile` at the root. Keep replicas at 1 (the nonce queue lives in memory).

## Naming note

API paths, JSON fields, error codes and code identifiers are in Indonesian and are kept as-is because the live
frontend and contracts depend on them. Quick glossary: `toko` = shop, `pelanggan` = customer, `pesanan` = order request,
`bayar` = pay, `dokumen` = document, `lokasi` = location, `saldo` = balance, `kode` = access code, `sesi` = session,
`antre` = queue, `Siap` = ready for pickup, `Sengketa` = disputed, `Diputuskan` = resolved.
