// Top-up Rupiah -> tIDRX. Bentuk request/response meniru POST /transaction/mint-request IDRX
// (Flow B: VA langsung, plus QRIS), supaya FE tidak berubah saat pindah ke IDRX asli.
//
// IDRX_MODE=simulasi (default): tidak ada uang sungguhan. Pembayaran dikonfirmasi lewat halaman checkout palsu
//   (GET /bayar/:id) atau POST /topup/:id/bayar, lalu minter mencetak tIDRX ke alamat tujuan.
// IDRX_MODE=live: diteruskan ke api.idrx.co. BELUM DIUJI: butuh API key bisnis (SPK-19), dan IDRX asli hanya
//   ada di Monad mainnet (143), bukan testnet tempat contract ini berjalan.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { encodeFunctionData, getAddress, isAddress, type Address, type Hash } from 'viem';
import { GAS_LIMIT, rupiahKeSatuan } from '@printpitt/shared';
import { ApiError, log, pesanError, type Koneksi } from '../common.ts';
import type { Antrean } from './antrean.ts';

export const MODE = process.env.IDRX_MODE === 'live' ? 'live' : 'simulasi';
const MIN_RP = 20_000;                                            // minimum IDRX
const MAX_RP = Number(process.env.TOPUP_MAX ?? 1_000_000);
const MAX_PER_ALAMAT = Number(process.env.TOPUP_MAX_PER_ADDRESS ?? 2_000_000);
const KEDALUWARSA_MENIT = Number(process.env.TOPUP_EXPIRY_MIN ?? 15);
/** Biaya SIMULASI. Angka asli dicek di dashboard IDRX (SPK-19). */
const BIAYA = { MANDIRI: 4_000, BRI: 3_000, QRIS_PERSEN: 0.7 };

export type StatusBayar = 'WAITING_FOR_PAYMENT' | 'PAID' | 'EXPIRED';
export type StatusMint = 'NOT_MINTED' | 'PROCESSING' | 'MINTED' | 'FAILED';

export type TopUp = {
  id: string; merchantOrderId: string; reference: string; mode: typeof MODE;
  destinationWalletAddress: Address; networkChainId: string;
  paymentMethod: 'va' | 'qris'; channelId: 'MANDIRI' | 'BRI' | 'QRIS';
  baseAmount: number; amount: number; fees: { name: string; amount: number }[];
  virtualAccountNo?: string; virtualAccountName?: string; qrString?: string;
  paymentUrl: string; expiredDate: string;
  paymentStatus: StatusBayar; userMintStatus: StatusMint; txHash?: Hash; dibuat: number;
};

function hitungBiaya(channel: TopUp['channelId'], rp: number) {
  const nilai = channel === 'QRIS' ? Math.ceil((rp * BIAYA.QRIS_PERSEN) / 100) : BIAYA[channel];
  return [{ name: channel === 'QRIS' ? 'Biaya QRIS (simulasi)' : `Biaya VA ${channel} (simulasi)`, amount: nilai }];
}

