// Uji end-to-end service backend terhadap anvil (dijalankan oleh test/uji-anvil.sh).
// Env: BASE (URL service), RPC_URL, ADMIN_TOKEN, ORIGIN_OK.
import { createPublicClient, formatEther, http, parseSignature } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  domainPesanan, domainTidrx, fotokopiKilatAbi, PERMIT_TYPES, PESANAN_TYPES, tidrxAbi,
} from '@printpitt/shared';

const BASE = process.env.BASE, RPC = process.env.RPC_URL, ADMIN = process.env.ADMIN_TOKEN, ORIGIN_OK = process.env.ORIGIN_OK;
const pub = createPublicClient({ transport: http(RPC), pollingInterval: 100 });
const hasil = [];
const cek = (nama, ok, detail = '') => { hasil.push({ nama, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nama}${detail ? ' · ' + detail : ''}`); };
const post = (path, body, headers = {}) => fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const json = async (r) => ({ status: r.status, body: await r.json() });
const alamatBaru = () => privateKeyToAccount(generatePrivateKey()).address;
const jeda = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = (method, params = []) => fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });

// 1. health + alamat tidak valid
cek('GET /health', (await fetch(BASE + '/health')).status === 200);
{ const r = await json(await post('/faucet', { address: '0x123' })); cek('alamat tidak valid → 400 BAD_ADDRESS', r.status === 400 && r.body.error === 'BAD_ADDRESS'); }

// 2. burst 50 permintaan bersamaan, semua alamat baru
const addrs = Array.from({ length: 50 }, alamatBaru);
const t0 = Date.now();
const res = await Promise.all(addrs.map(async (a) => json(await post('/faucet', { address: a }))));
const ms = Date.now() - t0;
const ok202 = res.filter((r) => r.status === 202), hashes = new Set(ok202.map((r) => r.body.hash));
cek('burst 50 → semua 202', ok202.length === 50, `${ok202.length}/50 dalam ${ms} ms`);
cek('50 hash unik (nonce tidak bentrok)', hashes.size === 50);
const receipts = await Promise.all([...hashes].map((h) => pub.waitForTransactionReceipt({ hash: h })));
cek('50 tx sukses on-chain', receipts.every((r) => r.status === 'success'));
const nonces = new Set(await Promise.all([...hashes].map(async (h) => (await pub.getTransaction({ hash: h })).nonce)));
cek('50 nonce berbeda berurutan', nonces.size === 50 && Math.max(...nonces) - Math.min(...nonces) === 49);
const saldo = await Promise.all(addrs.map((a) => pub.getBalance({ address: a })));
cek('tiap alamat menerima 0.05 MON', saldo.every((s) => formatEther(s) === '0.05'));

// 3. sekali per alamat
{ const r = await json(await post('/faucet', { address: addrs[0] })); cek('minta ulang alamat yang sama → 409', r.status === 409 && r.body.error === 'ALREADY_FUNDED'); }
{ const a = alamatBaru(); const [r1, r2] = await Promise.all([post('/faucet', { address: a }), post('/faucet', { address: a })]);
  const st = [r1.status, r2.status].sort(); cek('2 permintaan bersamaan alamat sama → satu 202, satu 409', st[0] === 202 && st[1] === 409); }
{ const r = await json(await post('/faucet', { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' })); cek('alamat lama yang sudah punya saldo → 409', r.status === 409); }

// 4. CORS
{ const r = await fetch(BASE + '/faucet', { method: 'OPTIONS', headers: { Origin: ORIGIN_OK, 'Access-Control-Request-Method': 'POST' } });
  cek('CORS origin terdaftar diizinkan', r.status === 204 && r.headers.get('access-control-allow-origin') === ORIGIN_OK); }
{ const r = await fetch(BASE + '/faucet', { method: 'OPTIONS', headers: { Origin: 'https://jahat.example', 'Access-Control-Request-Method': 'POST' } });
  cek('CORS origin asing tidak diberi header', !r.headers.get('access-control-allow-origin')); }

// 5. admin bot + keeper
{ const r = await post('/admin/bot', { on: true }); cek('admin tanpa token → 401', r.status === 401); }
{ const r = await json(await post('/admin/bot', { on: true, intervalMs: 1000 }, { authorization: `Bearer ${ADMIN}` })); cek('admin dengan token → bot on', r.status === 200 && r.body.bot.on === true); }
await jeda(3500);
let s = (await json(await fetch(BASE + '/status'))).body;
cek('bot membuat order', s.bot.orders >= 2, `${s.bot.orders} order`);
await post('/admin/bot', { on: false }, { authorization: `Bearer ${ADMIN}` });
await jeda(1200);
const ordersBot = (await json(await fetch(BASE + '/status'))).body.bot.orders;
await rpc('evm_increaseTime', [46]); await rpc('evm_mine');
await jeda(4000 + ordersBot * 400);
s = (await json(await fetch(BASE + '/status'))).body;
cek('keeper men-expire semua order bot setelah lewat batas antre', s.keeper.expired >= ordersBot, `${s.keeper.expired}/${ordersBot}`);
cek('status melaporkan faucet', s.faucet.funded >= 51 && s.faucet.queue === 0, `funded ${s.faucet.funded}, ditolak ${s.faucet.ditolak}, saldo ${s.faucet.balance}`);

// 6. top-up Rupiah (simulasi IDRX) -> tIDRX
const cfg = (await json(await fetch(BASE + '/config'))).body;
cek('GET /config memberi token, relayer, fee', !!cfg.token && !!cfg.relayer && cfg.feeRelay === '10000' && cfg.topupMode === 'simulasi', `fee ${cfg.feeRelay}`);
const token = { address: cfg.token, abi: tidrxAbi }, fk = { address: cfg.contract, abi: fotokopiKilatAbi };
const saldoT = (a) => pub.readContract({ ...token, functionName: 'balanceOf', args: [a] });
const penonton = privateKeyToAccount(generatePrivateKey());
{ const r = await json(await post('/topup', { toBeMinted: '10000', destinationWalletAddress: penonton.address })); cek('top-up di bawah Rp20.000 → 400', r.status === 400 && r.body.error === 'AMOUNT_TOO_LOW'); }
{ const r = await json(await post('/topup', { toBeMinted: '50000', destinationWalletAddress: '0xabc' })); cek('top-up alamat salah → 400', r.status === 400 && r.body.error === 'BAD_ADDRESS'); }
const tu = await json(await post('/topup', { toBeMinted: '50000', destinationWalletAddress: penonton.address, paymentMethod: 'va', channelId: 'BRI' }));
cek('top-up VA BRI → 201 + VA + total termasuk biaya', tu.status === 201 && tu.body.paymentStatus === 'WAITING_FOR_PAYMENT' && tu.body.amount === 53000 && /^\d{15}$/.test(tu.body.virtualAccountNo ?? ''), `total Rp${tu.body.amount}`);
{ const r = await fetch(tu.body.paymentUrl); cek('halaman checkout simulasi tersaji', r.status === 200 && (await r.text()).includes('SIMULASI')); }
{ const r = await json(await post(`/topup/${tu.body.id}/bayar`, {})); cek('bayar → PAID + PROCESSING', r.status === 200 && r.body.paymentStatus === 'PAID', r.body.userMintStatus); }
let st;
for (let i = 0; i < 30; i++) { st = (await json(await fetch(`${BASE}/topup/${tu.body.id}`))).body; if (st.userMintStatus === 'MINTED') break; await jeda(200); }
cek('status jadi MINTED + txHash', st.userMintStatus === 'MINTED' && !!st.txHash);
cek('saldo penonton = Rp50.000 tIDRX', (await saldoT(penonton.address)) === 5_000_000n);
await post(`/topup/${tu.body.id}/bayar`, {}); await jeda(500);
cek('bayar dua kali tidak mencetak dua kali', (await saldoT(penonton.address)) === 5_000_000n);
{ const r = await json(await post('/topup', { toBeMinted: '100000', destinationWalletAddress: penonton.address, paymentMethod: 'qris' }));
  cek('top-up QRIS → biaya 0,7%', r.status === 201 && r.body.fees[0].amount === 700 && !!r.body.qrString); }

// 7. pesan tanpa MON lewat relayer (Pesanan EIP-712 + permit tIDRX)
const { timestamp: kini } = await pub.getBlock();
const deadline = kini + 600n, harga = 500_000n, fee = BigInt(cfg.feeRelay), chainId = await pub.getChainId();
const sigPermit = parseSignature(await penonton.signTypedData({
  domain: domainTidrx(chainId, cfg.token), types: PERMIT_TYPES, primaryType: 'Permit',
  message: { owner: penonton.address, spender: cfg.contract, value: harga + fee, nonce: await pub.readContract({ ...token, functionName: 'nonces', args: [penonton.address] }), deadline },
}));
const pesanan = { pelanggan: penonton.address, jenis: 1, teks: 'KTP penonton tanpa MON', deadline, maxFee: fee };
const sig = await penonton.signTypedData({
  domain: domainPesanan(chainId, cfg.contract), types: PESANAN_TYPES, primaryType: 'Pesanan',
  message: { ...pesanan, nonce: await pub.readContract({ ...fk, functionName: 'nonces', args: [penonton.address] }) },
});
const bodyRelay = {
  pesanan: { ...pesanan, deadline: String(deadline), maxFee: String(fee) }, sig,
  izin: { value: String(harga + fee), deadline: String(deadline), v: String(sigPermit.v), r: sigPermit.r, s: sigPermit.s },
};
const saldoRelayer = await saldoT(cfg.relayer);
{ const r = await json(await post('/relay/order', { ...bodyRelay, pesanan: { ...bodyRelay.pesanan, teks: 'KTP diubah relayer' } }));
  cek('teks diubah → 400 BadSignature (tanpa tx)', r.status === 400 && r.body.error === 'BadSignature', r.body.error); }
const rr = await json(await post('/relay/order', bodyRelay));
cek('relay → 202 + hash', rr.status === 202 && !!rr.body.hash, rr.body.error ?? '');
const rc = rr.body.hash && await pub.waitForTransactionReceipt({ hash: rr.body.hash });
cek('createOrderFor sukses on-chain', rc?.status === 'success');
const idBaru = (await pub.readContract({ ...fk, functionName: 'nextId' })) - 1n;
const ordBaru = await pub.readContract({ ...fk, functionName: 'getOrder', args: [idBaru] });
cek('order milik penonton, harga Rp5.000', ordBaru.pelanggan === penonton.address && ordBaru.harga === harga);
cek('penonton bayar harga + fee, MON tetap 0', (await saldoT(penonton.address)) === 5_000_000n - harga - fee && (await pub.getBalance({ address: penonton.address })) === 0n);
cek('relayer menerima fee tIDRX', (await saldoT(cfg.relayer)) - saldoRelayer === fee);
await jeda(400);
{ const r = await json(await post('/relay/order', bodyRelay)); cek('kirim ulang tanda tangan yang sama → 400 BadSignature', r.status === 400 && r.body.error === 'BadSignature', r.body.error); }

// 8. rate limit (RATE_LIMIT_PER_MIN=100 di runner): 50 permintaan lagi dari IP yang sama
const rl = await Promise.all(Array.from({ length: 50 }, async () => (await post('/faucet', { address: 'x' })).status));
cek('rate limit → sebagian 429', rl.includes(429), `${rl.filter((x) => x === 429).length} × 429`);

const gagal = hasil.filter((h) => !h.ok).length;
console.log(`\n${hasil.length - gagal}/${hasil.length} PASS`);
process.exit(gagal ? 1 : 0);
