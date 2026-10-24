// Service backend (Railway): faucet + top-up Rupiah (simulasi IDRX) + relayer + keeper + order bot + status,
// satu proses Node tanpa database. Spesifikasi: vault/04-Architecture/Desain Backend.md. Jalankan: node src/server.ts
//
// Env: RPC_URL, FAUCET_PRIVATE_KEY, KEEPER_PRIVATE_KEY, BOT_PRIVATE_KEY, MINTER_PRIVATE_KEY, RELAYER_PRIVATE_KEY,
//      ALLOWED_ORIGIN (koma; '*' untuk dev), ADMIN_TOKEN, FAUCET_AMOUNT (0.05), FAUCET_MIN_BALANCE (0.5),
//      RATE_LIMIT_PER_MIN (120), KEEPER (on), BOT (off), KEEPER_INTERVAL_MS (2000), BOT_INTERVAL_MS (8000), PORT (8787),
//      CONTRACT_ADDRESS, TOKEN_ADDRESS, BATAS_ANTRE, PUBLIC_URL, IDRX_MODE (simulasi|live), TOPUP_MAX, TOPUP_MAX_PER_ADDRESS
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { formatEther, parseEther, type Address, type WalletClient } from 'viem';
import { formatRupiah } from '@printpitt/shared';
import { ApiError, dompet, jeda, koneksi, log, pesanError } from './common.ts';
import { buatAntrean } from './lib/antrean.ts';
import { buatBot } from './lib/bot.ts';
import { halamanBayar } from './lib/checkout.ts';
import { buatFaucet } from './lib/faucet.ts';
import { buatKeeper } from './lib/keeper.ts';
import { buatRelayer } from './lib/relayer.ts';
import { buatTopup } from './lib/topup.ts';

const PORT = Number(process.env.PORT ?? 8787);
const ALLOWED = (process.env.ALLOWED_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const RATE = Number(process.env.RATE_LIMIT_PER_MIN ?? 120);   // longgar: penonton di WiFi venue berbagi satu IP (SPK-05)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
const KEEPER_MS = Number(process.env.KEEPER_INTERVAL_MS ?? 2000);
const PUBLIC_URL = process.env.PUBLIC_URL?.replace(/\/$/, '');
const bot = { on: process.env.BOT === 'on', intervalMs: Number(process.env.BOT_INTERVAL_MS ?? 8000) };

const k = await koneksi();
const fWallet = dompet(k, 'FAUCET_PRIVATE_KEY', false);
const kWallet = process.env.KEEPER === 'off' ? null : dompet(k, 'KEEPER_PRIVATE_KEY', false);
const bWallet = dompet(k, 'BOT_PRIVATE_KEY', false);
const mWallet = dompet(k, 'MINTER_PRIVATE_KEY', false);
const rWallet = dompet(k, 'RELAYER_PRIVATE_KEY', false);
const faucet = fWallet && buatFaucet(k, fWallet, {
  amount: parseEther(process.env.FAUCET_AMOUNT ?? '0.05'),
  minBalance: parseEther(process.env.FAUCET_MIN_BALANCE ?? '0.5'),
});
const keeper = kWallet && buatKeeper(k, kWallet);
const topup = buatTopup(k, mWallet && buatAntrean(k, mWallet, 'minter'));
const relayer = rWallet && buatRelayer(k, rWallet);
// Saldo bot diisi minter simulasi (Rp1.000.000) bila habis.
const isiSaldoBot = mWallet && topup.mode === 'simulasi'
  ? async (ke: Address) => { const { receipt } = await topup.cetak(ke, 1_000_000); await receipt; log('bot', 'saldo tIDRX diisi minter'); }
  : undefined;
const orderBot = bWallet && buatBot(k, bWallet, isiSaldoBot);
if (!ALLOWED.length) log('server', 'PERINGATAN: ALLOWED_ORIGIN kosong, browser tidak bisa memanggil service');
if (!faucet) log('server', 'PERINGATAN: FAUCET_PRIVATE_KEY kosong, /faucet nonaktif');
if (!mWallet) log('server', 'PERINGATAN: MINTER_PRIVATE_KEY kosong, top-up tidak bisa mencetak tIDRX');
if (!relayer) log('server', 'PERINGATAN: RELAYER_PRIVATE_KEY kosong, /relay/order nonaktif');
if (!keeper) log('server', 'keeper nonaktif');

// ---------- loop latar ----------
let hidup = true;
async function loopKeeper() {
  while (hidup && keeper) { try { await keeper.putaran(); } catch (e) { log('keeper', `putaran gagal: ${pesanError(e)}`); } await jeda(KEEPER_MS); }
}
async function loopBot() {
  while (hidup && orderBot) {
    if (!bot.on) { await jeda(500); continue; }
    try { await orderBot.sekali(); } catch (e) { orderBot.stats.gagal++; log('bot', `gagal: ${pesanError(e)}`); }
    await jeda(bot.intervalMs);
  }
}

// ---------- util HTTP ----------
const hitungan = new Map<string, { n: number; reset: number }>();
setInterval(() => { const now = Date.now(); for (const [ip, v] of hitungan) if (v.reset < now) hitungan.delete(ip); }, 60_000).unref();
function kenaLimit(ip: string) {
  const now = Date.now(), v = hitungan.get(ip);
  if (!v || v.reset < now) { hitungan.set(ip, { n: 1, reset: now + 60_000 }); return 0; }
  v.n++; return v.n > RATE ? Math.ceil((v.reset - now) / 1000) : 0;
}
const ipDari = (req: IncomingMessage) =>
  String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '?';
const urlDasar = (req: IncomingMessage) =>
  PUBLIC_URL ?? `${String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0]}://${req.headers.host}`;

function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (ALLOWED.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && ALLOWED.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');
}
function kirim(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
async function bacaJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 4096) throw new ApiError('BODY_TOO_LARGE', 413); }
  try { const v = raw ? JSON.parse(raw) : {}; return v && typeof v === 'object' ? v : {}; } catch { throw new ApiError('BAD_JSON', 400); }
}

