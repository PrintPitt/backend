// Standalone order bot CLI (no service): places random orders periodically as a backup when the audience is quiet.
//   BOT_PRIVATE_KEY=0x… RPC_URL=… node src/order-bot.ts
// Optional env: INTERVAL_MS (default 8000), MAX_ORDERS (default 0 = unlimited).
import { dompet, jeda, koneksi, log, pesanError } from './common.ts';
import { buatBot } from './lib/bot.ts';

const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 8000);
const MAX_ORDERS = Number(process.env.MAX_ORDERS ?? 0);

const k = await koneksi();
const wallet = dompet(k, 'BOT_PRIVATE_KEY')!;
const bot = buatBot(k, wallet);
log('bot', `chain ${k.chainId}, contract ${k.contract.address}, account ${wallet.account!.address}, every ${INTERVAL_MS} ms`);

while (MAX_ORDERS === 0 || bot.stats.orders < MAX_ORDERS) {
  try { if (!(await bot.sekali())) log('bot', 'session not open yet, waiting…'); } catch (e) { log('bot', `failed: ${pesanError(e)}`); }
  await jeda(INTERVAL_MS);
}
log('bot', `done, ${bot.stats.orders} orders created`);
