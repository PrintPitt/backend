// Uji beban di Monad testnet lewat backend live, meniru hari H:
//   N penonton baru bersamaan: faucet → top-up simulasi → bayar → mint → pesan lewat relayer
//   toko A + toko B rebutan claim dan mengerjakan order; satu order sengaja ditinggal (expire Kerja)
//   order yang tidak terambil dalam batas antre di-expire keeper; order bot menyala selama uji.
// Semua dari satu IP, jadi juga menguji rate limit backend (penonton di WiFi venue berbagi IP).
//   N=30 BASE=https://… node test/uji-beban.mjs
// Aksi toko memakai keystore Foundry `printpitt-toko-a/b` lewat `cast`; ADMIN_TOKEN dibaca dari ~/.printpitt/admin-token.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { createPublicClient, formatEther, http, parseSignature } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';
import { domainPesanan, domainTidrx, fotokopiKilatAbi, formatRupiah, PERMIT_TYPES, PESANAN_TYPES, STATUS, teksValid, tidrxAbi } from '@printpitt/shared';

const N = Number(process.env.N ?? 30);
const BASE = process.env.BASE ?? 'https://backend-production-2b31.up.railway.app';
const RPC = process.env.RPC_URL ?? 'https://testnet-rpc.monad.xyz';
const ADMIN = readFileSync(`${homedir()}/.printpitt/admin-token`, 'utf8').trim();
// RPC publik Monad membatasi 15 request/dtk per IP: klien uji dibatasi RPC_RPS (default 8), sisanya untuk proses cast.
const RPS = Number(process.env.RPC_RPS ?? 5);
const statRpc = { gagal: 0 };
let jatah = [];
async function fetchTerbatas(url, init) {
  for (;;) {
    const now = Date.now(); jatah = jatah.filter((t) => now - t < 1000);
    if (jatah.length < RPS) { jatah.push(now); break; }
    await new Promise((r) => setTimeout(r, 1000 - (now - jatah[0]) + 5));
  }
  return fetch(url, init);
}
const pub = createPublicClient({ chain: monadTestnet, transport: http(RPC, { fetchFn: fetchTerbatas, retryCount: 5, retryDelay: 1500 }), pollingInterval: 1000 });
// Toko memakai RPC publik lain (seperti HP toko sungguhan), supaya tidak berbagi limit dengan klien uji.
const RPC_TOKO = { A: process.env.RPC_TOKO_A ?? 'https://monad-testnet.drpc.org', B: process.env.RPC_TOKO_B ?? 'https://10143.rpc.thirdweb.com' };
// Tiap toko membaca dan menulis lewat RPC yang sama (RPC berbeda bisa tertinggal beberapa blok).
const pubToko = Object.fromEntries(Object.entries(RPC_TOKO).map(([k, url]) => [k, createPublicClient({ chain: monadTestnet, transport: http(url, { retryCount: 3, retryDelay: 800 }) })]));
const errPertama = {};
const sh = promisify(execFile);
const jeda = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now(), dtk = () => ((Date.now() - t0) / 1000).toFixed(1);
const log = (...a) => console.log(`[${dtk().padStart(6)}s]`, ...a);
const hasil = [];
const cek = (nama, ok, detail = '') => { hasil.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nama}${detail ? ' · ' + detail : ''}`); };
const statistik = { http429: 0, httpGagal: 0 };

/** POST/GET ke backend; 429 ditunggu sesuai retryAfter lalu diulang (dihitung). */
async function api(path, body, headers = {}) {
  for (let coba = 0; coba < 6; coba++) {
    const r = await fetch(BASE + path, body ? { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) } : {});
    const j = await r.json().catch(() => ({}));
    if (r.status === 429) { statistik.http429++; await jeda((j.retryAfter ?? 5) * 1000); continue; }
    return { status: r.status, body: j };
  }
  statistik.httpGagal++;
  return { status: 429, body: { error: 'RATE_LIMITED' } };
}
const persen = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };
const ringkas = (xs) => `p50 ${persen(xs, 50)} ms · p95 ${persen(xs, 95)} ms · maks ${Math.max(...xs, 0)} ms`;

const cfg = (await api('/config')).body;
const fk = { address: cfg.contract, abi: fotokopiKilatAbi }, token = { address: cfg.token, abi: tidrxAbi };
const TOKO = { A: '0xD9B470dd86E9876B59Ec4CCd797811D5a8f293e0', B: '0x8B0a62CA2523E33a1B51E28069613f6039Ea1c7F' };
const st0 = (await api('/status')).body;
const PERAN = {
  faucet: st0.faucet.address, relayer: st0.relayer.address, minter: st0.topup.minter, keeper: st0.keeper.address,
  bot: st0.bot.address, 'toko A': TOKO.A, 'toko B': TOKO.B,
};
const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const mc3Abi = [{ type: 'function', name: 'getEthBalance', stateMutability: 'view', inputs: [{ name: 'addr', type: 'address' }], outputs: [{ name: 'balance', type: 'uint256' }] }];
/** Saldo MON banyak alamat dalam satu request (Multicall3.getEthBalance). */
const saldoMonBanyak = (alamat) => pub.multicall({ contracts: alamat.map((a) => ({ address: MC3, abi: mc3Abi, functionName: 'getEthBalance', args: [a] })), allowFailure: false });
const saldoTBanyak = (alamat) => pub.multicall({ contracts: alamat.map((a) => ({ ...token, functionName: 'balanceOf', args: [a] })), allowFailure: false });
const saldoMon = async () => { const v = await saldoMonBanyak(Object.values(PERAN)); return Object.fromEntries(Object.keys(PERAN).map((k, i) => [k, v[i]])); };
const monAwal = await saldoMon();
const idAwal = await pub.readContract({ ...fk, functionName: 'nextId' });
log(`backend ${BASE} · ${N} penonton · order mulai #${idAwal}`);

