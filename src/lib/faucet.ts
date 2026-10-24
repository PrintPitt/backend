// Faucet: kirim saldo awal MON ke akun baru, sekali per alamat, lewat antrean tx (nonce tidak bentrok).
// "Sekali per alamat" dicek di chain (saldo 0 dan nonce 0) + daftar di memori, jadi tidak perlu database.
// Mainnet (MON asli): FAUCET_KODE mewajibkan kode akses (ditampilkan di panggung) dan FAUCET_MAX_TOTAL membatasi total
// MON yang boleh keluar; totalnya disimpan di DATA_DIR/faucet.json supaya tetap berlaku setelah restart.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatEther, getAddress, isAddress, parseEther, type Address, type WalletClient } from 'viem';
import { ApiError, type Koneksi } from '../common.ts';
import { buatAntrean } from './antrean.ts';

export function buatFaucet(k: Koneksi, wallet: WalletClient, opt: { amount: bigint; minBalance: bigint; dataDir?: string }) {
  const antrean = buatAntrean(k, wallet, 'faucet');
  const KODE = process.env.FAUCET_KODE ?? '';
  const MAX_TOTAL = process.env.FAUCET_MAX_TOTAL ? parseEther(process.env.FAUCET_MAX_TOTAL) : null;
  const fileTotal = opt.dataDir ? join(opt.dataDir, `faucet-${k.chainId}.json`) : null;
  let total = fileTotal && existsSync(fileTotal) ? BigInt(JSON.parse(readFileSync(fileTotal, 'utf8')).total) : 0n;
  const simpanTotal = () => { if (fileTotal) writeFileSync(fileTotal, JSON.stringify({ total: total.toString() })); };
  const from = antrean.alamat;
  const dipesan = new Set<Address>();             // alamat yang sudah diantrekan atau dikirimi (selama service hidup)
  const stats = { funded: 0, ditolak: 0, gagal: 0 };
  let cache = { at: 0, saldo: 0n };

  async function saldo() {
    if (Date.now() - cache.at > 2_000) cache = { at: Date.now(), saldo: await k.pub.getBalance({ address: from }) };
    return cache.saldo;
  }

  /** Validasi + cek chain, lalu antrekan. Resolve begitu tx terkirim (tanpa menunggu receipt). */
  async function minta(raw: unknown, kode?: unknown) {
    if (KODE && kode !== KODE) throw new ApiError('BAD_CODE', 403);
    if (typeof raw !== 'string' || !isAddress(raw, { strict: false })) throw new ApiError('BAD_ADDRESS', 400);
    if (MAX_TOTAL !== null && total + opt.amount * BigInt(antrean.panjang() + 1) > MAX_TOTAL) throw new ApiError('FAUCET_LIMIT', 503);
    const to = getAddress(raw);
    if (dipesan.has(to)) { stats.ditolak++; throw new ApiError('ALREADY_FUNDED', 409); }
    dipesan.add(to);                                // dipesan dulu, supaya dua permintaan bersamaan tidak lolos dua-duanya
    try {
      const [bal, n] = await Promise.all([k.pub.getBalance({ address: to }), k.pub.getTransactionCount({ address: to })]);
      if (bal > 0n || n > 0) { stats.ditolak++; throw new ApiError('ALREADY_FUNDED', 409); }
      if ((await saldo()) < opt.minBalance + opt.amount * BigInt(antrean.panjang() + 1)) { dipesan.delete(to); throw new ApiError('FAUCET_EMPTY', 503); }
    } catch (e) {
      if (!(e instanceof ApiError)) { dipesan.delete(to); throw new ApiError('RPC_ERROR', 502); }
      throw e;
    }
    try {
      const hash = await antrean.kirim({ to, value: opt.amount, gas: 21_000n });
      stats.funded++; cache.saldo -= opt.amount;
      total += opt.amount; simpanTotal();
      return { hash, amount: formatEther(opt.amount) };
    } catch {
      stats.gagal++; dipesan.delete(to);
      throw new ApiError('SEND_FAILED', 502);
    }
  }

  return {
    minta, stats, alamat: from, panjangAntre: antrean.panjang, saldo,
    batas: () => ({ pakaiKode: !!KODE, total: formatEther(total), maks: MAX_TOTAL === null ? null : formatEther(MAX_TOTAL) }),
  };
}
