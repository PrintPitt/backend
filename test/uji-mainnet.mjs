// Uji alur lengkap di Monad mainnet (143) lewat backend-mainnet, memakai MON asli (±1 MON faucet + gas):
// toko demo daftar sendiri (MON dari faucet berkode) → set lokasi → juri baru klaim voucher tIDRX (tanpa MON) →
// unggah dokumen → pesan lewat relayer (permit) → lokasi order → feed radius → toko claim → unduh dokumen →
// kerjakan → Siap → serah terima QR → Finished + NFT + fee platform ke treasury.
//   node test/uji-mainnet.mjs
// Toko memakai keystore Foundry `printpitt-main-toko-demo` lewat `cast` (kunci tidak dibaca script ini);
// kode juri dibaca dari ~/.printpitt/kode-juri dan tidak dicetak.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createPublicClient, http, keccak256, parseSignature } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { monad } from 'viem/chains';
import {
  bulatkanKoordinat, domainPesanan, domainTidrx, fotokopiKilatAbi, formatRupiah, PERMIT_TYPES, PESANAN_TYPES,
  pesanLokasiOrder, pesanLokasiToko, pesanUnduh, STATUS, tidrxAbi,
} from '@printpitt/shared';

const BASE = process.env.BASE ?? 'https://backend-mainnet-production-7835.up.railway.app';
const RPC = process.env.RPC_URL ?? 'https://rpc.monad.xyz';
const KODE = readFileSync(`${homedir()}/.printpitt/kode-juri`, 'utf8').trim();
const TOKO_AKUN = 'printpitt-main-toko-demo';
const jeda = (ms) => new Promise((r) => setTimeout(r, ms));

