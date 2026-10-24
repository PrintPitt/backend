// Faucet: sends starter MON to new accounts, once per address, through the tx queue (no nonce collisions).
// "Once per address" is checked onchain (balance 0 and nonce 0) plus an in-memory list, so no database is needed.
// Mainnet (real MON): FAUCET_KODE requires an access code (shown on stage) and FAUCET_MAX_TOTAL caps the total
// MON paid out; the total is stored in DATA_DIR/faucet.json so it survives restarts.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatEther, getAddress, isAddress, parseEther, type Address, type WalletClient } from 'viem';
import { ApiError, log, pesanError, type Koneksi } from '../common.ts';
import { buatAntrean } from './antrean.ts';

export function buatFaucet(k: Koneksi, wallet: WalletClient, opt: { amount: bigint; minBalance: bigint; dataDir?: string }) {
  const antrean = buatAntrean(k, wallet, 'faucet');
  const KODE = process.env.FAUCET_KODE ?? '';
  const MAX_TOTAL = process.env.FAUCET_MAX_TOTAL ? parseEther(process.env.FAUCET_MAX_TOTAL) : null;
  const fileTotal = opt.dataDir ? join(opt.dataDir, `faucet-${k.chainId}.json`) : null;
  let total = fileTotal && existsSync(fileTotal) ? BigInt(JSON.parse(readFileSync(fileTotal, 'utf8')).total) : 0n;
  // A failed file write must not make an already-sent tx be reported as failed.
  const simpanTotal = () => { try { if (fileTotal) writeFileSync(fileTotal, JSON.stringify({ total: total.toString() })); } catch (e) { log('faucet', `saving total failed: ${pesanError(e)}`); } };
  const from = antrean.alamat;
  const dipesan = new Set<Address>();             // addresses already queued or funded (while the service is up)
  const stats = { funded: 0, ditolak: 0, gagal: 0 };
  let cache = { at: 0, saldo: 0n };

  async function saldo() {
    if (Date.now() - cache.at > 2_000) cache = { at: Date.now(), saldo: await k.pub.getBalance({ address: from }) };
    return cache.saldo;
  }

  /** Validate + check the chain, then enqueue. Resolves once the tx is sent (without waiting for the receipt). */
  async function minta(raw: unknown, kode?: unknown) {
    if (KODE && kode !== KODE) throw new ApiError('BAD_CODE', 403);
    if (typeof raw !== 'string' || !isAddress(raw, { strict: false })) throw new ApiError('BAD_ADDRESS', 400);
    if (MAX_TOTAL !== null && total + opt.amount * BigInt(antrean.panjang() + 1) > MAX_TOTAL) throw new ApiError('FAUCET_LIMIT', 503);
    const to = getAddress(raw);
    if (dipesan.has(to)) { stats.ditolak++; throw new ApiError('ALREADY_FUNDED', 409); }
    dipesan.add(to);                                // reserve first, so two concurrent requests cannot both get through
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
