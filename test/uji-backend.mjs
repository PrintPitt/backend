// End-to-end test of the backend service against anvil (run by test/uji-anvil.sh).
// Env: BASE (URL service), RPC_URL, ADMIN_TOKEN, ORIGIN_OK.
import { createPublicClient, createWalletClient, formatEther, http, keccak256, parseSignature } from 'viem';
import { anvil } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  domainPesanan, domainTidrx, fotokopiKilatAbi, NOL32, PERMIT_TYPES, PESANAN_TYPES, STATUS, tidrxAbi,
  pesanLokasiOrder, pesanLokasiToko, pesanUnduh,
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

// 1. health + invalid address
cek('GET /health', (await fetch(BASE + '/health')).status === 200);
{ const r = await json(await post('/faucet', { address: '0x123' })); cek('invalid address → 400 BAD_ADDRESS', r.status === 400 && r.body.error === 'BAD_ADDRESS'); }

// 2. burst of 50 concurrent requests, all new addresses
const addrs = Array.from({ length: 50 }, alamatBaru);
const t0 = Date.now();
const res = await Promise.all(addrs.map(async (a) => json(await post('/faucet', { address: a }))));
const ms = Date.now() - t0;
const ok202 = res.filter((r) => r.status === 202), hashes = new Set(ok202.map((r) => r.body.hash));
cek('burst 50 → all 202', ok202.length === 50, `${ok202.length}/50 in ${ms} ms`);
cek('50 unique hashes (no nonce collisions)', hashes.size === 50);
const receipts = await Promise.all([...hashes].map((h) => pub.waitForTransactionReceipt({ hash: h })));
cek('50 txs succeed onchain', receipts.every((r) => r.status === 'success'));
const nonces = new Set(await Promise.all([...hashes].map(async (h) => (await pub.getTransaction({ hash: h })).nonce)));
cek('50 distinct sequential nonces', nonces.size === 50 && Math.max(...nonces) - Math.min(...nonces) === 49);
const saldo = await Promise.all(addrs.map((a) => pub.getBalance({ address: a })));
cek('each address receives 0.05 MON', saldo.every((s) => formatEther(s) === '0.05'));