// RPC publik: maks. 5 request/dtk, ulangi jawaban "requests limited".
let jejak = [];
async function fetchPelan(url, init) {
  for (let coba = 0; ; coba++) {
    for (;;) { const now = Date.now(); jejak = jejak.filter((x) => now - x < 1000); if (jejak.length < 5) { jejak.push(now); break; } await jeda(100); }
    const r = await fetch(url, init); const teks = await r.text();
    if (coba < 8 && /requests? limited|rate limit/i.test(teks)) { await jeda(1200); continue; }
    return new Response(teks, { status: r.status, headers: r.headers });
  }
}
const pub = createPublicClient({ chain: monad, transport: http(RPC, { fetchFn: fetchPelan }), pollingInterval: 1000 });
const hasil = [];
const cek = (nama, ok, detail = '') => { hasil.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nama}${detail ? ' · ' + detail : ''}`); };
const api = async (path, body) => {
  const r = await fetch(BASE + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const env = { ...process.env, PATH: `${process.env.PATH}:${homedir()}/.foundry/bin` };
const castArgs = ['--account', TOKO_AKUN, '--password-file', `${homedir()}/.foundry/${TOKO_AKUN}.pass`];
const tokoKirim = (fungsi, ...args) => JSON.parse(execFileSync('cast', ['send', cfg.contract, fungsi, ...args.map(String), ...castArgs, '--rpc-url', RPC, '--json'], { env }).toString());
const tokoSign = (pesan) => execFileSync('cast', ['wallet', 'sign', pesan, ...castArgs], { env }).toString().trim();

const cfg = (await api('/config')).body;
cek('backend mainnet chain 143 + mode voucher', cfg.chainId === 143 && cfg.topupMode === 'voucher', cfg.contract);
const fk = { address: cfg.contract, abi: fotokopiKilatAbi }, token = { address: cfg.token, abi: tidrxAbi };
const TOKO = execFileSync('cast', ['wallet', 'address', ...castArgs], { env }).toString().trim();
const saldoT = (a) => pub.readContract({ ...token, functionName: 'balanceOf', args: [a] });

// 1. toko demo: MON dari faucet (kode juri) bila kosong, lalu daftar sendiri
if ((await pub.getBalance({ address: TOKO })) < 50_000_000_000_000_000n) {
  const f = await api('/faucet', { address: TOKO, kode: KODE });
  cek('faucet 1 MON ke toko demo (kode juri)', f.status === 202, f.body.error ?? f.body.hash);
  if (f.body.hash) await pub.waitForTransactionReceipt({ hash: f.body.hash });
}
let [terdaftar] = await pub.readContract({ ...fk, functionName: 'toko', args: [TOKO] });
if (!terdaftar) {
  const r = tokoKirim('daftarkanToko(string)', 'PrintPitt Demo');
  cek('toko demo daftar sendiri (daftarkanToko)', Number(r.status) === 1, `gas ${BigInt(r.gasUsed)}`);
  await jeda(2000);
  [terdaftar] = await pub.readContract({ ...fk, functionName: 'toko', args: [TOKO] });
}
cek('toko demo terdaftar on-chain', terdaftar, TOKO);
const [latT, lngT] = [bulatkanKoordinat(-7.7829), bulatkanKoordinat(110.3671)];   // Tugu Jogja
{ const waktu = Date.now(); const r = await api('/toko/lokasi', { toko: TOKO, lat: latT, lng: lngT, waktu, sig: tokoSign(pesanLokasiToko(TOKO, latT, lngT, waktu)) });
  cek('toko set lokasi', r.status === 200, r.body.error ?? `${r.body.radiusKm} km`); }

// 2. juri baru (tanpa MON): voucher tIDRX
const juri = privateKeyToAccount(generatePrivateKey());
const v = await api('/topup', { destinationWalletAddress: juri.address, kode: KODE });
cek('voucher juri → PAID', v.status === 201 && v.body.paymentStatus === 'PAID', v.body.error ?? formatRupiah(BigInt(v.body.baseAmount * 100)));
let st;
for (let i = 0; i < 30; i++) { st = (await api(`/topup/${v.body.id}`)).body; if (['MINTED', 'FAILED'].includes(st.userMintStatus)) break; await jeda(1000); }
cek('voucher MINTED, saldo masuk', st?.userMintStatus === 'MINTED' && (await saldoT(juri.address)) > 0n, formatRupiah(await saldoT(juri.address)));

// 3. unggah dokumen + pesan lewat relayer (permit), tanpa MON
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R>>endobj\n4 0 obj<</Type/Page/Parent 2 0 R>>endobj\n%%EOF\n', 'latin1');
const up = await (await fetch(BASE + '/dokumen', { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-nama-file': 'uji-mainnet.pdf' }, body: pdf })).json();
cek('unggah dokumen terenkripsi', /^0x[0-9a-f]{64}$/.test(up.dokumen ?? ''), `${up.halaman} hal`);
const [harga] = await pub.readContract({ ...fk, functionName: 'hargaUntuk', args: [5, up.halaman] });
const fee = BigInt(cfg.feeRelay), { timestamp } = await pub.getBlock(), deadline = timestamp + 1800n;
const iz = parseSignature(await juri.signTypedData({ domain: domainTidrx(143, cfg.token), types: PERMIT_TYPES, primaryType: 'Permit',
  message: { owner: juri.address, spender: cfg.contract, value: harga + fee, nonce: await pub.readContract({ ...token, functionName: 'nonces', args: [juri.address] }), deadline } }));
const rahasia = generatePrivateKey();
const ps = { pelanggan: juri.address, jenis: 5, teks: 'Uji mainnet PrintPitt', halaman: up.halaman, dokumen: up.dokumen, kodeHash: keccak256(rahasia), deadline, maxFee: fee };
const sig = await juri.signTypedData({ domain: domainPesanan(143, cfg.contract), types: PESANAN_TYPES, primaryType: 'Pesanan', message: { ...ps, nonce: 0n } });
const rr = await api('/relay/order', { pesanan: { ...ps, deadline: String(deadline), maxFee: String(fee) }, sig,
  izin: { value: String(harga + fee), deadline: String(deadline), v: String(iz.v), r: iz.r, s: iz.s } });
cek('relay pesanan (permit, juri tanpa MON) → 202', rr.status === 202, rr.body.error ?? rr.body.hash);
const rc = rr.body.hash && await pub.waitForTransactionReceipt({ hash: rr.body.hash });
cek('createOrderFor sukses on-chain', rc?.status === 'success');
const id = (await pub.readContract({ ...fk, functionName: 'nextId' })) - 1n;
cek(`order #${id} milik juri, ${up.halaman} halaman`, (await pub.readContract({ ...fk, functionName: 'getOrder', args: [id] })).pelanggan === juri.address, formatRupiah(harga));

