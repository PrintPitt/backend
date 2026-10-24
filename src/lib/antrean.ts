// Antrean tx per wallet: satu worker, nonce lokal, supaya banyak permintaan bersamaan tidak bentrok nonce.
// Dipakai faucet (MON), minter (tIDRX), dan relayer (createOrderFor). Satu wallet = satu antrean.
import type { Address, Hash, Hex, WalletClient } from 'viem';
import { log, pesanError, type Koneksi } from '../common.ts';

export type TxReq = { to: Address; data?: Hex; value?: bigint; gas: bigint };
type Job = { req: TxReq; resolve: (h: Hash) => void; reject: (e: Error) => void };

export function buatAntrean(k: Koneksi, wallet: WalletClient, tag: string) {
  const from = wallet.account!.address;
  const antre: Job[] = [];
  const stats = { terkirim: 0, gagal: 0 };
  let nonce: number | null = null, jalan = false;
  let fee = { at: 0, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n };

  const syncNonce = async () => { nonce = await k.pub.getTransactionCount({ address: from, blockTag: 'pending' }); };
  async function fees() {
    if (Date.now() - fee.at < 10_000) return fee;
    const f = await k.pub.estimateFeesPerGas();
    fee = { at: Date.now(), maxFeePerGas: f.maxFeePerGas!, maxPriorityFeePerGas: f.maxPriorityFeePerGas! };
    return fee;
  }

  /** Antrekan satu tx. Resolve dengan hash begitu tx diterima node (tanpa menunggu receipt). */
  function kirim(req: TxReq) {
    return new Promise<Hash>((resolve, reject) => { antre.push({ req, resolve, reject }); void kerja(); });
  }

  /** Kirim berurutan; error nonce -> sinkron ulang dari chain, maks. 3 kali. */
  async function kerja() {
    if (jalan) return; jalan = true;
    try {
      while (antre.length) {
        const job = antre.shift()!;
        const mulai = Date.now();
        for (let coba = 0; ; coba++) {
          try {
            if (nonce === null) await syncNonce();
            const f = await fees();
            // Tanda tangani lokal lalu kirim raw: 1 request RPC per tx (sendTransaction viem menambah eth_chainId tiap kirim).
            const mentah = await wallet.account!.signTransaction!({
              type: 'eip1559', chainId: k.chainId, ...job.req,
              nonce: nonce!, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas,
            });
            const hash = await k.pub.sendRawTransaction({ serializedTransaction: mentah });
            nonce!++; stats.terkirim++;
            if (Date.now() - mulai > 5000) log(tag, `kirim lambat ${Date.now() - mulai} ms (coba ${coba + 1}, antre ${antre.length})`);
            job.resolve(hash);
            break;
          } catch (e) {
            const msg = pesanError(e);
            if (coba < 3 && /nonce|replacement|underpriced|already known/i.test(msg)) { log(tag, `sinkron nonce (${msg})`); await syncNonce(); continue; }
            stats.gagal++; nonce = null;
            log(tag, `gagal kirim ke ${job.req.to}: ${msg}`);
            job.reject(e as Error);
            break;
          }
        }
      }
    } finally { jalan = false; }
  }

  return { kirim, stats, alamat: from, panjang: () => antre.length };
}

export type Antrean = ReturnType<typeof buatAntrean>;
