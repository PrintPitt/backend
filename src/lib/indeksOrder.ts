// Shared order index: one loop scans orders from the chain (new ids + those not yet final) and keeps the latest copy
// in memory. Used by the shop feed (radius) and the document cleaner, so HTTP requests never trigger RPC requests.
import { STATUS, STATUS_FINAL } from '@printpitt/shared';
import { bacaOrders, jeda, log, pesanError, type Koneksi, type OrderChain } from '../common.ts';

export const statusDari = (o: OrderChain) => STATUS[o.status];
export const sudahFinal = (o: OrderChain) => (STATUS_FINAL as readonly string[]).includes(statusDari(o));

export function buatIndeksOrder(k: Koneksi, intervalMs = Number(process.env.INDEKS_INTERVAL_MS ?? 2000)) {
  const orders = new Map<bigint, OrderChain>();
  const belumFinal = new Set<bigint>();
  const pendengar: ((id: bigint, o: OrderChain) => void)[] = [];
  let berikut = 1n, waktuBlok = 0n, hidup = true;
  const stats = { putaran: 0, gagal: 0 };

  async function putaran() {
    stats.putaran++;
    const [next, blok] = await Promise.all([k.pub.readContract({ ...k.contract, functionName: 'nextId' }), k.pub.getBlock()]);
    waktuBlok = blok.timestamp;
    for (; berikut < next; berikut++) belumFinal.add(berikut);
    const ids = [...belumFinal];
    if (!ids.length) return;
    const os = await bacaOrders(k, ids);
    for (const [i, id] of ids.entries()) {
      const o = os[i];
      orders.set(id, o);
      if (sudahFinal(o)) belumFinal.delete(id);
      for (const f of pendengar) {
        try { f(id, o); } catch (e) { log('indeks', `listener failed #${id}: ${pesanError(e)}`); }
      }
    }
  }

  async function loop() {
    while (hidup) {
      try { await putaran(); } catch (e) { stats.gagal++; log('indeks', `round failed: ${pesanError(e)}`); }
      await jeda(intervalMs);
    }
  }

  return {
    mulai: () => void loop(),
    berhenti: () => { hidup = false; },
    /** Called for every order read (including once when it becomes final). */
    dengar: (f: (id: bigint, o: OrderChain) => void) => { pendengar.push(f); },
    ambil: (id: bigint) => orders.get(id),
    semua: () => orders.entries(),
    /** Timestamp of the latest block seen (seconds), used for the queue deadline in the feed. */
    waktuBlok: () => waktuBlok,
    stats: () => ({ ...stats, order: orders.size, belumFinal: belumFinal.size }),
  };
}

export type IndeksOrder = ReturnType<typeof buatIndeksOrder>;
