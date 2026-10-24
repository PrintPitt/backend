// Keeper: panggil `expire` untuk order yang lewat batas antre (Open) atau batas kerja (Claimed).
// Waktu dibandingkan dengan timestamp blok terbaru (bukan jam lokal), supaya cocok dengan contract.
import type { WalletClient } from 'viem';
import { GAS_LIMIT, STATUS } from '@printpitt/shared';
import { log, pesanError, type Koneksi } from '../common.ts';

export function buatKeeper(k: Koneksi, wallet: WalletClient) {
  const { pub, contract, batasAntre } = k;
  const aktif = new Set<bigint>();                 // id yang belum final (Open/Claimed); id final tidak dipindai lagi
  let berikutnya = 1n;
  const stats = { putaran: 0, expired: 0, gagal: 0 };

  async function putaran() {
    stats.putaran++;
    const nextId = await pub.readContract({ ...contract, functionName: 'nextId' });
    for (; berikutnya < nextId; berikutnya++) aktif.add(berikutnya);
    if (aktif.size === 0) return;
    const { timestamp: now } = await pub.getBlock();
    const ids = [...aktif];
    // Satu multicall untuk semua order aktif (RPC publik dibatasi per detik); anvil tanpa Multicall3 → baca satu per satu.
    const orders = pub.chain?.contracts?.multicall3
      ? await pub.multicall({ contracts: ids.map((id) => ({ ...contract, functionName: 'getOrder', args: [id] }) as const), allowFailure: false })
      : await Promise.all(ids.map((id) => pub.readContract({ ...contract, functionName: 'getOrder', args: [id] })));
    for (const [i, id] of ids.entries()) {
      const o = orders[i];
      const status = STATUS[o.status];
      if (status === 'Finished' || status === 'Expired') { aktif.delete(id); continue; }
      const lewat =
        (status === 'Open' && now >= BigInt(o.dibuatPada) + batasAntre) ||
        (status === 'Claimed' && now >= BigInt(o.diclaimPada) + BigInt(o.batasKerja));
      if (!lewat) continue;
      try {
        const hash = await wallet.writeContract({ ...contract, functionName: 'expire', args: [id], gas: GAS_LIMIT.expire, account: wallet.account!, chain: k.chain });
        const r = await k.receipt(hash);
        log('keeper', `expire #${id} (${status === 'Open' ? 'antre' : 'kerja'}) → ${r.status}`);
        if (r.status === 'success') { aktif.delete(id); stats.expired++; }
      } catch (e) {
        // Bisa kalah cepat dengan keeper lain / toko yang baru menyelesaikan; coba lagi putaran berikutnya.
        stats.gagal++;
        log('keeper', `expire #${id} gagal: ${pesanError(e)}`);
      }
    }
  }
  return { putaran, stats, aktif };
}