export function buatTopup(k: Koneksi, minter: Antrean | null) {
  const data = new Map<string, TopUp>();
  const totalPerAlamat = new Map<Address, number>();
  const stats = { dibuat: 0, dibayar: 0, minted: 0, gagal: 0 };
  setInterval(() => { const batas = Date.now() - 86_400_000; for (const [id, t] of data) if (t.dibuat < batas) data.delete(id); }, 600_000).unref();

  /** Cetak tIDRX langsung (dipakai setelah bayar, dan untuk mengisi saldo order bot). */
  async function cetak(ke: Address, rp: number) {
    if (!minter) throw new ApiError('MINTER_DISABLED', 503);
    const hash = await minter.kirim({
      to: k.token.address, gas: GAS_LIMIT.mint,
      data: encodeFunctionData({ abi: k.token.abi, functionName: 'mint', args: [ke, rupiahKeSatuan(rp)] }),
    });
    return { hash, receipt: k.pub.waitForTransactionReceipt({ hash }) };
  }

  function segarkan(t: TopUp) {
    if (t.paymentStatus === 'WAITING_FOR_PAYMENT' && Date.now() > Date.parse(t.expiredDate)) t.paymentStatus = 'EXPIRED';
    return t;
  }

  /** POST /topup: body sama dengan mint-request IDRX (toBeMinted, destinationWalletAddress, paymentMethod, channelId). */
  async function buat(body: Record<string, unknown>, baseUrl: string): Promise<TopUp> {
    // string atau angka, maks. 2 desimal (IDRX di chain selain Polygon/BNB)
    if (!/^\d{1,10}(\.\d{1,2})?$/.test(String(body.toBeMinted ?? ''))) throw new ApiError('BAD_AMOUNT', 400);
    const rp = Number(body.toBeMinted);
    if (rp < MIN_RP) throw new ApiError('AMOUNT_TOO_LOW', 400);
    if (rp > MAX_RP) throw new ApiError('AMOUNT_TOO_HIGH', 400);
    const raw = body.destinationWalletAddress;
    if (typeof raw !== 'string' || !isAddress(raw, { strict: false })) throw new ApiError('BAD_ADDRESS', 400);
    const ke = getAddress(raw);
    const metode = body.paymentMethod === 'qris' ? 'qris' : body.paymentMethod === 'va' || body.paymentMethod === undefined ? 'va' : null;
    if (!metode) throw new ApiError('BAD_PAYMENT_METHOD', 400);
    const channel = metode === 'qris' ? 'QRIS' : body.channelId === 'BRI' ? 'BRI' : body.channelId === 'MANDIRI' || body.channelId === undefined ? 'MANDIRI' : null;
    if (!channel) throw new ApiError('BAD_CHANNEL', 400);
    if ((totalPerAlamat.get(ke) ?? 0) + rp > MAX_PER_ALAMAT) throw new ApiError('ADDRESS_LIMIT', 429);
    if (MODE === 'live') return buatLive(ke, rp, metode, channel);

    const fees = hitungBiaya(channel, rp);
    const id = randomUUID();
    const t: TopUp = {
      id, merchantOrderId: `FK-${Date.now()}`, reference: `SIM${randomBytes(5).toString('hex').toUpperCase()}`, mode: MODE,
      destinationWalletAddress: ke, networkChainId: String(k.chainId), paymentMethod: metode, channelId: channel,
      baseAmount: rp, amount: rp + fees.reduce((s, f) => s + f.amount, 0), fees,
      ...(metode === 'va'
        ? { virtualAccountNo: `${channel === 'BRI' ? '26215' : '89608'}${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`, virtualAccountName: 'FOTOKOPI KILAT SIMULASI' }
        : { qrString: `SIMULASI-QRIS-${id}` }),
      paymentUrl: `${baseUrl}/bayar/${id}`,
      expiredDate: new Date(Date.now() + KEDALUWARSA_MENIT * 60_000).toISOString(),
      paymentStatus: 'WAITING_FOR_PAYMENT', userMintStatus: 'NOT_MINTED', dibuat: Date.now(),
    };
    data.set(id, t);
    stats.dibuat++;
    return t;
  }

  function ambil(id: string) {
    const t = data.get(id);
    if (!t) throw new ApiError('NOT_FOUND', 404);
    return segarkan(t);
  }

  /** Simulasi "pembayaran masuk": tandai PAID lalu cetak tIDRX. Idempoten: bayar dua kali tidak mencetak dua kali. */
  async function bayar(id: string) {
    if (MODE !== 'simulasi') throw new ApiError('NOT_SIMULATION', 403);
    const t = ambil(id);
    if (t.paymentStatus === 'EXPIRED') throw new ApiError('EXPIRED', 410);
    if (t.paymentStatus === 'PAID') return t;
    const total = (totalPerAlamat.get(t.destinationWalletAddress) ?? 0) + t.baseAmount;
    if (total > MAX_PER_ALAMAT) throw new ApiError('ADDRESS_LIMIT', 429);
    totalPerAlamat.set(t.destinationWalletAddress, total);
    t.paymentStatus = 'PAID'; t.userMintStatus = 'PROCESSING'; stats.dibayar++;
    try {
      const { hash, receipt } = await cetak(t.destinationWalletAddress, t.baseAmount);
      t.txHash = hash;
      void receipt.then(
        (r) => { t.userMintStatus = r.status === 'success' ? 'MINTED' : 'FAILED'; if (r.status === 'success') stats.minted++; else stats.gagal++; },
        (e) => { t.userMintStatus = 'FAILED'; stats.gagal++; log('topup', `receipt ${id}: ${pesanError(e)}`); },
      );
    } catch (e) {
      t.userMintStatus = 'FAILED'; stats.gagal++;
      totalPerAlamat.set(t.destinationWalletAddress, total - t.baseAmount);
      log('topup', `mint ${id} gagal: ${pesanError(e)}`);
    }
    log('topup', `${t.reference} Rp${t.baseAmount} -> ${t.destinationWalletAddress} ${t.userMintStatus}`);
    return t;
  }

  // ---------- IDRX asli (BELUM DIUJI, lihat SPK-19) ----------
  const KEY = process.env.IDRX_API_KEY ?? '', SECRET = process.env.IDRX_API_SECRET ?? '';
  const IDRX_URL = process.env.IDRX_API_URL ?? 'https://api.idrx.co';

  /** Header auth IDRX. Format tanda tangan dari ringkasan docs; WAJIB dicocokkan dengan docs/SDK resmi sebelum dipakai. */
  function headerIdrx(method: string, path: string, body: string) {
    const ts = String(Date.now());
    const isi = `${method}:${path}:${createHash('sha256').update(body).digest('hex')}:${ts}`;
    return {
      'content-type': 'application/json', 'user-agent': 'fotokopi-kilat/0.1',
      'idrx-api-key': KEY, 'idrx-api-ts': ts, 'idrx-api-sig': createHmac('sha256', SECRET).update(isi).digest('hex'),
    };
  }

  async function buatLive(ke: Address, rp: number, metode: 'va' | 'qris', channel: TopUp['channelId']): Promise<TopUp> {
    if (!KEY || !SECRET) throw new ApiError('IDRX_NOT_CONFIGURED', 503);
    const path = '/transaction/mint-request';
    const body = JSON.stringify({
      toBeMinted: String(rp), destinationWalletAddress: ke, networkChainId: String(k.chainId),
      ...(metode === 'va' ? { paymentMethod: 'va', channelId: channel, flow: 'direct' } : {}),
    });
    const r = await fetch(IDRX_URL + path, { method: 'POST', headers: headerIdrx('POST', path, body), body });
    const j = (await r.json().catch(() => ({}))) as { data?: Record<string, unknown>; message?: string };
    if (!r.ok || !j.data) { log('topup', `IDRX ${r.status}: ${j.message ?? '?'}`); throw new ApiError('IDRX_ERROR', 502); }
    const d = j.data;
    const t: TopUp = {
      id: String(d.id), merchantOrderId: String(d.merchantOrderId ?? ''), reference: String(d.reference ?? ''), mode: MODE,
      destinationWalletAddress: ke, networkChainId: String(k.chainId), paymentMethod: metode, channelId: channel,
      baseAmount: Number(d.baseAmount ?? rp), amount: Number(d.amount ?? rp), fees: (d.fees as TopUp['fees']) ?? [],
      virtualAccountNo: d.virtualAccountNo as string | undefined, virtualAccountName: d.virtualAccountName as string | undefined,
      paymentUrl: String(d.paymentUrl ?? d.checkoutUrl ?? ''), expiredDate: String(d.expiredDate ?? ''),
      paymentStatus: 'WAITING_FOR_PAYMENT', userMintStatus: 'NOT_MINTED', dibuat: Date.now(),
    };
    data.set(t.id, t);
    stats.dibuat++;
    return t;
  }

  return { buat, ambil, bayar, cetak, stats, mode: MODE, minter: minter?.alamat ?? null };
}
