// Dokumen order (BLZ-21): disimpan terenkripsi di disk (volume Railway), hanya toko pemenang dan pelanggan pemilik
// yang bisa mengunduh, dan dihapus otomatis begitu order final. Hash yang masuk order on-chain = keccak256(ciphertext).
//
// Enkripsi envelope: tiap file punya kunci data acak (AES-256-GCM); kunci data dibungkus master key DOKUMEN_KEY
// (32 byte hex di env, tidak pernah ditulis ke disk). Tanpa DOKUMEN_KEY service membuat kunci sementara: dokumen
// tidak bisa dibuka lagi setelah restart.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress, isAddress, isHex, keccak256, recoverMessageAddress, type Hex } from 'viem';
import { pesanUnduh } from '@printpitt/shared';
import { ApiError, log, pesanError, type Koneksi } from '../common.ts';
import { statusDari, sudahFinal, type IndeksOrder } from './indeksOrder.ts';

const MAX_MB = Number(process.env.DOKUMEN_MAX_MB ?? 10);
const TTL_MENIT = Number(process.env.DOKUMEN_TTL_MENIT ?? 120);   // upload yang tidak pernah dipakai order
const BERLAKU_MS = 5 * 60_000;                                    // umur tanda tangan unduh

type Meta = {
  dokumen: Hex; mime: string; nama: string; ukuran: number; halaman: number; dibuat: number; orderId?: string;
  ivData: string; tagData: string; kunci: string; ivKunci: string; tagKunci: string;
};

/** Jenis file dari magic bytes (bukan dari header yang dikirim klien). */
function jenisFile(b: Buffer) {
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return null;
}

/** Perkiraan jumlah halaman PDF: maks. dari jumlah objek /Type /Page dan nilai /Count di pohon halaman. */
export function hitungHalamanPdf(b: Buffer) {
  const s = b.toString('latin1');
  const objek = (s.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
  const count = Math.max(0, ...[...s.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1])));
  return Math.max(1, objek, count);
}

const aes = (kunci: Buffer, data: Buffer) => {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', kunci, iv);
  const isi = Buffer.concat([c.update(data), c.final()]);
  return { iv, isi, tag: c.getAuthTag() };
};
const bukaAes = (kunci: Buffer, iv: Buffer, tag: Buffer, isi: Buffer) => {
  const d = createDecipheriv('aes-256-gcm', kunci, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(isi), d.final()]);
};

