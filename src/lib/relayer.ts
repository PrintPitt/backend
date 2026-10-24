// Relayer: penonton tanpa MON menandatangani `Pesanan` (EIP-712) + `permit` tIDRX; relayer mengirim createOrderFor
// dan membayar gas MON. Fee relayer (tIDRX) dipotong contract dari saldo penonton ke wallet relayer.
// Setiap pesanan disimulasikan dulu (eth_call) supaya tanda tangan salah / saldo kurang tidak membakar gas.
import {
  BaseError, ContractFunctionRevertedError, encodeFunctionData, getAddress, isAddress, isHex,
  type Address, type Hex, type WalletClient,
} from 'viem';
import { GAS_LIMIT, teksValid } from '@printpitt/shared';
import { ApiError, jeda, log, pesanError, type Koneksi } from '../common.ts';
import { buatAntrean } from './antrean.ts';

const angka = (v: unknown, nama: string) => {
  if (typeof v !== 'string' && typeof v !== 'number') throw new ApiError(`BAD_${nama}`, 400);
  if (!/^\d{1,78}$/.test(String(v))) throw new ApiError(`BAD_${nama}`, 400);
  return BigInt(v);
};
const bytes32 = (v: unknown, nama: string) => {
  if (!isHex(v) || v.length !== 66) throw new ApiError(`BAD_${nama}`, 400);
  return v as Hex;
};

/** Ubah body JSON jadi argumen createOrderFor, atau lempar 400. */
export function parsePesanan(body: Record<string, unknown>) {
  const p = body.pesanan as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object') throw new ApiError('BAD_PESANAN', 400);
  if (typeof p.pelanggan !== 'string' || !isAddress(p.pelanggan, { strict: false })) throw new ApiError('BAD_PELANGGAN', 400);
  const jenis = Number(p.jenis);
  if (!Number.isInteger(jenis) || jenis < 1 || jenis > 255) throw new ApiError('BAD_JENIS', 400);
  if (typeof p.teks !== 'string' || !teksValid(p.teks)) throw new ApiError('BAD_TEKS', 400);
  if (!isHex(body.sig) || body.sig.length !== 132) throw new ApiError('BAD_SIG', 400);
  const i = body.izin as Record<string, unknown> | null | undefined;
  const izin = i
    ? { value: angka(i.value, 'IZIN'), deadline: angka(i.deadline, 'IZIN'), v: Number(angka(i.v, 'IZIN')), r: bytes32(i.r, 'IZIN'), s: bytes32(i.s, 'IZIN') }
    : { value: 0n, deadline: 0n, v: 0, r: `0x${'0'.repeat(64)}` as Hex, s: `0x${'0'.repeat(64)}` as Hex };
  if (izin.v > 255) throw new ApiError('BAD_IZIN', 400);
  const pesanan = {
    pelanggan: getAddress(p.pelanggan), jenis, teks: p.teks,
    deadline: angka(p.deadline, 'DEADLINE'), maxFee: angka(p.maxFee, 'MAXFEE'),
  };
  return [pesanan, body.sig as Hex, izin] as const;
}

export function buatRelayer(k: Koneksi, wallet: WalletClient) {
  const antrean = buatAntrean(k, wallet, 'relayer');
  const sedangJalan = new Set<Address>();          // satu pesanan tertunda per pelanggan: nonce berikutnya belum naik
  const stats = { terkirim: 0, ditolak: 0, sukses: 0, revert: 0 };

  async function kirim(body: Record<string, unknown>) {
    const args = parsePesanan(body);
    const pelanggan = args[0].pelanggan;
    if (sedangJalan.has(pelanggan)) { stats.ditolak++; throw new ApiError('PENDING_ORDER', 409); }
    sedangJalan.add(pelanggan);
    // Simulasi dulu; gagal karena RPC diulang maks. 3 kali dengan jeda bertambah.
    for (let coba = 0; ; coba++) {
      try {
        await k.pub.simulateContract({ ...k.contract, functionName: 'createOrderFor', args, account: antrean.alamat });
        break;
      } catch (e) {
        const rev = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
        // Revert diulang sekali: RPC lain di rotasi bisa tertinggal beberapa blok (mis. saldo top-up belum terlihat).
        if ((!(rev instanceof ContractFunctionRevertedError) && coba < 3) || (rev instanceof ContractFunctionRevertedError && coba < 1)) { await jeda(500 * 2 ** coba); continue; }
        sedangJalan.delete(pelanggan); stats.ditolak++;
        if (rev instanceof ContractFunctionRevertedError) throw new ApiError(rev.data?.errorName ?? 'REVERTED', 400);
        log('relayer', `simulasi gagal: ${pesanError(e)}`);
        throw new ApiError('RPC_ERROR', 502);
      }
    }
    try {
      const hash = await antrean.kirim({
        to: k.contract.address, gas: GAS_LIMIT.createOrderFor,
        data: encodeFunctionData({ abi: k.contract.abi, functionName: 'createOrderFor', args }),
      });
      stats.terkirim++;
      void k.pub.waitForTransactionReceipt({ hash }).then(
        (r) => { if (r.status === 'success') stats.sukses++; else stats.revert++; },
        (e) => log('relayer', `receipt ${hash}: ${pesanError(e)}`),
      ).finally(() => sedangJalan.delete(pelanggan));
      return { hash };
    } catch {
      sedangJalan.delete(pelanggan);
      throw new ApiError('SEND_FAILED', 502);
    }
  }

  return { kirim, stats, alamat: antrean.alamat, panjangAntre: antrean.panjang };
}
