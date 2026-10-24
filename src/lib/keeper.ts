// Keeper: calls `expire` on orders past the queue deadline (Open), work deadline (Claimed) or pickup deadline (Siap),
// and `tutupSengketa` on disputes the operator has not resolved by the dispute deadline.
// Time is compared against the latest block timestamp (not the local clock), to match the contract.
import type { WalletClient } from 'viem';
import { GAS_LIMIT, STATUS, STATUS_FINAL } from '@printpitt/shared';
import { bacaOrders, log, pesanError, type Koneksi } from '../common.ts';

export function buatKeeper(k: Koneksi, wallet: WalletClient) {
  const { pub, contract, batasAntre } = k;
  const aktif = new Set<bigint>();                 // ids not yet final (Open/Claimed); final ids are not scanned again
  let berikutnya = 1n;
  const stats = { putaran: 0, expired: 0, gagal: 0 };

  let batasJemput: bigint | null = null, batasSengketa: bigint | null = null;

  async function putaran() {
    stats.putaran++;
    batasJemput ??= BigInt(await pub.readContract({ ...contract, functionName: 'batasJemput' }));
    batasSengketa ??= BigInt(await pub.readContract({ ...contract, functionName: 'batasSengketa' }));
    const nextId = await pub.readContract({ ...contract, functionName: 'nextId' });
    for (; berikutnya < nextId; berikutnya++) aktif.add(berikutnya);
    if (aktif.size === 0) return;
    const { timestamp: now } = await pub.getBlock();
    const ids = [...aktif];
    const orders = await bacaOrders(k, ids);
    for (const [i, id] of ids.entries()) {
      const o = orders[i];
      const status = STATUS[o.status];
      if ((STATUS_FINAL as readonly string[]).includes(status)) { aktif.delete(id); continue; }
      // A dispute (Sengketa) waits for the operator; the keeper only closes it (50/50) after the dispute deadline passes.
      const sengketaBasi = status === 'Sengketa' && now >= BigInt(o.siapPada) + batasJemput + batasSengketa!;
      const lewat = sengketaBasi ||
        (status === 'Open' && now >= BigInt(o.dibuatPada) + batasAntre) ||
        (status === 'Claimed' && now >= BigInt(o.diclaimPada) + BigInt(o.batasKerja)) ||
        (status === 'Siap' && now >= BigInt(o.siapPada) + batasJemput);
      if (!lewat) continue;
      try {
        // Siap = full settlement (payout + refund + NFT), much more expensive than a plain refund.
        const gas = sengketaBasi ? GAS_LIMIT.tutupSengketa : status === 'Siap' ? GAS_LIMIT.expireSiap : GAS_LIMIT.expire;
        const hash = await wallet.writeContract({
          ...contract, functionName: sengketaBasi ? 'tutupSengketa' : 'expire', args: [id], gas, account: wallet.account!, chain: k.chain,
        });
        const r = await k.receipt(hash);
        log('keeper', `${sengketaBasi ? 'tutupSengketa' : 'expire'} #${id} (${status === 'Open' ? 'queue' : status === 'Claimed' ? 'work' : status === 'Siap' ? 'not picked up' : 'stale dispute'}) → ${r.status}`);
        if (r.status === 'success') { aktif.delete(id); stats.expired++; }
      } catch (e) {
        // May lose the race to another keeper / a shop that just finished; retry next round.
        stats.gagal++;
        log('keeper', `expire #${id} failed: ${pesanError(e)}`);
      }
    }
  }
  return { putaran, stats, aktif };
}