const TEKS = ['KTP Budi bolak-balik', 'Boarding JOG-CGK 05.40', 'Ijazah S1 Informatika', 'Menu Warung Bu Sri', 'KK + KTP buat CPNS', 'Sertifikat lomba 17-an'];
const penonton = Array.from({ length: N }, (_, i) => ({ i, akun: privateKeyToAccount(generatePrivateKey()), jenis: 1 + (i % 4), teks: TEKS[i % TEKS.length] }));
for (const p of penonton) if (!teksValid(p.teks)) throw new Error(p.teks);

// ---------- 1. faucet bersamaan ----------
{
  const lat = [];
  const res = await Promise.all(penonton.map(async (p) => { const s = Date.now(); const r = await api('/faucet', { address: p.akun.address }); lat.push(Date.now() - s); return r; }));
  const ok = res.filter((r) => r.status === 202);
  cek(`faucet ${N} bersamaan → 202`, ok.length === N, `${ok.length}/${N} · ${ringkas(lat)} · error: ${[...new Set(res.filter((r) => r.status !== 202).map((r) => r.body.error))].join(',') || '-'}`);
  const hashes = new Set(ok.map((r) => r.body.hash));
  cek('hash faucet unik (nonce tidak bentrok)', hashes.size === ok.length);
  let bal = [];
  for (let k = 0; k < 30; k++) { bal = await saldoMonBanyak(penonton.map((p) => p.akun.address)); if (bal.every((b) => b > 0n)) break; await jeda(1000); }
  cek('MON faucet masuk ke semua penonton (on-chain)', bal.every((b) => b > 0n), `${bal.filter((b) => b > 0n).length}/${N}`);
  log('faucet selesai');
}