// ---------- status (saldo di-cache 3 dtk) ----------
type Saldo = { mon: string; tidrx: string } | null;
let saldoCache = { at: 0, v: {} as Record<string, Saldo> };
async function saldoSemua() {
  if (Date.now() - saldoCache.at < 3000) return saldoCache.v;
  const ambil = async (w: WalletClient | null): Promise<Saldo> => {
    if (!w) return null;
    const a = w.account!.address;
    const [mon, t] = await Promise.all([k.pub.getBalance({ address: a }), k.pub.readContract({ ...k.token, functionName: 'balanceOf', args: [a] })]);
    return { mon: formatEther(mon), tidrx: formatRupiah(t) };
  };
  const [f, kp, b, m, r] = await Promise.all([fWallet, kWallet, bWallet, mWallet, rWallet].map(ambil));
  saldoCache = { at: Date.now(), v: { faucet: f, keeper: kp, bot: b, minter: m, relayer: r } };
  return saldoCache.v;
}
async function status() {
  const s = await saldoSemua();
  return {
    chainId: k.chainId, contract: k.contract.address, token: k.token.address,
    faucet: faucet ? { address: faucet.alamat, balance: s.faucet!.mon, funded: faucet.stats.funded, ditolak: faucet.stats.ditolak, gagal: faucet.stats.gagal, queue: faucet.panjangAntre() } : null,
    topup: { mode: topup.mode, minter: topup.minter, balance: s.minter?.mon ?? null, ...topup.stats },
    relayer: relayer ? { address: relayer.alamat, balance: s.relayer!.mon, fee: s.relayer!.tidrx, queue: relayer.panjangAntre(), ...relayer.stats } : null,
    keeper: keeper ? { on: true, address: kWallet!.account!.address, balance: s.keeper!.mon, expired: keeper.stats.expired, aktif: keeper.aktif.size } : { on: false },
    bot: orderBot ? { on: bot.on, intervalMs: bot.intervalMs, address: bWallet!.account!.address, balance: s.bot!.mon, tidrx: s.bot!.tidrx, orders: orderBot.stats.orders, gagal: orderBot.stats.gagal } : { on: false },
  };
}

