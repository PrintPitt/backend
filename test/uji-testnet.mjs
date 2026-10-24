// Uji end-to-end di Monad testnet lewat backend yang sudah deploy (Railway), dengan penonton baru tanpa MON:
// faucet → top-up simulasi → bayar → tIDRX masuk → pesan dokumen lewat relayer → toko A claim + kerjakan → Siap →
// serah terima QR → Finished + NFT.
// Juga mengukur gas asli claim, completeStep, createOrderFor (BLZ-07.T4).
//   BASE=https://… node test/uji-testnet.mjs
// Aksi toko memakai keystore Foundry `printpitt-toko-a` lewat `cast` (kunci tidak dibaca script ini).
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { createPublicClient, http, keccak256, parseSignature } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { domainPesanan, domainTidrx, fotokopiKilatAbi, formatRupiah, PERMIT_TYPES, PESANAN_TYPES, STATUS, tidrxAbi } from '@printpitt/shared';

const JENIS = 5, HALAMAN = 6; // PRINT DOKUMEN 6 halaman (harga per halaman)

const BASE = process.env.BASE ?? 'https://backend-production-2b31.up.railway.app';
const RPC = process.env.RPC_URL ?? 'https://testnet-rpc.monad.xyz';
const jeda = (ms) => new Promise((r) => setTimeout(r, ms));
// RPC publik membatasi 15 request/dtk per IP: maks. 5 request/dtk, ulangi jawaban "requests limited".
let jejak = [];
async function fetchPelan(url, init) {
  for (let coba = 0; ; coba++) {
    for (;;) { const now = Date.now(); jejak = jejak.filter((x) => now - x < 1000); if (jejak.length < 5) { jejak.push(now); break; } await jeda(100); }
    const r = await fetch(url, init); const teks = await r.text();
    if (coba < 8 && /requests? limited/i.test(teks)) { await jeda(1200); continue; }
    return new Response(teks, { status: r.status, headers: r.headers });
  }
}
const pub = createPublicClient({ transport: http(RPC, { fetchFn: fetchPelan }), pollingInterval: 1000 });
const hasil = [];
const cek = (nama, ok, detail = '') => { hasil.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nama}${detail ? ' · ' + detail : ''}`); };
const api = async (path, body) => {
  const r = await fetch(BASE + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return { status: r.status, body: await r.json() };
};
const tunggu = async (fn, n = 40) => { for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await jeda(500); } return null; };

/** Kirim tx dari wallet toko A lewat cast + keystore; kembalikan receipt viem. */
function toko(fungsi, ...args) {
  const out = execFileSync('cast', ['send', cfg.contract, fungsi, ...args.map(String),
    '--account', 'printpitt-toko-a', '--password-file', `${homedir()}/.foundry/printpitt-toko-a.pass`, '--rpc-url', RPC, '--json'],
    { env: { ...process.env, PATH: `${process.env.PATH}:${homedir()}/.foundry/bin` } });
  return JSON.parse(out.toString());
}

const cfg = (await api('/config')).body;
const fk = { address: cfg.contract, abi: fotokopiKilatAbi }, token = { address: cfg.token, abi: tidrxAbi };
const chainId = cfg.chainId;
const penonton = privateKeyToAccount(generatePrivateKey());
const TOKO_A = '0xD9B470dd86E9876B59Ec4CCd797811D5a8f293e0';
const saldoT = (a) => pub.readContract({ ...token, functionName: 'balanceOf', args: [a] });
console.log(`backend ${BASE} · chain ${chainId} · penonton ${penonton.address}`);

// 1. faucet
{ const r = await api('/faucet', { address: penonton.address });
  cek('faucet → 202', r.status === 202, r.body.error ?? r.body.hash);
  if (r.body.hash) { const rc = await pub.waitForTransactionReceipt({ hash: r.body.hash }); cek('faucet tx sukses, penonton dapat MON', rc.status === 'success'); } }

// 2. top-up simulasi + bayar
const tu = await api('/topup', { toBeMinted: '20000', destinationWalletAddress: penonton.address, paymentMethod: 'va', channelId: 'BRI' });
cek('top-up Rp20.000 → 201', tu.status === 201, `bayar Rp${tu.body.amount}`);
const bayar = await api(`/topup/${tu.body.id}/bayar`, {});
cek('bayar → PAID', bayar.status === 200 && bayar.body.paymentStatus === 'PAID', bayar.body.userMintStatus ?? bayar.body.error);
const st = await tunggu(async () => { const s = (await api(`/topup/${tu.body.id}`)).body; return ['MINTED', 'FAILED'].includes(s.userMintStatus) && s; });
cek('mint → MINTED', st?.userMintStatus === 'MINTED', st?.txHash);
if (st?.txHash) { const rc = await pub.getTransactionReceipt({ hash: st.txHash }); console.log(`      gas mint ${rc.gasUsed}`); }
cek('saldo penonton Rp20.000', (await saldoT(penonton.address)) === 2_000_000n);

// 3. pesan tanpa approve/MON lewat relayer
const [harga] = await pub.readContract({ ...fk, functionName: 'hargaUntuk', args: [JENIS, HALAMAN] });
const rahasia = generatePrivateKey(), dokumen = keccak256('0x736b72697073692e706466');
const fee = BigInt(cfg.feeRelay);
const { timestamp } = await pub.getBlock();
const deadline = timestamp + 600n;
const izin = parseSignature(await penonton.signTypedData({
  domain: domainTidrx(chainId, cfg.token), types: PERMIT_TYPES, primaryType: 'Permit',
  message: { owner: penonton.address, spender: cfg.contract, value: harga + fee, nonce: await pub.readContract({ ...token, functionName: 'nonces', args: [penonton.address] }), deadline },
}));
const pesanan = { pelanggan: penonton.address, jenis: JENIS, teks: 'Skripsi uji testnet', halaman: HALAMAN, dokumen, kodeHash: keccak256(rahasia), deadline, maxFee: fee };
const sig = await penonton.signTypedData({
  domain: domainPesanan(chainId, cfg.contract), types: PESANAN_TYPES, primaryType: 'Pesanan',
  message: { ...pesanan, nonce: await pub.readContract({ ...fk, functionName: 'nonces', args: [penonton.address] }) },
});
const rr = await api('/relay/order', {
  pesanan: { ...pesanan, deadline: String(deadline), maxFee: String(fee) }, sig,
  izin: { value: String(harga + fee), deadline: String(deadline), v: String(izin.v), r: izin.r, s: izin.s },
});
cek('relay → 202', rr.status === 202, rr.body.error ?? rr.body.hash);
const rc = rr.body.hash && await pub.waitForTransactionReceipt({ hash: rr.body.hash });
cek('createOrderFor sukses', rc?.status === 'success', rc && `gas ${rc.gasUsed} / limit ${rc.gasUsed ? (await pub.getTransaction({ hash: rr.body.hash })).gas : '?'}`);
const id = (await pub.readContract({ ...fk, functionName: 'nextId' })) - 1n;
cek(`order #${id} milik penonton`, (await pub.readContract({ ...fk, functionName: 'getOrder', args: [id] })).pelanggan === penonton.address);