export function buatDokumen(k: Koneksi, indeks: IndeksOrder, dataDir: string) {
  const dir = join(dataDir, 'dokumen');
  mkdirSync(dir, { recursive: true });
  const kunciEnv = process.env.DOKUMEN_KEY;
  if (kunciEnv && !/^(0x)?[0-9a-fA-F]{64}$/.test(kunciEnv)) throw new Error('DOKUMEN_KEY harus 32 byte hex');
  const master = kunciEnv ? Buffer.from(kunciEnv.replace(/^0x/, ''), 'hex') : randomBytes(32);
  if (!kunciEnv) log('dokumen', 'PERINGATAN: DOKUMEN_KEY kosong, memakai kunci sementara (dokumen hilang saat restart)');

  const meta = new Map<string, Meta>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try { const m = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Meta; meta.set(m.dokumen, m); } catch { /* file rusak dilewati */ }
  }
  const stats = { disimpan: 0, diunduh: 0, dihapus: 0, ditolak: 0 };
  const simpanMeta = (m: Meta) => writeFileSync(join(dir, `${m.dokumen}.json`), JSON.stringify(m));

  function hapus(hash: string, alasan: string) {
    if (!meta.delete(hash)) return;
    rmSync(join(dir, `${hash}.bin`), { force: true });
    rmSync(join(dir, `${hash}.json`), { force: true });
    stats.dihapus++;
    log('dokumen', `hapus ${hash.slice(0, 10)}… (${alasan})`);
  }

  // Hubungkan dokumen ke order saat order terindeks; hapus begitu order final (Finished/Expired/Diputuskan).
  indeks.dengar((id, o) => {
    const m = meta.get(o.dokumen.toLowerCase());
    if (!m) return;
    if (!m.orderId) { m.orderId = id.toString(); simpanMeta(m); }
    if (sudahFinal(o)) hapus(m.dokumen, `order #${id} ${statusDari(o)}`);
  });
  setInterval(() => {
    const batas = Date.now() - TTL_MENIT * 60_000;
    for (const m of [...meta.values()]) if (!m.orderId && m.dibuat < batas) hapus(m.dokumen, 'tidak dipakai order');
  }, 60_000).unref();

  /** Simpan file terenkripsi. Kembalikan hash untuk `dokumen` di order + perkiraan jumlah halaman. */
  function simpan(isi: Buffer, namaFile: string) {
    if (!isi.length) throw new ApiError('EMPTY_FILE', 400);
    if (isi.length > MAX_MB * 1024 * 1024) throw new ApiError('FILE_TOO_LARGE', 413);
    const mime = jenisFile(isi);
    if (!mime) throw new ApiError('UNSUPPORTED_FILE', 415);
    const halaman = mime === 'application/pdf' ? hitungHalamanPdf(isi) : 1;
    const kunciData = randomBytes(32);
    const data = aes(kunciData, isi);
    const kunci = aes(master, kunciData);
    const dokumen = keccak256(data.isi).toLowerCase() as Hex;
    const nama = namaFile.replace(/[^\w.\- ]/g, '_').slice(0, 80) || 'dokumen';
    const m: Meta = {
      dokumen, mime, nama, ukuran: isi.length, halaman, dibuat: Date.now(),
      ivData: data.iv.toString('hex'), tagData: data.tag.toString('hex'),
      kunci: kunci.isi.toString('hex'), ivKunci: kunci.iv.toString('hex'), tagKunci: kunci.tag.toString('hex'),
    };
    writeFileSync(join(dir, `${dokumen}.bin`), data.isi);
    simpanMeta(m);
    meta.set(dokumen, m);
    stats.disimpan++;
    return { dokumen, mime, ukuran: m.ukuran, halaman, kedaluwarsa: new Date(m.dibuat + TTL_MENIT * 60_000).toISOString() };
  }

  /** Info publik (tanpa nama file): dipakai FE/toko untuk menampilkan jumlah halaman sebelum claim. */
  function info(hash: string) {
    const m = meta.get(hash.toLowerCase());
    if (!m) throw new ApiError('NOT_FOUND', 404);
    return { dokumen: m.dokumen, mime: m.mime, ukuran: m.ukuran, halaman: m.halaman, orderId: m.orderId ?? null };
  }

  /**
   * Unduh: penandatangan pesan `pesanUnduh` harus pelanggan order, atau toko pemenang selama order Claimed/Siap/Sengketa.
   * Status order dibaca langsung dari chain (bukan indeks) supaya akses berhenti tepat saat order berubah.
   */
  async function unduh(hash: string, body: Record<string, unknown>) {
    const m = meta.get(hash.toLowerCase());
    if (!m) throw new ApiError('NOT_FOUND', 404);
    const waktu = Number(body.waktu);
    if (!Number.isFinite(waktu) || Math.abs(Date.now() - waktu) > BERLAKU_MS) throw new ApiError('SIGNATURE_EXPIRED', 401);
    if (typeof body.orderId !== 'string' && typeof body.orderId !== 'number') throw new ApiError('BAD_ORDER', 400);
    if (!/^\d{1,19}$/.test(String(body.orderId))) throw new ApiError('BAD_ORDER', 400);
    const orderId = BigInt(body.orderId as string);
    if (!isHex(body.sig) || typeof body.alamat !== 'string' || !isAddress(body.alamat, { strict: false })) throw new ApiError('BAD_SIG', 400);
    let penanda: string;
    try { penanda = await recoverMessageAddress({ message: pesanUnduh(m.dokumen, orderId, waktu), signature: body.sig as Hex }); }
    catch { throw new ApiError('BAD_SIG', 401); }
    if (penanda !== getAddress(body.alamat)) { stats.ditolak++; throw new ApiError('BAD_SIG', 401); }

    let o;
    try { o = await k.pub.readContract({ ...k.contract, functionName: 'getOrder', args: [orderId] }); }
    catch (e) { log('dokumen', `baca order #${orderId} gagal: ${pesanError(e)}`); throw new ApiError('RPC_ERROR', 502); }
    if (o.dokumen.toLowerCase() !== m.dokumen) { stats.ditolak++; throw new ApiError('NOT_THIS_ORDER', 403); }
    const status = statusDari(o);
    const pelanggan = penanda === o.pelanggan;
    const tokoPemenang = penanda === o.toko && ['Claimed', 'Siap', 'Sengketa'].includes(status);
    if (!pelanggan && !tokoPemenang) { stats.ditolak++; throw new ApiError('FORBIDDEN', 403); }

    const kunciData = bukaAes(master, Buffer.from(m.ivKunci, 'hex'), Buffer.from(m.tagKunci, 'hex'), Buffer.from(m.kunci, 'hex'));
    const isi = bukaAes(kunciData, Buffer.from(m.ivData, 'hex'), Buffer.from(m.tagData, 'hex'), readFileSync(join(dir, `${m.dokumen}.bin`)));
    stats.diunduh++;
    log('dokumen', `unduh ${m.dokumen.slice(0, 10)}… order #${orderId} oleh ${pelanggan ? 'pelanggan' : 'toko'}`);
    return { isi, mime: m.mime, nama: m.nama };
  }

  return { simpan, info, unduh, stats: () => ({ ...stats, tersimpan: meta.size }) };
}