// ---------- 2. top-up + bayar + mint ----------
{
  const lat = [];
  const metode = (i) => (i % 3 === 2 ? { paymentMethod: 'qris' } : { paymentMethod: 'va', channelId: i % 2 ? 'BRI' : 'MANDIRI' });
  const tus = await Promise.all(penonton.map((p) => api('/topup', { toBeMinted: '20000', destinationWalletAddress: p.akun.address, ...metode(p.i) })));
  cek(`top-up ${N} → 201`, tus.every((r) => r.status === 201), `${tus.filter((r) => r.status === 201).length}/${N}`);
  const s = Date.now();
  const byr = await Promise.all(tus.map((t) => api(`/topup/${t.body.id}/bayar`, {})));
  cek('bayar semua → PAID', byr.every((r) => r.body.paymentStatus === 'PAID'), `${byr.filter((r) => r.body.paymentStatus === 'PAID').length}/${N}`);
  const akhir = await Promise.all(tus.map(async (t) => {
    for (let k = 0; k < 120; k++) { const x = (await api(`/topup/${t.body.id}`)).body; if (['MINTED', 'FAILED'].includes(x.userMintStatus)) { lat.push(Date.now() - s); return x; } await jeda(1000); }
    return { userMintStatus: 'TIMEOUT' };
  }));
  const minted = akhir.filter((x) => x.userMintStatus === 'MINTED').length;
  cek('mint semua → MINTED', minted === N, `${minted}/${N} · bayar→MINTED ${ringkas(lat)}`);
  const saldo = await saldoTBanyak(penonton.map((p) => p.akun.address));
  cek('saldo tiap penonton Rp20.000', saldo.every((x) => x === 2_000_000n));
  log('top-up selesai');
}

// ---------- 3. bot on, toko mulai bekerja, penonton pesan lewat relayer bersamaan ----------
await api('/admin/bot', { on: true, intervalMs: 4000 }, { authorization: `Bearer ${ADMIN}` });
log('order bot ON (4 dtk)');

let berhenti = false;
const tokoStat = { A: { menang: 0, kalah: 0, selesai: 0, gagalTx: 0, gasClaim: [], gasStep: [] }, B: { menang: 0, kalah: 0, selesai: 0, gagalTx: 0, gasClaim: [], gasStep: [] } };
const ditinggal = new Set();

async function cast(nama, fungsi, ...args) {
  const r = nama === 'A' ? 'toko-a' : 'toko-b';
  try {
    const { stdout } = await sh('cast', ['send', cfg.contract, fungsi, ...args.map(String), '--account', `printpitt-${r}`,
      '--password-file', `${homedir()}/.foundry/printpitt-${r}.pass`, '--rpc-url', RPC_TOKO[nama], '--json'],
      { env: { ...process.env, PATH: `${process.env.PATH}:${homedir()}/.foundry/bin` } });
    const j = JSON.parse(stdout);
    return { ok: Number(j.status) === 1, gas: Number(BigInt(j.gasUsed)) };
  } catch (e) { const err = String(e.stderr ?? e.message).split('\n').find((l) => /revert|error/i.test(l)) ?? 'error'; errPertama[nama] ??= err; return { ok: false, err }; }
}