// 4. toko A claim + kerjakan (PRINT DOKUMEN = 1 langkah Print) → Siap → serah terima QR
const saldoTokoAwal = await saldoT(TOKO_A);
const c = toko('claim(uint64)', id);
cek('toko A claim', Number(c.status) === 1, `gas ${BigInt(c.gasUsed)}`);
const s = toko('completeStep(uint64,uint8)', id, 2);
cek('toko A completeStep (langkah terakhir) → Siap', Number(s.status) === 1 && STATUS[(await pub.readContract({ ...fk, functionName: 'getOrder', args: [id] })).status] === 'Siap', `gas ${BigInt(s.gasUsed)}`);
const h = toko('serahkan(uint64,bytes32)', id, rahasia);
cek('toko A serahkan (scan QR pelanggan)', Number(h.status) === 1, `gas ${BigInt(h.gasUsed)}`);
const o = await pub.readContract({ ...fk, functionName: 'getOrder', args: [id] });
const dapat = (await saldoT(TOKO_A)) - saldoTokoAwal;
cek('order Finished', STATUS[o.status] === 'Finished', `kerja ${o.kerja} dtk`);
cek('toko A menerima payout', dapat > 0n, formatRupiah(dapat));
cek('NFT struk milik penonton', (await pub.readContract({ ...fk, functionName: 'ownerOf', args: [id] })) === penonton.address);
console.log(`      saldo akhir penonton ${formatRupiah(await saldoT(penonton.address))} (top-up − harga − fee + cashback)`);

const gagal = hasil.filter((x) => !x).length;
console.log(`\n${hasil.length - gagal}/${hasil.length} PASS`);
process.exit(gagal ? 1 : 0);
