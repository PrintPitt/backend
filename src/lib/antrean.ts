// Per-wallet tx queue: one worker and a local nonce, so many concurrent requests never collide on nonces.
// Used by the faucet (MON), minter (tIDRX) and relayer (createOrderFor). One wallet = one queue.
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

  /** Enqueue one tx. Resolves with the hash as soon as the node accepts it (without waiting for the receipt). */
  function kirim(req: TxReq) {
    return new Promise<Hash>((resolve, reject) => { antre.push({ req, resolve, reject }); void kerja(); });
  }

  /** Send sequentially; on a nonce error, resync from the chain, up to 3 times. */
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
            // Sign locally and send raw: 1 RPC request per tx (viem's sendTransaction adds an eth_chainId call on every send).
            const mentah = await wallet.account!.signTransaction!({
              type: 'eip1559', chainId: k.chainId, ...job.req,
              nonce: nonce!, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas,
            });
            const hash = await k.pub.sendRawTransaction({ serializedTransaction: mentah });
            nonce!++; stats.terkirim++;
            if (Date.now() - mulai > 5000) log(tag, `slow send ${Date.now() - mulai} ms (attempt ${coba + 1}, queued ${antre.length})`);
            job.resolve(hash);
            break;
          } catch (e) {
            const msg = pesanError(e);
            if (coba < 3 && /nonce|replacement|underpriced|already known/i.test(msg)) { log(tag, `nonce resync (${msg})`); await syncNonce(); continue; }
            stats.gagal++; nonce = null;
            log(tag, `send to ${job.req.to} failed: ${msg}`);
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
