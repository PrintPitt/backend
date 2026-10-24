// Shop radius (BLZ-22): shops register their location, customers give a rough location for their order (both signed
// by the wallet), and a shop's feed only lists Open orders within its radius. Coordinates are rounded to ±110 m, never go onchain,
// and are stored in DATA_DIR/lokasi.json so they survive restarts.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress, isAddress, isHex, recoverMessageAddress, type Hex } from 'viem';
import { bulatkanKoordinat, jarakKm, pesanLokasiOrder, pesanLokasiToko } from '@printpitt/shared';
import { ApiError, log, pesanError, type Koneksi } from '../common.ts';
import { statusDari, type IndeksOrder } from './indeksOrder.ts';

const RADIUS_KM = Number(process.env.RADIUS_KM ?? 1.5);
const RADIUS_PRO_KM = Number(process.env.RADIUS_PRO_KM ?? 3);   // Toko Pro (onchain subscription) sees orders farther away
const BERLAKU_MS = 5 * 60_000;
type Titik = { lat: number; lng: number };

function koordinat(body: Record<string, unknown>): Titik {
  const lat = Number(body.lat), lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new ApiError('BAD_COORDINATE', 400);
  return { lat: bulatkanKoordinat(lat), lng: bulatkanKoordinat(lng) };
}

/** Recover the message signer; `buatPesan` takes already-rounded coordinates (the client must round first). */
async function penanda(body: Record<string, unknown>, buatPesan: (waktu: number) => string) {
  const waktu = Number(body.waktu);
  if (!Number.isFinite(waktu) || Math.abs(Date.now() - waktu) > BERLAKU_MS) throw new ApiError('SIGNATURE_EXPIRED', 401);
  if (!isHex(body.sig)) throw new ApiError('BAD_SIG', 400);
  try { return await recoverMessageAddress({ message: buatPesan(waktu), signature: body.sig as Hex }); }
  catch { throw new ApiError('BAD_SIG', 401); }
}

export function buatLokasi(k: Koneksi, indeks: IndeksOrder, dataDir: string) {
  const file = join(dataDir, 'lokasi.json');
  const data: { toko: Record<string, Titik & { diperbarui: number }>; order: Record<string, Titik> } =
    existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { toko: {}, order: {} };
  const simpan = () => writeFileSync(file, JSON.stringify(data));
  // Pro status is read from the contract (`isPro`) and cached 60 s per shop so the feed does not hit RPC on every request.
  const cachePro = new Map<string, { pro: boolean; at: number }>();
  async function radiusUntuk(toko: string) {
    const c = cachePro.get(toko);
    if (c && Date.now() - c.at < 60_000) return c.pro ? RADIUS_PRO_KM : RADIUS_KM;
    let pro = c?.pro ?? false;
    try { pro = await k.pub.readContract({ ...k.contract, functionName: 'isPro', args: [toko as `0x${string}`] }); }
    catch (e) { log('lokasi', `reading isPro failed: ${pesanError(e)}`); }
    cachePro.set(toko, { pro, at: Date.now() });
    return pro ? RADIUS_PRO_KM : RADIUS_KM;
  }

  // An order's location is no longer needed once the order leaves Open.
  indeks.dengar((id, o) => {
    if (statusDari(o) !== 'Open' && data.order[id.toString()]) { delete data.order[id.toString()]; simpan(); }
  });

  /** POST /toko/lokasi { toko, lat, lng, waktu, sig }: only shops registered in the contract. */
  async function setToko(body: Record<string, unknown>) {
    if (typeof body.toko !== 'string' || !isAddress(body.toko, { strict: false })) throw new ApiError('BAD_ADDRESS', 400);
    const toko = getAddress(body.toko), t = koordinat(body);
    const siapa = await penanda(body, (w) => pesanLokasiToko(toko, t.lat, t.lng, w));
    if (siapa !== toko) throw new ApiError('BAD_SIG', 401);
    let terdaftar: boolean;
    try { [terdaftar] = await k.pub.readContract({ ...k.contract, functionName: 'toko', args: [toko] }); }
    catch (e) { log('lokasi', `reading shop failed: ${pesanError(e)}`); throw new ApiError('RPC_ERROR', 502); }
    if (!terdaftar) throw new ApiError('NOT_SHOP', 403);
    data.toko[toko] = { ...t, diperbarui: Date.now() };
    simpan();
    cachePro.delete(toko);
    return { toko, ...t, radiusKm: await radiusUntuk(toko) };
  }

  /** POST /order/:id/lokasi { lat, lng, waktu, sig }: only the order's customer, while the order is still Open. */
  async function setOrder(id: bigint, body: Record<string, unknown>) {
    const t = koordinat(body);
    const siapa = await penanda(body, (w) => pesanLokasiOrder(id, t.lat, t.lng, w));
    let o;
    try { o = await k.pub.readContract({ ...k.contract, functionName: 'getOrder', args: [id] }); }
    catch (e) { log('lokasi', `reading order failed: ${pesanError(e)}`); throw new ApiError('RPC_ERROR', 502); }
    if (statusDari(o) === 'None') throw new ApiError('NOT_FOUND', 404);
    if (siapa !== o.pelanggan) throw new ApiError('FORBIDDEN', 403);
    if (statusDari(o) !== 'Open') throw new ApiError('NOT_OPEN', 409);
    data.order[id.toString()] = t;
    simpan();
    return { orderId: id.toString(), ...t };
  }

  /**
   * GET /toko/:alamat/feed: Open orders still within the queue deadline and within radius of the shop, nearest first.
   * Radius is RADIUS_KM, or RADIUS_PRO_KM for Toko Pro. `semua=1` also includes orders without a location (mini-game demo mode).
   */
  async function feed(alamat: string, semua: boolean) {
    if (!isAddress(alamat, { strict: false })) throw new ApiError('BAD_ADDRESS', 400);
    const toko = data.toko[getAddress(alamat)];
    if (!toko && !semua) throw new ApiError('SHOP_LOCATION_UNKNOWN', 404);
    const radius = await radiusUntuk(getAddress(alamat));
    const now = indeks.waktuBlok(), hasil = [];
    for (const [id, o] of indeks.semua()) {
      if (statusDari(o) !== 'Open' || now >= BigInt(o.dibuatPada) + k.batasAntre) continue;
      const lok = data.order[id.toString()];
      const jarak = lok && toko ? jarakKm(toko, lok) : null;
      if (jarak === null ? !semua : jarak > radius) continue;
      hasil.push({
        id: id.toString(), jenis: o.jenis, halaman: o.halaman, harga: o.harga.toString(), batasKerja: o.batasKerja,
        teks: o.teks, adaDokumen: BigInt(o.dokumen) !== 0n, pakaiKode: BigInt(o.kodeHash) !== 0n,
        dibuatPada: o.dibuatPada, sisaAntre: Number(BigInt(o.dibuatPada) + k.batasAntre - now),
        jarakKm: jarak === null ? null : Math.round(jarak * 100) / 100,
      });
    }
    hasil.sort((a, b) => (a.jarakKm ?? 99) - (b.jarakKm ?? 99) || a.dibuatPada - b.dibuatPada);
    return { toko: toko ?? null, radiusKm: radius, pro: radius === RADIUS_PRO_KM, order: hasil };
  }

  return { setToko, setOrder, feed, jumlah: () => ({ toko: Object.keys(data.toko).length, order: Object.keys(data.order).length }) };
}

export type Lokasi = ReturnType<typeof buatLokasi>;
