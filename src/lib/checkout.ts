// FAKE checkout page for simulation mode: stands in for the IDRX payment page (paymentUrl).
// The "Pay" button calls POST /topup/:id/bayar, then polls the status until MINTED. No real money involved.
import type { TopUp } from './topup.ts';

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const rp = (n: number) => 'Rp' + n.toLocaleString('id-ID', { maximumFractionDigits: 2 });

export function halamanBayar(t: TopUp) {
  const tujuan = t.paymentMethod === 'va'
    ? `<div class="k">Virtual Account ${esc(t.channelId)}</div><div class="v mono">${esc(t.virtualAccountNo)}</div><div class="s">${esc(t.virtualAccountName)}</div>`
    : `<div class="k">QRIS</div><div class="qr mono">${esc(t.qrString)}</div>`;
  const biaya = t.fees.map((f) => `<tr><td>${esc(f.name)}</td><td>${rp(f.amount)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simulated checkout</title><style>
:root{--bg:#f6f3ec;--card:#fff;--ink:#1d1b16;--muted:#6b665b;--line:#e3ddd0;--accent:#1f6f4a;--warn:#9a4b00}
@media (prefers-color-scheme:dark){:root{--bg:#16150f;--card:#211f18;--ink:#f2efe6;--muted:#a59f90;--line:#38352b;--accent:#5fc28f;--warn:#f0a35a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,sans-serif;padding:24px 16px}
main{max-width:420px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px}
.badge{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.06em;color:var(--warn);border:1px solid currentColor;border-radius:99px;padding:2px 10px}
h1{font-size:20px;margin:12px 0 4px}.s,.k{color:var(--muted);font-size:13px}.v{font-size:22px;font-weight:700;margin:2px 0}
.mono{font-family:ui-monospace,monospace;word-break:break-all}.qr{border:1px dashed var(--line);padding:12px;margin-top:4px;font-size:12px}
table{width:100%;border-collapse:collapse;margin:16px 0}td{padding:6px 0;border-bottom:1px solid var(--line)}td:last-child{text-align:right}
tr.total td{font-weight:700;border-bottom:0}button{width:100%;padding:14px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-size:16px;font-weight:700;cursor:pointer}
button:disabled{opacity:.5;cursor:default}#st{margin-top:12px;font-size:14px;min-height:1.4em}
</style></head><body><main>
<span class="badge">SIMULATION · NOT A REAL PAYMENT</span>
<h1>Top-up ${rp(t.baseAmount)} tIDRX</h1>
<div class="s">Ref ${esc(t.reference)} · to <span class="mono">${esc(t.destinationWalletAddress)}</span></div>
<div style="margin-top:16px">${tujuan}</div>
<table><tr><td>Balance received</td><td>${rp(t.baseAmount)}</td></tr>${biaya}<tr class="total"><td>Total to pay</td><td>${rp(t.amount)}</td></tr></table>
<button id="b">Pay (simulated)</button><div id="st"></div>
<div class="s" style="margin-top:12px">Valid until ${esc(new Date(t.expiredDate).toLocaleString('en-GB'))}</div>
</main><script>
const id=${JSON.stringify(t.id)},b=document.getElementById('b'),st=document.getElementById('st');
const tampil=(t)=>{st.textContent=t.paymentStatus+' · '+t.userMintStatus+(t.txHash?' · tx '+t.txHash.slice(0,10)+'…':'');
  if(t.paymentStatus!=='WAITING_FOR_PAYMENT')b.disabled=true;if(t.userMintStatus==='MINTED')st.textContent='Balance received. Back to the game.';};
async function pantau(){for(let i=0;i<40;i++){const t=await (await fetch('/topup/'+id)).json();tampil(t);if(['MINTED','FAILED'].includes(t.userMintStatus)||t.paymentStatus==='EXPIRED')return;await new Promise(r=>setTimeout(r,500));}}
b.onclick=async()=>{b.disabled=true;st.textContent='Processing…';const r=await fetch('/topup/'+id+'/bayar',{method:'POST'});const j=await r.json();if(!r.ok){st.textContent='Failed: '+j.error;return;}tampil(j);pantau();};
pantau();
</script></body></html>`;
}
