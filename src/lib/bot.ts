// Order bot: places one random order through the same path as the audience (approve tIDRX once, then createOrder).
import { maxUint256, type WalletClient } from 'viem';
import { formatRupiah, GAS_LIMIT, NOL32, teksValid } from '@printpitt/shared';
import { log, type Koneksi } from '../common.ts';

// Order texts are stored onchain, so they stay in Indonesian (local demo content).
const TEKS: Record<number, string[]> = {
  1: ['KTP Budi bolak-balik 10x', 'KTP buat daftar CPNS', 'KTP + KK sekalian Mas'],
  2: ['Boarding JOG-CGK 05.40', 'Tiket kereta Taksaka', 'Boarding pass, pesawat 20 menit lagi'],
  3: ['Ijazah S1 Teknik Informatika', 'Ijazah SMA buat lamaran', 'Sertifikat lomba 17-an'],
  4: ['Menu Warung Bu Sri', 'Menu Angkringan Lik Man', 'Menu Kopi Klotok'],
};
for (const daftar of Object.values(TEKS)) for (const t of daftar) if (!teksValid(t)) throw new Error(`Invalid bot text: ${t}`);

const acak = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

/** `isiSaldo` (optional): called when the bot's tIDRX balance is too low, e.g. the simulated minter mints a new balance. */
export function buatBot(k: Koneksi, wallet: WalletClient, isiSaldo?: (ke: `0x${string}`) => Promise<void>) {
  const { pub, contract, token } = k;
  const saya = wallet.account!.address;
  const stats = { orders: 0, gagal: 0 };

  async function pastikanToken(harga: bigint) {
    if ((await pub.readContract({ ...token, functionName: 'balanceOf', args: [saya] })) < harga) {
      if (!isiSaldo) throw new Error('bot tIDRX balance too low');
      await isiSaldo(saya);
    }
    if ((await pub.readContract({ ...token, functionName: 'allowance', args: [saya, contract.address] })) < harga) {
      const hash = await wallet.writeContract({
        ...token, functionName: 'approve', args: [contract.address, maxUint256], gas: GAS_LIMIT.approve,
        account: wallet.account!, chain: k.chain,
      });
      await k.receipt(hash);
      log('bot', 'approved tIDRX for the contract');
    }
  }

  /** One random order. Returns false if the session is not open or the catalog item is inactive. */
  async function sekali() {
    const sesiAktif = await pub.readContract({ ...contract, functionName: 'sesiAktif' });
    if (!sesiAktif) return false;
    const jenis = acak([1, 2, 3, 4]);
    // catalog v2: (hargaDasar, hargaPerHalaman, batasDasar, batasPerHalaman, langkah, jumlahLangkah, aktif, label); the bot orders 1 page
    const [hargaDasar, hargaPerHalaman, , , , , aktif, label] = await pub.readContract({ ...contract, functionName: 'katalog', args: [jenis] });
    const harga = hargaDasar + hargaPerHalaman;
    if (!aktif) return false;
    const teks = acak(TEKS[jenis]);
    await pastikanToken(harga);
    const hash = await wallet.writeContract({
      ...contract, functionName: 'createOrder', args: [jenis, teks, 1, NOL32, NOL32], gas: GAS_LIMIT.createOrder,
      account: wallet.account!, chain: k.chain,
    });
    const r = await k.receipt(hash);
    if (r.status === 'success') stats.orders++; else stats.gagal++;
    log('bot', `#${stats.orders} ${label} "${teks}" ${formatRupiah(harga)} → ${r.status}`);
    return r.status === 'success';
  }
  return { sekali, stats };
}
