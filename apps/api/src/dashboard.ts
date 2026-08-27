import type { PayboxContext } from './context.js';

/**
 * The dashboard (spec §21-§23, §49).
 *
 * Served as one self-contained document with no build step and no bundler.
 * That is a deliberate trade: `npm install -g paybox` has to work on a machine
 * with nothing but Node, and a zero-asset dashboard keeps that true. The page
 * talks to the same /api the CLI uses, so there is exactly one control plane.
 *
 * Priority is developer productivity over decoration (spec §49): dense tables,
 * every technical value visible, one click to any raw payload.
 */
export function renderDashboard(context: PayboxContext): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>paybox</title>
<style>
:root{
  color-scheme:light dark;
  --bg:#f7f8fa; --panel:#fff; --fg:#12141a; --muted:#666e7a; --line:#e2e5ea;
  --accent:#0b7285; --ok:#12805c; --warn:#a6690a; --err:#b42318; --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
}
@media (prefers-color-scheme:dark){
  :root{--bg:#0e1014; --panel:#161920; --fg:#e6e9ee; --muted:#98a1ad; --line:#252932;
        --accent:#38bdf8; --ok:#3ddc97; --warn:#fbbf24; --err:#f87171;}
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{display:flex;align-items:center;gap:14px;padding:12px 20px;border-bottom:1px solid var(--line);
       background:var(--panel);position:sticky;top:0;z-index:20;flex-wrap:wrap}
h1{font-size:15px;margin:0;letter-spacing:-.01em}
.badge{font-size:11px;padding:2px 7px;border-radius:99px;background:#fde68a;color:#5c4400;font-weight:700}
nav{display:flex;gap:2px;margin-left:auto;flex-wrap:wrap}
nav button{border:0;background:transparent;color:var(--muted);font:inherit;font-size:13px;
           padding:6px 11px;border-radius:7px;cursor:pointer}
nav button[aria-current=true]{background:var(--bg);color:var(--fg);font-weight:600}
main{padding:20px;max-width:1380px;margin:0 auto}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:20px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.stat .k{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.stat .v{font-size:24px;font-weight:700;letter-spacing:-.02em;margin-top:3px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:18px}
.panel>h2{margin:0;padding:11px 16px;font-size:12.5px;text-transform:uppercase;letter-spacing:.05em;
          color:var(--muted);border-bottom:1px solid var(--line)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 14px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em}
tbody tr{cursor:pointer}
tbody tr:hover{background:var(--bg)}
td.mono,code{font-family:var(--mono);font-size:12px}
.pill{font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;display:inline-block}
.s-successful,.s-succeeded,.s-success{background:rgba(18,128,92,.14);color:var(--ok)}
.s-failed,.s-exhausted,.s-cancelled,.s-expired{background:rgba(180,35,24,.14);color:var(--err)}
.s-pending,.s-processing,.s-created,.s-requires_action,.s-delivering,.s-authorized{background:rgba(166,105,10,.16);color:var(--warn)}
.s-refunded,.s-partially_refunded{background:rgba(11,114,133,.14);color:var(--accent)}
.controls{display:flex;gap:8px;flex-wrap:wrap;padding:12px 16px}
button.act{border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit;font-size:12.5px;
           padding:6px 11px;border-radius:7px;cursor:pointer}
button.act:hover{border-color:var(--accent);color:var(--accent)}
button.act.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
input,select{background:var(--bg);border:1px solid var(--line);color:var(--fg);border-radius:7px;
             padding:6px 9px;font:inherit;font-size:12.5px}
.timeline{list-style:none;margin:0;padding:12px 16px}
.timeline li{display:grid;grid-template-columns:74px 1fr;gap:12px;padding:5px 0;font-size:13px}
.timeline .t{font-family:var(--mono);font-size:11.5px;color:var(--muted)}
pre{margin:0;padding:14px 16px;overflow:auto;font-family:var(--mono);font-size:11.5px;
    background:var(--bg);border-top:1px solid var(--line);max-height:340px}
.drawer{position:fixed;inset:0 0 0 auto;width:min(720px,100%);background:var(--panel);
        border-left:1px solid var(--line);overflow-y:auto;z-index:40;box-shadow:-16px 0 40px rgba(0,0,0,.16)}
.drawer header{position:sticky;top:0}
.hide{display:none!important}
.muted{color:var(--muted)}
.feed{max-height:280px;overflow-y:auto}
.feed div{padding:5px 16px;border-bottom:1px solid var(--line);font-size:12.5px;display:flex;gap:10px}
.feed .t{font-family:var(--mono);color:var(--muted);font-size:11.5px}
.empty{padding:26px 16px;color:var(--muted);font-size:13px;text-align:center}
label.f{display:flex;align-items:center;gap:6px;font-size:12.5px}
</style></head><body>

<header>
  <h1>paybox</h1><span class="badge">EMULATOR</span>
  <span class="muted" id="clock" style="font-family:var(--mono);font-size:12px"></span>
  <nav id="nav"></nav>
</header>

<main>
  <section id="view-overview"></section>
  <section id="view-payments" class="hide"></section>
  <section id="view-webhooks" class="hide"></section>
  <section id="view-events" class="hide"></section>
  <section id="view-simulation" class="hide"></section>
</main>
<div id="drawer" class="drawer hide"></div>

<script>
const API = '/api';
const VIEWS = ['overview','payments','webhooks','events','simulation'];
let current = 'overview';

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pill = (s) => \`<span class="pill s-\${esc(s)}">\${esc(s)}</span>\`;
const time = (iso) => iso ? new Date(iso).toLocaleTimeString('en-GB',{hour12:false}) : '—';
const money = (a,c) => \`\${c} \${(a/100).toFixed(2)}\`;

async function api(path, options) {
  // Only declare a JSON content-type when there is actually a body: Fastify
  // rejects an empty body that claims to be JSON.
  const res = await fetch(API + path, {
    ...options,
    ...(options?.body
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }
      : {}),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(detail.message || 'Request failed');
  }
  return res.status === 204 ? null : res.json();
}

$('nav').innerHTML = VIEWS.map(v =>
  \`<button data-v="\${v}" aria-current="\${v===current}">\${v[0].toUpperCase()+v.slice(1)}</button>\`).join('');
$('nav').addEventListener('click', (e) => {
  const view = e.target.dataset?.v; if (!view) return;
  current = view;
  for (const v of VIEWS) $('view-'+v).classList.toggle('hide', v !== view);
  document.querySelectorAll('#nav button').forEach(b => b.setAttribute('aria-current', String(b.dataset.v===view)));
  render();
});

/* ------------------------------- views ------------------------------- */

async function renderOverview() {
  const o = await api('/overview');
  $('view-overview').innerHTML = \`
    <div class="grid">
      \${stat('Payments', o.payments.total)}
      \${stat('Successful', o.payments.successful)}
      \${stat('Pending', o.payments.pending)}
      \${stat('Failed', o.payments.failed)}
      \${stat('Refunded', o.payments.refunded)}
    </div>
    <div class="grid">
      \${stat('Webhooks delivered', o.webhooks.succeeded)}
      \${stat('Webhooks failed', o.webhooks.failed)}
      \${stat('Webhooks pending', o.webhooks.pending)}
    </div>
    <div class="panel"><h2>Live activity</h2>
      <div class="feed" id="feed">\${o.recentActivity.map(feedRow).join('') || '<div class="empty">Nothing yet. Create a payment to see it here.</div>'}</div>
    </div>\`;
}
const stat = (k,v) => \`<div class="stat"><div class="k">\${k}</div><div class="v">\${v}</div></div>\`;
const feedRow = (e) => \`<div><span class="t">\${time(e.createdAt)}</span>
  <span>\${esc(e.type)}</span><span class="muted" style="margin-left:auto;font-family:var(--mono)">\${esc(e.resourceId)}</span></div>\`;

async function renderPayments() {
  const { items } = await api('/payments?limit=100');
  $('view-payments').innerHTML = \`<div class="panel"><h2>Payments</h2>
    \${items.length ? \`<table><thead><tr>
      <th>Reference</th><th>Provider</th><th>Amount</th><th>Method</th><th>Status</th><th>Provider status</th><th>Created</th>
    </tr></thead><tbody>\${items.map(p => \`<tr data-id="\${p.id}">
      <td class="mono">\${esc(p.reference)}</td><td>\${esc(p.provider)}</td>
      <td>\${money(p.amount,p.currency)}</td><td>\${esc(p.paymentMethod ?? '—')}</td>
      <td>\${pill(p.status)}</td><td class="mono muted">\${esc(p.providerStatus)}</td>
      <td class="muted">\${time(p.createdAt)}</td></tr>\`).join('')}</tbody></table>\`
      : '<div class="empty">No payments yet.</div>'}</div>\`;
  $('view-payments').querySelectorAll('tr[data-id]').forEach(tr =>
    tr.addEventListener('click', () => openPayment(tr.dataset.id)));
}

async function openPayment(id) {
  const d = await api('/payments/' + id);
  const p = d.payment;
  const act = (label, path, cls='') =>
    \`<button class="act \${cls}" data-a="\${path}" data-id="\${p.id}">\${label}</button>\`;
  $('drawer').innerHTML = \`
    <header><h1>\${esc(p.reference)}</h1><span class="badge">\${esc(p.provider)}</span>
      <button class="act" id="close" style="margin-left:auto">Close</button></header>
    <div class="panel" style="margin:16px">
      <h2>\${money(p.amount,p.currency)} · \${pill(p.status)}</h2>
      <div class="controls">
        \${act('Mark successful','simulate:success','primary')}
        \${act('Decline','simulate:declined')}
        \${act('Insufficient funds','simulate:insufficient_funds')}
        \${act('Require 3DS','simulate:authentication_required')}
        \${act('Approve prompt','authenticate:true')}
        \${act('Reject prompt','authenticate:false')}
        \${act('Cancel','cancel')} \${act('Expire','expire')}
        \${act('Refund in full','refund')}
      </div>
    </div>
    <div class="panel" style="margin:16px"><h2>Timeline</h2>
      <ul class="timeline">\${d.timeline.map(e => \`<li><span class="t">\${time(e.createdAt)}</span>
        <span>\${esc(e.type)}\${e.previousStatus ? \` <span class="muted">(\${esc(e.previousStatus)} → \${esc(e.currentStatus)})</span>\`:''}</span></li>\`).join('')}</ul>
    </div>
    \${d.webhookDeliveries.length ? \`<div class="panel" style="margin:16px"><h2>Webhook deliveries</h2>
      <table><thead><tr><th>Event</th><th>Status</th><th>HTTP</th><th>Attempts</th><th>Duration</th><th></th></tr></thead>
      <tbody>\${d.webhookDeliveries.map(w => \`<tr>
        <td class="mono">\${esc(w.eventType)}</td><td>\${pill(w.status)}</td>
        <td class="mono">\${w.responseStatus ?? '—'}</td><td>\${w.attempt}/\${w.maxAttempts}</td>
        <td class="muted">\${w.durationMs ?? '—'}ms</td>
        <td><button class="act" data-replay="\${w.id}">Replay</button></td></tr>\`).join('')}</tbody></table></div>\`:''}
    \${d.refunds.length ? \`<div class="panel" style="margin:16px"><h2>Refunds</h2><table><tbody>
      \${d.refunds.map(r => \`<tr><td class="mono">\${esc(r.id)}</td><td>\${money(r.amount,r.currency)}</td><td>\${pill(r.status)}</td></tr>\`).join('')}
      </tbody></table></div>\`:''}
    <div class="panel" style="margin:16px"><h2>Raw payment</h2><pre>\${esc(JSON.stringify(p,null,2))}</pre></div>\`;
  $('drawer').classList.remove('hide');
  $('close').onclick = () => $('drawer').classList.add('hide');
  $('drawer').querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
    const [action, arg] = b.dataset.a.split(':');
    try {
      if (action === 'simulate') await api(\`/payments/\${b.dataset.id}/simulate\`, {method:'POST', body:{outcome:arg}});
      else if (action === 'authenticate') await api(\`/payments/\${b.dataset.id}/authenticate\`, {method:'POST', body:{approved:arg==='true'}});
      else await api(\`/payments/\${b.dataset.id}/\${action}\`, {method:'POST', body:{}});
      openPayment(b.dataset.id);
    } catch (e) { alert(e.message); }
  });
  $('drawer').querySelectorAll('[data-replay]').forEach(b => b.onclick = async () => {
    await api(\`/webhooks/deliveries/\${b.dataset.replay}/replay\`, {method:'POST'});
    setTimeout(() => openPayment(p.id), 400);
  });
}

async function renderWebhooks() {
  const [{ endpoints }, deliveries, chaos] = await Promise.all([
    api('/webhooks/endpoints'), api('/webhooks/deliveries?limit=100'), api('/webhooks/chaos')]);
  $('view-webhooks').innerHTML = \`
    <div class="panel"><h2>Endpoints</h2>
      <div class="controls">
        <input id="wh-url" placeholder="http://localhost:3000/webhooks/paystack" style="flex:1;min-width:280px">
        <button class="act primary" id="wh-add">Register endpoint</button>
      </div>
      \${endpoints.length ? \`<table><thead><tr><th>URL</th><th>Provider</th><th>Secret</th><th></th></tr></thead><tbody>
        \${endpoints.map(e => \`<tr><td class="mono">\${esc(e.url)}</td><td>\${esc(e.provider)}</td>
        <td class="mono muted">\${esc(e.secret.slice(0,22))}…</td>
        <td><button class="act" data-del="\${e.id}">Remove</button></td></tr>\`).join('')}</tbody></table>\`
        : '<div class="empty">No endpoints. Register one above and every matching event will be delivered to it.</div>'}
    </div>
    <div class="panel"><h2>Failure simulation</h2><div class="controls">
      <label class="f">Force outcome
        <select id="chaos-outcome">\${['','http_500','http_400','http_429','timeout','connection_refused','malformed_response']
          .map(o => \`<option value="\${o}" \${chaos.forceOutcome===o?'selected':''}>\${o||'none'}</option>\`).join('')}</select></label>
      <label class="f">Failure rate <input id="chaos-rate" type="number" min="0" max="1" step="0.1" value="\${chaos.failureRate??0}" style="width:80px"></label>
      <label class="f"><input id="chaos-dup" type="checkbox" \${chaos.duplicate?'checked':''}> Duplicate every delivery</label>
      <label class="f"><input id="chaos-order" type="checkbox" \${chaos.outOfOrder?'checked':''}> Deliver out of order</label>
      <button class="act primary" id="chaos-save">Apply</button>
    </div></div>
    <div class="panel"><h2>Deliveries</h2>
      \${deliveries.items.length ? \`<table><thead><tr><th>Event</th><th>URL</th><th>Status</th><th>HTTP</th>
        <th>Attempts</th><th>Duration</th><th>Next retry</th><th></th></tr></thead><tbody>
        \${deliveries.items.map(w => \`<tr><td class="mono">\${esc(w.eventType)}</td>
          <td class="mono muted">\${esc(w.url)}</td><td>\${pill(w.status)}</td>
          <td class="mono">\${w.responseStatus ?? '—'}</td><td>\${w.attempt}/\${w.maxAttempts}</td>
          <td class="muted">\${w.durationMs ?? '—'}ms</td><td class="muted">\${time(w.nextRetryAt)}</td>
          <td><button class="act" data-retry="\${w.id}">Retry</button>
              <button class="act" data-replay="\${w.id}">Replay</button></td></tr>\`).join('')}</tbody></table>\`
        : '<div class="empty">No deliveries yet.</div>'}
    </div>\`;
  $('wh-add').onclick = async () => {
    const url = $('wh-url').value.trim(); if (!url) return;
    await api('/webhooks/endpoints', {method:'POST', body:{url}}); render();
  };
  $('chaos-save').onclick = async () => {
    await api('/webhooks/chaos', {method:'POST', body:{
      forceOutcome: $('chaos-outcome').value || null,
      failureRate: Number($('chaos-rate').value),
      duplicate: $('chaos-dup').checked,
      outOfOrder: $('chaos-order').checked }});
    render();
  };
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    await api('/webhooks/endpoints/'+b.dataset.del, {method:'DELETE'}); render(); });
  document.querySelectorAll('[data-retry]').forEach(b => b.onclick = async () => {
    await api(\`/webhooks/deliveries/\${b.dataset.retry}/retry\`, {method:'POST'}); render(); });
  document.querySelectorAll('#view-webhooks [data-replay]').forEach(b => b.onclick = async () => {
    await api(\`/webhooks/deliveries/\${b.dataset.replay}/replay\`, {method:'POST'}); setTimeout(render, 400); });
}

async function renderEvents() {
  const { items } = await api('/events?limit=150');
  $('view-events').innerHTML = \`<div class="panel"><h2>Event log</h2>
    \${items.length ? \`<table><thead><tr><th>Time</th><th>Type</th><th>Resource</th><th>Transition</th><th></th></tr></thead><tbody>
      \${items.map(e => \`<tr><td class="muted mono">\${time(e.createdAt)}</td><td>\${esc(e.type)}</td>
        <td class="mono muted">\${esc(e.resourceId)}</td>
        <td class="muted">\${e.previousStatus ? esc(e.previousStatus)+' → '+esc(e.currentStatus) : '—'}</td>
        <td><button class="act" data-ev="\${e.id}">Replay webhook</button></td></tr>\`).join('')}</tbody></table>\`
      : '<div class="empty">No events yet.</div>'}</div>\`;
  document.querySelectorAll('[data-ev]').forEach(b => b.onclick = async () => {
    const r = await api(\`/events/\${b.dataset.ev}/replay\`, {method:'POST'});
    alert(r.deliveries.length ? \`Queued \${r.deliveries.length} delivery/deliveries.\`
      : 'No endpoint is registered for this event type.');
  });
}

async function renderSimulation() {
  const [clock, net, { scenarios }, { items }] = await Promise.all([
    api('/time'), api('/network'), api('/scenarios'), api('/payments?limit=50')]);
  $('view-simulation').innerHTML = \`
    <div class="panel"><h2>Time control</h2><div class="controls">
      <span class="muted mono">\${new Date(clock.now).toISOString()} · \${clock.mode}</span>
      <button class="act" data-t="freeze">Freeze</button>
      <button class="act" data-t="unfreeze">Unfreeze</button>
      <input id="adv" value="30s" style="width:80px">
      <button class="act primary" data-t="advance">Advance</button>
    </div>
    <div class="empty" style="text-align:left;padding-top:0">Advancing runs every job that comes due
      — webhook retries, payment expiries, scenario steps — before it returns.</div></div>

    <div class="panel"><h2>Network simulation</h2><div class="controls">
      <label class="f">Latency (ms) <input id="net-lat" type="number" value="\${net.latencyMs}" style="width:90px"></label>
      <label class="f">Failure rate <input id="net-rate" type="number" min="0" max="1" step="0.1" value="\${net.failureRate}" style="width:80px"></label>
      <button class="act primary" id="net-save">Apply</button>
      <button class="act" id="net-reset">Reset</button>
    </div>
    <div class="empty" style="text-align:left;padding-top:0">Latency is applied to the response, so a
      webhook can reach your app before the API call that created it returns.</div></div>

    <div class="panel"><h2>Scenarios</h2><div class="controls">
      <select id="scn">\${scenarios.map(s => \`<option value="\${esc(s.name)}">\${esc(s.name)}</option>\`).join('')}</select>
      <select id="scn-pay">\${items.map(p => \`<option value="\${p.id}">\${esc(p.reference)} · \${p.status}</option>\`).join('')}</select>
      <button class="act primary" id="scn-run">Run</button>
    </div>
    <table><tbody>\${scenarios.map(s => \`<tr><td class="mono">\${esc(s.name)}</td>
      <td class="muted">\${esc(s.description ?? '')}</td><td class="muted">\${s.steps.length} steps</td></tr>\`).join('')}</tbody></table></div>\`;

  document.querySelectorAll('[data-t]').forEach(b => b.onclick = async () => {
    await api('/time', {method:'POST', body:{action:b.dataset.t, value:$('adv')?.value}}); render(); });
  $('net-save').onclick = async () => {
    await api('/network', {method:'POST', body:{latencyMs:Number($('net-lat').value), failureRate:Number($('net-rate').value)}}); render(); };
  $('net-reset').onclick = async () => { await api('/network', {method:'DELETE'}); render(); };
  $('scn-run').onclick = async () => {
    try { await api('/scenarios/run', {method:'POST', body:{scenario:$('scn').value, paymentId:$('scn-pay').value}});
      alert('Scenario started. Watch the payment timeline.'); } catch(e){ alert(e.message); } };
}

const RENDERERS = { overview: renderOverview, payments: renderPayments, webhooks: renderWebhooks,
                    events: renderEvents, simulation: renderSimulation };
async function render() { try { await RENDERERS[current](); } catch (e) { console.error(e); } }

/* Live updates: re-render the current view when anything changes. */
const stream = new EventSource(API + '/stream');
let pending = null;
stream.addEventListener('event', (m) => {
  const e = JSON.parse(m.data);
  const feed = $('feed');
  if (feed) feed.insertAdjacentHTML('afterbegin', feedRow(e));
  clearTimeout(pending); pending = setTimeout(render, 250);
});
stream.addEventListener('clock', (m) => {
  const s = JSON.parse(m.data);
  $('clock').textContent = new Date(s.now).toISOString().replace('T',' ').slice(0,19) +
    (s.mode === 'frozen' ? ' (frozen)' : '');
});
setInterval(() => api('/time').then(s => {
  $('clock').textContent = new Date(s.now).toISOString().replace('T',' ').slice(0,19) +
    (s.mode === 'frozen' ? ' (frozen)' : '');
}).catch(()=>{}), 1000);

render();
</script></body></html>`;
}
