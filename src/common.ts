// Klien viem bersama untuk script ops dan service backend. Konfigurasi lewat env; private key tidak pernah ditulis ke file.
import {
  createPublicClient, createWalletClient, defineChain, formatTransactionReceipt, http, toHex,
  type Hash, type Hex, type PublicClient, type RpcTransactionReceipt, type TransactionReceipt, type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil, monadTestnet } from 'viem/chains';
import { deploymentUntuk, fotokopiKilatAbi, tidrxAbi } from '@printpitt/shared';

// RPC_URL boleh berisi beberapa URL dipisah koma: beban dibagi bergiliran, URL yang kena limit dilewati.
const URLS = (process.env.RPC_URL ?? 'http://127.0.0.1:8545').split(',').map((s) => s.trim()).filter(Boolean);
export const RPC_URL = URLS[0];
const POLL_MS = Number(process.env.POLL_MS ?? 300);
// RPC publik Monad membatasi 15 request/dtk per IP. Request dibagi bergiliran ke semua URL di RPC_URL, tiap URL
// non-lokal maks. RPC_RPS request/dtk (lebih dari itu mengantre). URL yang menjawab "limit" diistirahatkan 1 dtk
// dan request dicoba ke URL lain.
const RPS = Number(process.env.RPC_RPS ?? 12);
const lokal = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);
const slot = URLS.map((url) => ({ url, jejak: [] as number[], istirahat: 0 }));
let giliran = 0;

async function ambilSlot() {
  for (;;) {
    const now = Date.now();
    for (let k = 0; k < slot.length; k++) {
      const s = slot[(giliran + k) % slot.length];
      if (s.istirahat > now) continue;
      s.jejak = s.jejak.filter((t) => now - t < 1000);
      if (lokal(s.url) || s.jejak.length < RPS) { s.jejak.push(now); giliran = (giliran + k + 1) % slot.length; return s; }
    }
    await jeda(25);
  }
}
const metodeRpc = (init?: RequestInit) => { try { return JSON.parse(String(init?.body)).method ?? 'batch'; } catch { return '?'; } };
const fetchBagi: typeof fetch = async (_input, init) => {
  let terakhir: Response | undefined;
  for (let coba = 0; coba < slot.length * 2; coba++) {
    const s = await ambilSlot();
    const mulai = Date.now();
    try {
      const r = await fetch(s.url, init);
      const teks = await r.text();
      const lama = Date.now() - mulai;
      if (lama > 5000) log('rpc', `lambat ${lama} ms ${new URL(s.url).host} ${metodeRpc(init)} → ${r.status}`);
      if (r.status === 429 || /requests? limited|rate limit|too many requests/i.test(teks)) { s.istirahat = Date.now() + 1000; terakhir = new Response(teks, r); continue; }
      // URL yang menolak (HTTP >= 400, atau method "tidak tersedia" seperti eth_call dari IP datacenter) diistirahatkan 30 dtk.
      if (r.status >= 400 || /does not exist|is not available|unauthorized|forbidden/i.test(teks)) {
        if (s.istirahat < Date.now()) log('rpc', `${new URL(s.url).host} diistirahatkan 30 dtk: ${r.status} ${teks.slice(0, 120)}`);
        s.istirahat = Date.now() + 30_000; terakhir = new Response(teks, r); continue;
      }
      return new Response(teks, { status: r.status, statusText: r.statusText, headers: r.headers });
    } catch (e) {
      log('rpc', `gagal ${Date.now() - mulai} ms ${new URL(s.url).host} ${metodeRpc(init)}: ${pesanError(e)}`);
      s.istirahat = Date.now() + 1000; if (coba === slot.length * 2 - 1 || init?.signal?.aborted) throw e;
    }
  }
  return terakhir!;
};
/** Satu transport untuk semua client (public + wallet), supaya pembagian beban dan limiter berlaku bersama. */
const TRANSPORT: Transport = http(URLS[0], { fetchFn: fetchBagi, retryCount: 2, retryDelay: 300 });

/** Chain, public client, contract, dan token tIDRX. CONTRACT_ADDRESS / TOKEN_ADDRESS / BATAS_ANTRE di env menimpa file deployment. */
export async function koneksi() {
  const probe = createPublicClient({ transport: TRANSPORT });
  const chainId = await probe.getChainId();
  const chain =
    chainId === monadTestnet.id ? monadTestnet : chainId === anvil.id ? anvil : defineChain({ ...anvil, id: chainId });
  // Blok Monad ~0,3 dtk (SPK-03): polling receipt default viem (4 dtk) terlalu lambat.
  const pub = createPublicClient({ chain, transport: TRANSPORT, pollingInterval: POLL_MS });
  const override = process.env.CONTRACT_ADDRESS as Hex | undefined;
  const d = override
    ? { address: override, tidrx: process.env.TOKEN_ADDRESS, batasAntre: Number(process.env.BATAS_ANTRE ?? 45) }
    : deploymentUntuk(chainId);
  const contract = { address: d.address as Hex, abi: fotokopiKilatAbi } as const;
  const token = { address: (process.env.TOKEN_ADDRESS ?? d.tidrx) as Hex, abi: tidrxAbi } as const;
  if (!token.address) throw new Error('Alamat tIDRX tidak ada: set TOKEN_ADDRESS atau export ulang deployment');
  return { chain, chainId, pub, contract, token, batasAntre: BigInt(d.batasAntre), receipt: buatPengamatReceipt(pub as PublicClient) };
}

