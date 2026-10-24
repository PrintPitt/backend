// Radius toko (BLZ-22): toko mendaftarkan lokasi, pelanggan memberi lokasi kasar order-nya (keduanya ditandatangani
// wallet), lalu feed toko hanya berisi order Open dalam radius. Koordinat dibulatkan ±110 m, tidak pernah on-chain,
// disimpan di DATA_DIR/lokasi.json supaya bertahan saat restart.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress, isAddress, isHex, recoverMessageAddress, type Hex } from 'viem';
import { bulatkanKoordinat, jarakKm, pesanLokasiOrder, pesanLokasiToko } from '@printpitt/shared';
import { ApiError, log, pesanError, type Koneksi } from '../common.ts';
import { statusDari, type IndeksOrder } from './indeksOrder.ts';

const RADIUS_KM = Number(process.env.RADIUS_KM ?? 1.5);
const BERLAKU_MS = 5 * 60_000;
type Titik = { lat: number; lng: number };

function koordinat(body: Record<string, unknown>): Titik {
  const lat = Number(body.lat), lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new ApiError('BAD_COORDINATE', 400);
  return { lat: bulatkanKoordinat(lat), lng: bulatkanKoordinat(lng) };
}

/** Pulihkan penanda tangan pesan; `buatPesan` menerima koordinat yang sudah dibulatkan (klien wajib membulatkan dulu). */
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

  // Lokasi order tidak diperlukan lagi setelah order keluar dari Open.
  indeks.dengar((id, o) => {
    if (statusDari(o) !== 'Open' && data.order[id.toString()]) { delete data.order[id.toString()]; simpan(); }
  });

  /** POST /toko/lokasi { toko, lat, lng, waktu, sig }: hanya toko yang terdaftar di contract. */
  async function setToko(body: Record<string, unknown>) {
    if (typeof body.toko !== 'string' || !isAddress(body.toko, { strict: false })) throw new ApiError('BAD_ADDRESS', 400);
    const toko = getAddress(body.toko), t = koordinat(body);
    const siapa = await penanda(body, (w) => pesanLokasiToko(toko, t.lat, t.lng, w));
    if (siapa !== toko) throw new ApiError('BAD_SIG', 401);
    let terdaftar: boolean;
    try { [terdaftar] = await k.pub.readContract({ ...k.contract, functionName: 'toko', args: [toko] }); }
    catch (e) { log('lokasi', `baca toko gagal: ${pesanError(e)}`); throw new ApiError('RPC_ERROR', 502); }
    if (!terdaftar) throw new ApiError('NOT_SHOP', 403);
    data.toko[toko] = { ...t, diperbarui: Date.now() };
    simpan();
    return { toko, ...t, radiusKm: RADIUS_KM };
  }

  /** POST /order/:id/lokasi { lat, lng, waktu, sig }: hanya pelanggan order, selama order masih Open. */
  async function setOrder(id: bigint, body: Record<string, unknown>) {
    const t = koordinat(body);
    const siapa = await penanda(body, (w) => pesanLokasiOrder(id, t.lat, t.lng, w));
    let o;
    try { o = await k.pub.readContract({ ...k.contract, functionName: 'getOrder', args: [id] }); }
    catch (e) { log('lokasi', `baca order gagal: ${pesanError(e)}`); throw new ApiError('RPC_ERROR', 502); }
    if (statusDari(o) === 'None') throw new ApiError('NOT_FOUND', 404);
    if (siapa !== o.pelanggan) throw new ApiError('FORBIDDEN', 403);
    if (statusDari(o) !== 'Open') throw new ApiError('NOT_OPEN', 409);
    data.order[id.toString()] = t;
    simpan();
    return { orderId: id.toString(), ...t };
  }

  /**
   * GET /toko/:alamat/feed: order Open yang belum lewat batas antre, dalam radius dari lokasi toko, terdekat dulu.
   * `semua=1` ikut menampilkan order tanpa lokasi (mode demo mini-game).
   */
  function feed(alamat: string, semua: boolean) {
    if (!isAddress(alamat, { strict: false })) throw new ApiError('BAD_ADDRESS', 400);
    const toko = data.toko[getAddress(alamat)];
    if (!toko && !semua) throw new ApiError('SHOP_LOCATION_UNKNOWN', 404);
    const now = indeks.waktuBlok(), hasil = [];
    for (const [id, o] of indeks.semua()) {
      if (statusDari(o) !== 'Open' || now >= BigInt(o.dibuatPada) + k.batasAntre) continue;
      const lok = data.order[id.toString()];
      const jarak = lok && toko ? jarakKm(toko, lok) : null;
      if (jarak === null ? !semua : jarak > RADIUS_KM) continue;
      hasil.push({
        id: id.toString(), jenis: o.jenis, halaman: o.halaman, harga: o.harga.toString(), batasKerja: o.batasKerja,
        teks: o.teks, adaDokumen: BigInt(o.dokumen) !== 0n, pakaiKode: BigInt(o.kodeHash) !== 0n,
        dibuatPada: o.dibuatPada, sisaAntre: Number(BigInt(o.dibuatPada) + k.batasAntre - now),
        jarakKm: jarak === null ? null : Math.round(jarak * 100) / 100,
      });
    }
    hasil.sort((a, b) => (a.jarakKm ?? 99) - (b.jarakKm ?? 99) || a.dibuatPada - b.dibuatPada);
    return { toko: toko ?? null, radiusKm: RADIUS_KM, order: hasil };
  }

  return { setToko, setOrder, feed, jumlah: () => ({ toko: Object.keys(data.toko).length, order: Object.keys(data.order).length }) };
}

export type Lokasi = ReturnType<typeof buatLokasi>;