// 4. lokasi order + feed radius toko
const [latO, lngO] = [bulatkanKoordinat(-7.7856), bulatkanKoordinat(110.3678)];
{ const waktu = Date.now(); const r = await api(`/order/${id}/lokasi`, { lat: latO, lng: lngO, waktu, sig: await juri.signMessage({ message: pesanLokasiOrder(id, latO, lngO, waktu) }) });
  cek('juri set lokasi order', r.status === 200, r.body.error ?? ''); }
let diFeed;
for (let i = 0; i < 20 && !diFeed; i++) { diFeed = (await api(`/toko/${TOKO}/feed`)).body.order?.find((o) => o.id === String(id)); if (!diFeed) await jeda(1000); }
cek('order muncul di feed toko (radius)', !!diFeed, diFeed ? `${diFeed.jarakKm} km` : 'tidak ada');

// 5. toko claim → unduh dokumen → kerjakan → Siap → serah terima QR
const saldoToko0 = await saldoT(TOKO), saldoTreasury0 = await saldoT(cfg.treasury);
const c = tokoKirim('claim(uint64)', id);
cek('toko claim', Number(c.status) === 1, `gas ${BigInt(c.gasUsed)}`);
{ const waktu = Date.now(); const r = await fetch(`${BASE}/dokumen/${up.dokumen}/unduh`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: String(id), alamat: TOKO, waktu, sig: tokoSign(pesanUnduh(up.dokumen, id, waktu)) }) });
  const isi = Buffer.from(await r.arrayBuffer()); cek('toko unduh dokumen (isi sama)', r.status === 200 && isi.equals(pdf)); }
let s;
for (let coba = 0; coba < 3; coba++) { try { s = tokoKirim('completeStep(uint64,uint8)', id, 2); break; } catch { await jeda(2000); } }
cek('toko completeStep → Siap', Number(s?.status) === 1 && STATUS[(await pub.readContract({ ...fk, functionName: 'getOrder', args: [id] })).status] === 'Siap');
const h = tokoKirim('serahkan(uint64,bytes32)', id, rahasia);
cek('toko scan QR → serahkan', Number(h.status) === 1, `gas ${BigInt(h.gasUsed)}`);
await jeda(1500);
const o = await pub.readContract({ ...fk, functionName: 'getOrder', args: [id] });
cek('order Finished + NFT ke juri', STATUS[o.status] === 'Finished' && (await pub.readContract({ ...fk, functionName: 'ownerOf', args: [id] })) === juri.address, `kerja ${o.kerja} dtk`);
cek('toko dapat payout, treasury dapat fee 3%', (await saldoT(TOKO)) > saldoToko0 && (await saldoT(cfg.treasury)) > saldoTreasury0,
  `toko +${formatRupiah((await saldoT(TOKO)) - saldoToko0)}, treasury +${formatRupiah((await saldoT(cfg.treasury)) - saldoTreasury0)}`);
console.log(`      NFT: https://monadscan.com/token/${cfg.contract}?a=${id} · order tx: https://monadscan.com/tx/${rr.body.hash}`);
const gagal = hasil.filter((x) => !x).length;
console.log(`\n${hasil.length - gagal}/${hasil.length} PASS`);
process.exit(gagal ? 1 : 0);