// 3. once per address
{ const r = await json(await post('/faucet', { address: addrs[0] })); cek('same address again → 409', r.status === 409 && r.body.error === 'ALREADY_FUNDED'); }
{ const a = alamatBaru(); const [r1, r2] = await Promise.all([post('/faucet', { address: a }), post('/faucet', { address: a })]);
  const st = [r1.status, r2.status].sort(); cek('2 concurrent requests, same address → one 202, one 409', st[0] === 202 && st[1] === 409); }
{ const r = await json(await post('/faucet', { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' })); cek('old address that already has a balance → 409', r.status === 409); }

// 4. CORS
{ const r = await fetch(BASE + '/faucet', { method: 'OPTIONS', headers: { Origin: ORIGIN_OK, 'Access-Control-Request-Method': 'POST' } });
  cek('CORS: registered origin allowed', r.status === 204 && r.headers.get('access-control-allow-origin') === ORIGIN_OK); }
{ const r = await fetch(BASE + '/faucet', { method: 'OPTIONS', headers: { Origin: 'https://jahat.example', 'Access-Control-Request-Method': 'POST' } });
  cek('CORS: foreign origin gets no header', !r.headers.get('access-control-allow-origin')); }

// 5. admin bot + keeper
{ const r = await post('/admin/bot', { on: true }); cek('admin without token → 401', r.status === 401); }
{ const r = await json(await post('/admin/bot', { on: true, intervalMs: 1000 }, { authorization: `Bearer ${ADMIN}` })); cek('admin with token → bot on', r.status === 200 && r.body.bot.on === true); }
await jeda(3500);
let s = (await json(await fetch(BASE + '/status'))).body;
cek('bot places orders', s.bot.orders >= 2, `${s.bot.orders} orders`);
await post('/admin/bot', { on: false }, { authorization: `Bearer ${ADMIN}` });
await jeda(1200);
const ordersBot = (await json(await fetch(BASE + '/status'))).body.bot.orders;
await rpc('evm_increaseTime', [46]); await rpc('evm_mine');
await jeda(4000 + ordersBot * 400);
s = (await json(await fetch(BASE + '/status'))).body;
cek('keeper expires all bot orders after the queue deadline', s.keeper.expired >= ordersBot, `${s.keeper.expired}/${ordersBot}`);
cek('status reports the faucet', s.faucet.funded >= 51 && s.faucet.queue === 0, `funded ${s.faucet.funded}, rejected ${s.faucet.ditolak}, balance ${s.faucet.balance}`);

// 6. Rupiah top-up (simulated IDRX) -> tIDRX
const cfg = (await json(await fetch(BASE + '/config'))).body;
cek('GET /config returns token, relayer, Rp200 service fee, 3% platform fee, Pro price', !!cfg.token && !!cfg.relayer && cfg.feeRelay === '20000' && cfg.platformFeeBps === 300 && cfg.hargaPro === '100000' && cfg.topupMode === 'simulasi', `fee ${cfg.feeRelay}, ${cfg.platformFeeBps} bps`);
const token = { address: cfg.token, abi: tidrxAbi }, fk = { address: cfg.contract, abi: fotokopiKilatAbi };
const saldoT = (a) => pub.readContract({ ...token, functionName: 'balanceOf', args: [a] });
const penonton = privateKeyToAccount(generatePrivateKey());
{ const r = await json(await post('/topup', { toBeMinted: '10000', destinationWalletAddress: penonton.address })); cek('top-up below Rp20,000 → 400', r.status === 400 && r.body.error === 'AMOUNT_TOO_LOW'); }
{ const r = await json(await post('/topup', { toBeMinted: '50000', destinationWalletAddress: '0xabc' })); cek('top-up with bad address → 400', r.status === 400 && r.body.error === 'BAD_ADDRESS'); }
const tu = await json(await post('/topup', { toBeMinted: '50000', destinationWalletAddress: penonton.address, paymentMethod: 'va', channelId: 'BRI' }));
cek('top-up VA BRI → 201 + VA + total incl. fee', tu.status === 201 && tu.body.paymentStatus === 'WAITING_FOR_PAYMENT' && tu.body.amount === 53000 && /^\d{15}$/.test(tu.body.virtualAccountNo ?? ''), `total Rp${tu.body.amount}`);
{ const r = await fetch(tu.body.paymentUrl); cek('simulated checkout page served', r.status === 200 && (await r.text()).includes('SIMULATION')); }
{ const r = await json(await post(`/topup/${tu.body.id}/bayar`, {})); cek('pay → PAID + PROCESSING', r.status === 200 && r.body.paymentStatus === 'PAID', r.body.userMintStatus); }
let st;
for (let i = 0; i < 30; i++) { st = (await json(await fetch(`${BASE}/topup/${tu.body.id}`))).body; if (st.userMintStatus === 'MINTED') break; await jeda(200); }
cek('status becomes MINTED + txHash', st.userMintStatus === 'MINTED' && !!st.txHash);
cek('user balance = Rp50,000 tIDRX', (await saldoT(penonton.address)) === 5_000_000n);
await post(`/topup/${tu.body.id}/bayar`, {}); await jeda(500);
cek('paying twice does not mint twice', (await saldoT(penonton.address)) === 5_000_000n);
{ const r = await json(await post('/topup', { toBeMinted: '100000', destinationWalletAddress: penonton.address, paymentMethod: 'qris' }));
  cek('top-up QRIS → 0.7% fee', r.status === 201 && r.body.fees[0].amount === 700 && !!r.body.qrString); }

// 6b. encrypted documents (BLZ-21): upload a 3-page PDF
const buatPdf = (n) => {
  const kids = Array.from({ length: n }, (_, i) => `${3 + i} 0 R`).join(' ');
  const hal = Array.from({ length: n }, (_, i) => `${3 + i} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n`).join('');
  return Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[${kids}]/Count ${n}>>endobj\n${hal}trailer<</Root 1 0 R>>\n%%EOF\n`, 'latin1');
};
const pdf = buatPdf(3);
const upR = await fetch(BASE + '/dokumen', { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-nama-file': 'skripsi bab 1.pdf' }, body: pdf });
const upload = await upR.json();
cek('upload PDF → 201, bytes32 hash, 3 pages detected', upR.status === 201 && /^0x[0-9a-f]{64}$/.test(upload.dokumen) && upload.halaman === 3, `${upload.halaman} pages`);
{ const r = await fetch(BASE + '/dokumen', { method: 'POST', body: Buffer.from('bukan pdf') }); cek('non-PDF/PNG/JPEG file → 415', r.status === 415); }
{ const r = await json(await fetch(`${BASE}/dokumen/${upload.dokumen}`)); cek('document info without file name', r.status === 200 && r.body.halaman === 3 && !('nama' in r.body)); }

// 7. order without MON via the relayer (Pesanan EIP-712 + tIDRX permit): real document order + handover code
const { timestamp: kini } = await pub.getBlock();
const [harga] = await pub.readContract({ ...fk, functionName: 'hargaUntuk', args: [5, upload.halaman] });
const deadline = kini + 3600n, fee = BigInt(cfg.feeRelay), chainId = await pub.getChainId();
const rahasia = generatePrivateKey(), dokumen = upload.dokumen;
const sigPermit = parseSignature(await penonton.signTypedData({
  domain: domainTidrx(chainId, cfg.token), types: PERMIT_TYPES, primaryType: 'Permit',
  message: { owner: penonton.address, spender: cfg.contract, value: 10_000_000n, nonce: await pub.readContract({ ...token, functionName: 'nonces', args: [penonton.address] }), deadline },
}));
const pesanan = { pelanggan: penonton.address, jenis: 5, teks: 'Skripsi bab 1-3', halaman: upload.halaman, dokumen, kodeHash: keccak256(rahasia), deadline, maxFee: fee };
const sig = await penonton.signTypedData({
  domain: domainPesanan(chainId, cfg.contract), types: PESANAN_TYPES, primaryType: 'Pesanan',
  message: { ...pesanan, nonce: await pub.readContract({ ...fk, functionName: 'nonces', args: [penonton.address] }) },
});
const bodyRelay = {
  pesanan: { ...pesanan, deadline: String(deadline), maxFee: String(fee) }, sig,
  izin: { value: '10000000', deadline: String(deadline), v: String(sigPermit.v), r: sigPermit.r, s: sigPermit.s },
};
const saldoRelayer = await saldoT(cfg.relayer);
{ const r = await json(await post('/relay/order', { ...bodyRelay, pesanan: { ...bodyRelay.pesanan, teks: 'KTP diubah relayer' } }));
  cek('tampered text → 400 BadSignature (no tx)', r.status === 400 && r.body.error === 'BadSignature', r.body.error); }
const rr = await json(await post('/relay/order', bodyRelay));
cek('relay → 202 + hash', rr.status === 202 && !!rr.body.hash, rr.body.error ?? '');
const rc = rr.body.hash && await pub.waitForTransactionReceipt({ hash: rr.body.hash });
cek('createOrderFor succeeds onchain', rc?.status === 'success');
const idBaru = (await pub.readContract({ ...fk, functionName: 'nextId' })) - 1n;
const ordBaru = await pub.readContract({ ...fk, functionName: 'getOrder', args: [idBaru] });
cek('order owned by user, 3 pages, per-page price, document hash', ordBaru.pelanggan === penonton.address && ordBaru.harga === harga && ordBaru.halaman === 3 && ordBaru.dokumen === dokumen, `price ${harga}`);
cek('user pays price + fee, MON stays 0', (await saldoT(penonton.address)) === 5_000_000n - harga - fee && (await pub.getBalance({ address: penonton.address })) === 0n);
cek('relayer receives tIDRX fee', (await saldoT(cfg.relayer)) - saldoRelayer === fee);
await jeda(400);
{ const r = await json(await post('/relay/order', bodyRelay)); cek('replaying the same signature → 400 BadSignature', r.status === 400 && r.body.error === 'BadSignature', r.body.error); }

// 7a. shop radius (BLZ-22): shop A nearby, shop B ±6 km; order near shop A (anvil test keys #1, #2)
const tokoA = createWalletClient({ chain: anvil, account: privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'), transport: http(RPC) });
const tokoB = createWalletClient({ chain: anvil, account: privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'), transport: http(RPC) });
const kirimToko = async (w, functionName, args) => (await pub.waitForTransactionReceipt({ hash: await w.writeContract({ ...fk, functionName, args }) })).status;
const statusOrder = async (id) => STATUS[(await pub.readContract({ ...fk, functionName: 'getOrder', args: [id] })).status];
const setLokasiToko = async (w, lat, lng, waktu = Date.now()) => json(await post('/toko/lokasi', { toko: w.account.address, lat, lng, waktu, sig: await w.account.signMessage({ message: pesanLokasiToko(w.account.address, lat, lng, waktu) }) }));
{ const r = await setLokasiToko(tokoA, -7.783, 110.367); cek('shop A sets location (wallet signature, registered shop)', r.status === 200 && r.body.radiusKm === 1.5); }
await setLokasiToko(tokoB, -7.80, 110.38);   // ±2 km from the order: outside 1.5 km, inside the 3 km Pro radius
{ const waktu = Date.now(); const r = await json(await post('/toko/lokasi', { toko: tokoA.account.address, lat: -7.783, lng: 110.367, waktu, sig: await tokoB.account.signMessage({ message: pesanLokasiToko(tokoA.account.address, -7.783, 110.367, waktu) }) }));
  cek('shop location signed by another wallet → 401', r.status === 401); }
{ const waktu = Date.now(); const r = await json(await post('/toko/lokasi', { toko: penonton.address, lat: 1, lng: 1, waktu, sig: await penonton.signMessage({ message: pesanLokasiToko(penonton.address, 1, 1, waktu) }) }));
  cek('not a registered shop → 403 NOT_SHOP', r.status === 403 && r.body.error === 'NOT_SHOP'); }
{ const waktu = Date.now(); const r = await json(await post(`/order/${idBaru}/lokasi`, { lat: -7.785, lng: 110.368, waktu, sig: await penonton.signMessage({ message: pesanLokasiOrder(idBaru, -7.785, 110.368, waktu) }) }));
  cek('customer sets order location', r.status === 200, r.body.error ?? ''); }
let feedA, feedB;
for (let i = 0; i < 30; i++) {
  feedA = (await json(await fetch(`${BASE}/toko/${tokoA.account.address}/feed`))).body;
  if (feedA.order?.some((o) => o.id === String(idBaru))) break; await jeda(250);
}
feedB = (await json(await fetch(`${BASE}/toko/${tokoB.account.address}/feed?semua=1`))).body;
const diFeedA = feedA.order?.find((o) => o.id === String(idBaru));
cek('shop A feed (≤1.5 km) has the order + distance + page count', !!diFeedA && diFeedA.jarakKm < 1.5 && diFeedA.halaman === 3 && diFeedA.adaDokumen, diFeedA ? `${diFeedA.jarakKm} km` : 'missing');
cek('shop B feed (±2 km, not Pro yet) lacks the order', !feedB.order?.some((o) => o.id === String(idBaru)) && feedB.radiusKm === 1.5);

// 7b. shop A claims → downloads document → works → Siap → QR handover
await kirimToko(tokoA, 'claim', [idBaru]);
const unduh = async (akun, waktu = Date.now()) => fetch(`${BASE}/dokumen/${dokumen}/unduh`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ orderId: String(idBaru), alamat: akun.address, waktu, sig: await akun.signMessage({ message: pesanUnduh(dokumen, idBaru, waktu) }) }) });
{ const r = await unduh(tokoA.account); const isi = Buffer.from(await r.arrayBuffer());
  cek('winning shop downloads → identical PDF content', r.status === 200 && isi.equals(pdf) && r.headers.get('content-type') === 'application/pdf'); }
{ const r = await unduh(tokoB.account); cek('other shop downloads → 403', r.status === 403); }
{ const r = await unduh(penonton); cek('owning customer downloads → 200', r.status === 200); }
{ const r = await unduh(tokoA.account, Date.now() - 10 * 60_000); cek('signature older than 5 minutes → 401', r.status === 401); }
await kirimToko(tokoA, 'completeStep', [idBaru, 2]);
cek('last step → Siap (awaiting handover)', (await statusOrder(idBaru)) === 'Siap');
{ let err = ''; try { await pub.simulateContract({ ...fk, functionName: 'serahkan', args: [idBaru, NOL32], account: tokoA.account }); } catch (e) { err = e.message; }
  cek('serahkan with a wrong code is rejected (BadCode)', /BadCode/.test(err)); }
const saldoTokoA = await saldoT(tokoA.account.address), saldoTreasury = await saldoT(cfg.treasury);
await kirimToko(tokoA, 'serahkan', [idBaru, rahasia]);
cek('serahkan with the right QR → Finished, shop paid, NFT to user',
  (await statusOrder(idBaru)) === 'Finished' && (await saldoT(tokoA.account.address)) > saldoTokoA && (await pub.readContract({ ...fk, functionName: 'ownerOf', args: [idBaru] })) === penonton.address);
{ const masuk = (await saldoT(cfg.treasury)) - saldoTreasury, toko = (await saldoT(tokoA.account.address)) - saldoTokoA;
  cek('3% platform fee to treasury, shop gets net payout', masuk > 0n && masuk === (masuk + toko) * 300n / 10_000n, `treasury +${masuk}, shop +${toko}`); }
{ let st = 200; for (let i = 0; i < 40 && st === 200; i++) { await jeda(250); st = (await fetch(`${BASE}/dokumen/${dokumen}`)).status; }
  cek('document auto-deleted after order Finished', st === 404); }

// 7c. second order not picked up → keeper closes it after batasJemput
const rahasia2 = generatePrivateKey();
const pesanan2 = { ...pesanan, teks: 'Makalah tidak dijemput', kodeHash: keccak256(rahasia2) };
const sig2 = await penonton.signTypedData({ domain: domainPesanan(chainId, cfg.contract), types: PESANAN_TYPES, primaryType: 'Pesanan', message: { ...pesanan2, nonce: 1n } });
const rr2 = await json(await post('/relay/order', { pesanan: { ...pesanan2, deadline: String(deadline), maxFee: String(fee) }, sig: sig2, izin: null }));
cek('relay second order (allowance from first permit) → 202', rr2.status === 202, rr2.body.error ?? '');
await pub.waitForTransactionReceipt({ hash: rr2.body.hash });
const id2 = (await pub.readContract({ ...fk, functionName: 'nextId' })) - 1n;
await kirimToko(tokoB, 'claim', [id2]);
await kirimToko(tokoB, 'completeStep', [id2, 2]);
const jemput = await pub.readContract({ ...fk, functionName: 'batasJemput' });
await rpc('evm_increaseTime', [Number(jemput) + 1]); await rpc('evm_mine');
let st2 = 'Siap';
for (let i = 0; i < 40 && st2 === 'Siap'; i++) { await jeda(250); st2 = await statusOrder(id2); }
cek('keeper closes an unpicked Siap order → Finished', st2 === 'Finished', st2);

// 7c2. third order disputed, operator silent → keeper closes the dispute (50/50) after the dispute deadline
{ const r = await json(await post('/faucet', { address: penonton.address })); await pub.waitForTransactionReceipt({ hash: r.body.hash }); }
const penontonW = createWalletClient({ chain: anvil, account: penonton, transport: http(RPC) });
const rahasia3 = generatePrivateKey();
const pesanan3 = { ...pesanan, teks: 'Laporan dikomplain', kodeHash: keccak256(rahasia3) };
const sig3 = await penonton.signTypedData({ domain: domainPesanan(chainId, cfg.contract), types: PESANAN_TYPES, primaryType: 'Pesanan', message: { ...pesanan3, nonce: 2n } });
const rr3 = await json(await post('/relay/order', { pesanan: { ...pesanan3, deadline: String(deadline), maxFee: String(fee) }, sig: sig3, izin: null }));
await pub.waitForTransactionReceipt({ hash: rr3.body.hash });
const id3 = (await pub.readContract({ ...fk, functionName: 'nextId' })) - 1n;
await kirimToko(tokoA, 'claim', [id3]);
await kirimToko(tokoA, 'completeStep', [id3, 2]);
await pub.waitForTransactionReceipt({ hash: await penontonW.writeContract({ ...fk, functionName: 'komplain', args: [id3] }) });
cek('customer complains → Sengketa', (await statusOrder(id3)) === 'Sengketa');
const batasS = await pub.readContract({ ...fk, functionName: 'batasSengketa' });
await rpc('evm_increaseTime', [Number(jemput) + Number(batasS) + 1]); await rpc('evm_mine');
let st3 = 'Sengketa';
for (let i = 0; i < 40 && st3 === 'Sengketa'; i++) { await jeda(250); st3 = await statusOrder(id3); }
cek('keeper closes stale dispute → Diputuskan (50/50)', st3 === 'Diputuskan', st3);

// 7d. Toko Pro: shop B subscribes from its payout balance → 3 km feed radius
await pub.waitForTransactionReceipt({ hash: await tokoB.writeContract({ ...token, functionName: 'approve', args: [cfg.contract, 10n ** 18n] }) });
await kirimToko(tokoB, 'langgananPro', [1]);
cek('shop B subscribes to Pro for 1 month', await pub.readContract({ ...fk, functionName: 'isPro', args: [tokoB.account.address] }));
{ const r = await setLokasiToko(tokoB, -7.80, 110.38); const f = (await json(await fetch(`${BASE}/toko/${tokoB.account.address}/feed`))).body;
  cek('Toko Pro feed uses a 3 km radius', r.body.radiusKm === 3 && f.radiusKm === 3 && f.pro === true, `${f.radiusKm} km`); }

// 8. rate limit (RATE_LIMIT_PER_MIN=100 in the runner): 50 more requests from the same IP
const rl = await Promise.all(Array.from({ length: 50 }, async () => (await post('/faucet', { address: 'x' })).status));
cek('rate limit → some 429', rl.includes(429), `${rl.filter((x) => x === 429).length} × 429`);

const gagal = hasil.filter((h) => !h.ok).length;
console.log(`\n${hasil.length - gagal}/${hasil.length} PASS`);
process.exit(gagal ? 1 : 0);
