// CLI order bot (tanpa service): buat order acak secara berkala sebagai cadangan saat penonton sepi.
//   BOT_PRIVATE_KEY=0x… RPC_URL=… node src/order-bot.ts
// Env opsional: INTERVAL_MS (default 8000), MAX_ORDERS (default 0 = tanpa batas).
import { dompet, jeda, koneksi, log, pesanError } from './common.ts';
import { buatBot } from './lib/bot.ts';

const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 8000);
const MAX_ORDERS = Number(process.env.MAX_ORDERS ?? 0);

const k = await koneksi();
const wallet = dompet(k, 'BOT_PRIVATE_KEY')!;
const bot = buatBot(k, wallet);
log('bot', `chain ${k.chainId}, contract ${k.contract.address}, akun ${wallet.account!.address}, tiap ${INTERVAL_MS} ms`);

while (MAX_ORDERS === 0 || bot.stats.orders < MAX_ORDERS) {
  try { if (!(await bot.sekali())) log('bot', 'sesi belum dibuka, menunggu…'); } catch (e) { log('bot', `gagal: ${pesanError(e)}`); }
  await jeda(INTERVAL_MS);
}
log('bot', `selesai, ${bot.stats.orders} order dibuat`);