export type Koneksi = Awaited<ReturnType<typeof koneksi>>;

/** Wallet client untuk satu private key dari env (null bila env kosong dan tidak wajib). */
export function dompet(k: Koneksi, namaKunci: string, wajib = true) {
  const key = process.env[namaKunci] as Hex | undefined;
  if (!key){ if (wajib) throw new Error(`Set env ${namaKunci} (private key). Jangan simpan di file.`); return null; }
  const account = privateKeyToAccount(key);
  return createWalletClient({ chain: k.chain, account, transport: TRANSPORT, pollingInterval: POLL_MS });
}

/** Untuk script CLI: koneksi + satu wallet. */
export async function siapkan(namaKunci: string) {
  const k = await koneksi();
  const wallet = dompet(k, namaKunci)!;
  return { ...k, wallet, account: wallet.account };
}

export const jeda = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Baca banyak order sekaligus: satu multicall per 150 id (RPC publik dibatasi per detik); anvil tanpa Multicall3 → satu per satu. */
export async function bacaOrders(k: Koneksi, ids: bigint[]) {
  const { pub, contract } = k;
  if (!pub.chain?.contracts?.multicall3) return Promise.all(ids.map((id) => pub.readContract({ ...contract, functionName: 'getOrder', args: [id] })));
  const hasil = [];
  for (let i = 0; i < ids.length; i += 150) {
    const potong = ids.slice(i, i + 150);
    hasil.push(...await pub.multicall({ contracts: potong.map((id) => ({ ...contract, functionName: 'getOrder', args: [id] }) as const), allowFailure: false }));
  }
  return hasil;
}
export type OrderChain = Awaited<ReturnType<typeof bacaOrders>>[number];

/**
 * Pengamat receipt per blok: satu loop membaca `eth_getBlockReceipts` untuk tiap blok baru dan menyelesaikan semua tx
 * yang sedang ditunggu. 30 tx bersamaan cukup ~3 request/dtk, bukan polling receipt per tx (RPC publik 15 req/dtk).
 * Tx yang belum terlihat setelah 15 dtk dicek sekali lewat `eth_getTransactionReceipt` (jaring pengaman), gagal setelah 120 dtk.
 */
function buatPengamatReceipt(pub: PublicClient) {
  type Penunggu = { resolve: (r: TransactionReceipt) => void; reject: (e: Error) => void; sejak: number; dicek: number };
  const tunggu = new Map<Hash, Penunggu[]>();
  let berikut: bigint | null = null, jalan = false;

  const selesai = (hash: Hash, r: TransactionReceipt) => { for (const w of tunggu.get(hash) ?? []) w.resolve(r); tunggu.delete(hash); };

  async function loop() {
    if (jalan) return; jalan = true;
    try {
      while (tunggu.size) {
        try {
          const kini = await pub.getBlockNumber({ cacheTime: 0 });
          if (berikut === null || kini - berikut > 30n) berikut = kini > 3n ? kini - 3n : 0n;   // mulai sedikit ke belakang
          while (berikut <= kini && tunggu.size) {
            const rs = await pub.request({ method: 'eth_getBlockReceipts', params: [toHex(berikut)] }) as RpcTransactionReceipt[] | null;
            if (!rs) break;                                                                   // RPC ini belum sampai blok tsb
            for (const r of rs) if (tunggu.has(r.transactionHash)) selesai(r.transactionHash, formatTransactionReceipt(r));
            berikut++;
          }
          const now = Date.now();
          for (const [hash, ws] of [...tunggu]) {
            const w = ws[0];
            if (now - w.sejak > 120_000) { for (const x of ws) x.reject(new Error(`receipt ${hash} tidak muncul 120 dtk`)); tunggu.delete(hash); continue; }
            if (now - w.sejak > 15_000 && now - w.dicek > 10_000) {
              w.dicek = now;
              const r = await pub.getTransactionReceipt({ hash }).catch(() => null);
              if (r) selesai(hash, r);
            }
          }
        } catch (e) { log('receipt', `putaran gagal: ${pesanError(e)}`); }
        if (tunggu.size) await jeda(400);
      }
    } finally { jalan = false; berikut = null; }
  }

  return (hash: Hash) => new Promise<TransactionReceipt>((resolve, reject) => {
    const ws = tunggu.get(hash) ?? [];
    ws.push({ resolve, reject, sejak: Date.now(), dicek: 0 });
    tunggu.set(hash, ws);
    void loop();
  });
}

export function log(tag: string, ...args: unknown[]) {
  console.log(new Date().toISOString().slice(11, 19), `[${tag}]`, ...args);
}

export const pesanError = (e: unknown) => (e as Error).message.split('\n')[0];

/** Error yang dijawab ke klien HTTP sebagai `{ error: code }` dengan status ini. */
export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}
