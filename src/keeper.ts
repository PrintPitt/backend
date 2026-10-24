// Standalone keeper CLI (no service): calls `expire` on orders past their deadline.
//   KEEPER_PRIVATE_KEY=0x… RPC_URL=… node src/keeper.ts
// Optional env: INTERVAL_MS (default 2000), ONCE=1 (one round, then exit).
import { dompet, jeda, koneksi, log, pesanError } from './common.ts';
import { buatKeeper } from './lib/keeper.ts';

const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 2000);
const ONCE = process.env.ONCE === '1';

const k = await koneksi();
const keeper = buatKeeper(k, dompet(k, 'KEEPER_PRIVATE_KEY')!);
log('keeper', `chain ${k.chainId}, contract ${k.contract.address}, every ${INTERVAL_MS} ms`);

do {
  try { await keeper.putaran(); } catch (e) { log('keeper', `round failed: ${pesanError(e)}`); }
  if (!ONCE) await jeda(INTERVAL_MS);
} while (!ONCE);