/** Info publik untuk FE: alamat contract/token/relayer dan fee, supaya FE tidak perlu hardcode. */
async function config() {
  const fee = await k.pub.readContract({ ...k.contract, functionName: 'feeRelay' });
  return { chainId: k.chainId, contract: k.contract.address, token: k.token.address, relayer: relayer?.alamat ?? null, feeRelay: fee.toString(), topupMode: topup.mode };
}

// ---------- rute ----------
const TOPUP_ID = /^\/topup\/([0-9a-f-]{36})$/, BAYAR_ID = /^\/topup\/([0-9a-f-]{36})\/bayar$/, HALAMAN = /^\/bayar\/([0-9a-f-]{36})$/;

const server = createServer(async (req, res) => {
  const t0 = Date.now(), url = new URL(req.url ?? '/', 'http://x'), p = url.pathname;
  cors(req, res);
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && p === '/health') return kirim(res, 200, { ok: true });
    if (req.method === 'GET' && p === '/status') return kirim(res, 200, await status());
    if (req.method === 'GET' && p === '/config') return kirim(res, 200, await config());
    if (req.method === 'GET' && TOPUP_ID.test(p)) return kirim(res, 200, topup.ambil(TOPUP_ID.exec(p)![1]));
    if (req.method === 'GET' && HALAMAN.test(p)) {
      if (topup.mode !== 'simulasi') return kirim(res, 404, { error: 'NOT_FOUND' });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(halamanBayar(topup.ambil(HALAMAN.exec(p)![1])));
    }
    if (req.method === 'POST') {
      const tunggu = kenaLimit(ipDari(req));
      if (tunggu) return kirim(res, 429, { error: 'RATE_LIMITED', retryAfter: tunggu });
      if (p === '/faucet') {
        if (!faucet) return kirim(res, 503, { error: 'FAUCET_DISABLED' });
        return kirim(res, 202, await faucet.minta((await bacaJson(req)).address));
      }
      if (p === '/topup') return kirim(res, 201, await topup.buat(await bacaJson(req), urlDasar(req)));
      if (BAYAR_ID.test(p)) return kirim(res, 200, await topup.bayar(BAYAR_ID.exec(p)![1]));
      if (p === '/relay/order') {
        if (!relayer) return kirim(res, 503, { error: 'RELAYER_DISABLED' });
        return kirim(res, 202, await relayer.kirim(await bacaJson(req)));
      }
      if (p === '/admin/bot') {
        if (!ADMIN_TOKEN || req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return kirim(res, 401, { error: 'UNAUTHORIZED' });
        if (!orderBot) return kirim(res, 503, { error: 'BOT_DISABLED' });
        const body = await bacaJson(req);
        if (typeof body.on === 'boolean') bot.on = body.on;
        if (typeof body.intervalMs === 'number' && body.intervalMs >= 1000) bot.intervalMs = body.intervalMs;
        log('bot', `admin: on=${bot.on}, interval=${bot.intervalMs} ms`);
        return kirim(res, 200, { bot });
      }
    }
    return kirim(res, 404, { error: 'NOT_FOUND' });
  } catch (e) {
    if (e instanceof ApiError) return kirim(res, e.status, { error: e.code });
    log('server', `error ${p}: ${pesanError(e)}`);
    return kirim(res, 500, { error: 'INTERNAL' });
  } finally {
    if (p !== '/health') log('http', `${req.method} ${p} ${res.statusCode} ${Date.now() - t0} ms`);
  }
});

server.listen(PORT, () => {
  log('server', `port ${PORT} · chain ${k.chainId} · contract ${k.contract.address} · tIDRX ${k.token.address} · top-up ${topup.mode}${mWallet ? '' : ' (tanpa minter)'} · relayer ${relayer ? 'on' : 'off'} · faucet ${faucet ? 'on' : 'off'} · keeper ${keeper ? 'on' : 'off'} · bot ${orderBot ? (bot.on ? 'on' : 'siaga') : 'off'}`);
  void loopKeeper(); void loopBot();
});

function berhenti(sinyal: string) {
  log('server', `${sinyal}: berhenti…`);
  hidup = false;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => berhenti('SIGTERM'));
process.on('SIGINT', () => berhenti('SIGINT'));