/** Loop satu toko: ambil order Open tertua yang masih dalam batas antre, claim, kerjakan semua langkah. */
async function loopToko(nama) {
  let klaimKe = 0;
  while (!berhenti) {
    let ids = [], now, orders;
    try {
      const pt = pubToko[nama];
      const next = await pt.readContract({ ...fk, functionName: 'nextId' });
      for (let i = idAwal; i < next; i++) ids.push(i);
      if (!ids.length) { await jeda(1200); continue; }
      [{ timestamp: now }, orders] = await Promise.all([
        pt.getBlock(),
        pt.multicall({ contracts: ids.map((id) => ({ ...fk, functionName: 'getOrder', args: [id] })), allowFailure: false }),
      ]);
    } catch { statRpc.gagal++; await jeda(2000); continue; }
    const kandidat = ids.filter((id, k) => STATUS[orders[k].status] === 'Open' && now + 3n < BigInt(orders[k].dibuatPada) + BigInt(cfg.batasAntre ?? 45));
    if (!kandidat.length) { await jeda(1200); continue; }
    const id = kandidat[0];                         // dua toko mengincar order yang sama → rebutan sungguhan
    const c = await cast(nama, 'claim(uint64)', id);
    if (!c.ok) { tokoStat[nama].kalah++; continue; }
    tokoStat[nama].menang++; tokoStat[nama].gasClaim.push(c.gas); klaimKe++;
    if (nama === 'B' && klaimKe === 3) { ditinggal.add(id); log(`toko B meninggalkan order #${id} (uji expire Kerja)`); while (!berhenti) { const o = await pub.readContract({ ...fk, functionName: 'getOrder', args: [id] }).catch(() => null); if (o && STATUS[o.status] !== 'Claimed') break; await jeda(3000); } continue; }
    const o = orders[ids.indexOf(id)];
    let ok = true;
    for (let k = 0; k < o.jumlahLangkah; k++) {
      const kode = Number(`0x${o.langkah.slice(2 + k * 2, 4 + k * 2)}`);
      const s = await cast(nama, 'completeStep(uint64,uint8)', id, kode);
      if (!s.ok) { tokoStat[nama].gagalTx++; ok = false; log(`toko ${nama} completeStep #${id} gagal: ${s.err}`); break; }
      tokoStat[nama].gasStep.push(s.gas);
    }
    if (ok) tokoStat[nama].selesai++;
  }
}
const tokoJalan = [loopToko('A'), loopToko('B')];

const relayLat = [];
const katalog = await pub.multicall({ contracts: [1, 2, 3, 4].map((j) => ({ ...fk, functionName: 'katalog', args: [j] })), allowFailure: false });
const { timestamp: tRelay } = await pub.getBlock();
const relayRes = await Promise.all(penonton.map(async (p) => {
  const harga = katalog[p.jenis - 1][0];
  const fee = BigInt(cfg.feeRelay), deadline = tRelay + 600n;
  const nToken = 0n, nPesanan = 0n;                // akun baru: nonce permit dan nonce pesanan masih 0
  const iz = parseSignature(await p.akun.signTypedData({ domain: domainTidrx(cfg.chainId, cfg.token), types: PERMIT_TYPES, primaryType: 'Permit', message: { owner: p.akun.address, spender: cfg.contract, value: harga + fee, nonce: nToken, deadline } }));
  const ps = { pelanggan: p.akun.address, jenis: p.jenis, teks: p.teks, deadline, maxFee: fee };
  const sig = await p.akun.signTypedData({ domain: domainPesanan(cfg.chainId, cfg.contract), types: PESANAN_TYPES, primaryType: 'Pesanan', message: { ...ps, nonce: nPesanan } });
  const s = Date.now();
  const r = await api('/relay/order', { pesanan: { ...ps, deadline: String(deadline), maxFee: String(fee) }, sig, izin: { value: String(harga + fee), deadline: String(deadline), v: String(iz.v), r: iz.r, s: iz.s } });
  relayLat.push(Date.now() - s);
  return r;
}));
const relayOk = relayRes.filter((r) => r.status === 202);
cek(`relay ${N} bersamaan → 202`, relayOk.length === N, `${relayOk.length}/${N} · ${ringkas(relayLat)} · error: ${[...new Set(relayRes.filter((r) => r.status !== 202).map((r) => r.body.error))].join(',') || '-'}`);
let nonceP = [];
for (let k = 0; k < 40; k++) {
  nonceP = await pub.multicall({ contracts: penonton.map((p) => ({ ...fk, functionName: 'nonces', args: [p.akun.address] })), allowFailure: false });
  if (nonceP.every((n) => n === 1n)) break; await jeda(1000);
}
cek('createOrderFor sukses on-chain (nonce pesanan tiap penonton = 1)', nonceP.every((n) => n === 1n), `${nonceP.filter((n) => n === 1n).length}/${N}`);
log('semua pesanan penonton masuk; toko bekerja…');

// ---------- 4. tunggu batas antre lewat, matikan bot + toko, tunggu keeper ----------
await jeda(60_000);
await api('/admin/bot', { on: false }, { authorization: `Bearer ${ADMIN}` });
log('order bot OFF');
await jeda(8_000);                                  // order bot terakhir masih bisa diambil
berhenti = true;
await Promise.all(tokoJalan);
log('toko berhenti; menunggu keeper menyelesaikan sisa order…');

