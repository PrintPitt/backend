// Faucet: kirim saldo awal MON ke akun baru, sekali per alamat, lewat antrean tx (nonce tidak bentrok).
// "Sekali per alamat" dicek di chain (saldo 0 dan nonce 0) + daftar di memori, jadi tidak perlu database.
import { formatEther, getAddress, isAddress, type Address, type WalletClient } from 'viem';
import { ApiError, type Koneksi } from '../common.ts';
import { buatAntrean } from './antrean.ts';

export function buatFaucet(k: Koneksi, wallet: WalletClient, opt: { amount: bigint; minBalance: bigint }) {
  const antrean = buatAntrean(k, wallet, 'faucet');
  const from = antrean.alamat;
  const dipesan = new Set<Address>();             // alamat yang sudah diantrekan atau dikirimi (selama service hidup)
  const stats = { funded: 0, ditolak: 0, gagal: 0 };
  let cache = { at: 0, saldo: 0n };

  async function saldo() {
    if (Date.now() - cache.at > 2_000) cache = { at: Date.now(), saldo: await k.pub.getBalance({ address: from }) };
    return cache.saldo;
  }

  /** Validasi + cek chain, lalu antrekan. Resolve begitu tx terkirim (tanpa menunggu receipt). */
  async function minta(raw: unknown) {
    if (typeof raw !== 'string' || !isAddress(raw, { strict: false })) throw new ApiError('BAD_ADDRESS', 400);
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
      return { hash, amount: formatEther(opt.amount) };
    } catch {
      stats.gagal++; dipesan.delete(to);
      throw new ApiError('SEND_FAILED', 502);
    }
  }

  return { minta, stats, alamat: from, panjangAntre: antrean.panjang, saldo };
}
