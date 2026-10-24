// CLI keeper (tanpa service): panggil `expire` untuk order yang lewat batas.
//   KEEPER_PRIVATE_KEY=0x… RPC_URL=… node src/keeper.ts
// Env opsional: INTERVAL_MS (default 2000), ONCE=1 (satu putaran lalu keluar).
import { dompet, jeda, koneksi, log, pesanError } from './common.ts';
import { buatKeeper } from './lib/keeper.ts';

const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 2000);
const ONCE = process.env.ONCE === '1';

const k = await koneksi();
const keeper = buatKeeper(k, dompet(k, 'KEEPER_PRIVATE_KEY')!);
log('keeper', `chain ${k.chainId}, contract ${k.contract.address}, tiap ${INTERVAL_MS} ms`);

do {
  try { await keeper.putaran(); } catch (e) { log('keeper', `putaran gagal: ${pesanError(e)}`); }
  if (!ONCE) await jeda(INTERVAL_MS);
} while (!ONCE);