let final = false, orders = [], ids = [];
for (let k = 0; k < 90 && !final; k++) {
  try {
    const next = await pub.readContract({ ...fk, functionName: 'nextId' });
    ids = []; for (let i = idAwal; i < next; i++) ids.push(i);
    orders = await pub.multicall({ contracts: ids.map((id) => ({ ...fk, functionName: 'getOrder', args: [id] })), allowFailure: false });
  } catch { statRpc.gagal++; await jeda(3000); continue; }
  final = orders.every((o) => ['Finished', 'Expired'].includes(STATUS[o.status]));
  if (!final) await jeda(2000);
}
const hitung = (s) => orders.filter((o) => STATUS[o.status] === s).length;
cek('semua order final (Finished/Expired)', final, `${ids.length} order: ${hitung('Finished')} Finished, ${hitung('Expired')} Expired, ${hitung('Open')} Open, ${hitung('Claimed')} Claimed`);
const expKerja = [...ditinggal].every((id) => { const o = orders[ids.indexOf(id)]; return o && STATUS[o.status] === 'Expired'; });
cek('order yang ditinggal toko B di-expire keeper', ditinggal.size === 0 || expKerja, [...ditinggal].map((i) => `#${i}`).join(','));
const escrow = await pub.readContract({ ...token, functionName: 'balanceOf', args: [cfg.contract] });
cek('escrow contract kosong setelah semua final', escrow === 0n, formatRupiah(escrow));
const nftPenonton = await pub.multicall({ contracts: penonton.map((p) => ({ ...fk, functionName: 'balanceOf', args: [p.akun.address] })), allowFailure: false });
const pesananPenonton = orders.filter((o) => penonton.some((p) => p.akun.address === o.pelanggan));
cek('NFT penonton = order penonton yang Finished', nftPenonton.reduce((a, b) => a + b, 0n) === BigInt(pesananPenonton.filter((o) => STATUS[o.status] === 'Finished').length));

// ---------- ringkasan ----------
const stAkhir = (await api('/status')).body;
const monAkhir = await saldoMon();
console.log('\n--- toko ---');
for (const [n, s] of Object.entries(tokoStat)) console.log(`toko ${n} (${RPC_TOKO[n]}): menang claim ${s.menang}, kalah rebutan ${s.kalah} (error pertama: ${errPertama[n] ?? '-'}), selesai ${s.selesai}, tx gagal ${s.gagalTx}, gas claim maks ${Math.max(0, ...s.gasClaim)}, gas step maks ${Math.max(0, ...s.gasStep)}`);
console.log('--- backend ---');
console.log(`faucet funded ${stAkhir.faucet.funded}, gagal ${stAkhir.faucet.gagal} · minter minted ${stAkhir.topup.minted}, gagal ${stAkhir.topup.gagal} · relayer sukses ${stAkhir.relayer.sukses}, revert ${stAkhir.relayer.revert}, ditolak ${stAkhir.relayer.ditolak} · keeper expired ${stAkhir.keeper.expired} · bot orders ${stAkhir.bot.orders}, gagal ${stAkhir.bot.gagal}`);
console.log(`HTTP 429 dari backend ${statistik.http429} (diulang), gagal total ${statistik.httpGagal} · baca RPC klien uji gagal ${statRpc.gagal}`);
console.log('--- MON terpakai ---');
for (const k of Object.keys(PERAN)) console.log(`${k.padEnd(8)} ${formatEther(monAwal[k] - monAkhir[k]).slice(0, 8)} MON (sisa ${formatEther(monAkhir[k]).slice(0, 7)})`);
const gagal = hasil.filter((x) => !x).length;
console.log(`\n${hasil.length - gagal}/${hasil.length} PASS dalam ${dtk()} dtk`);
process.exit(gagal ? 1 : 0);
