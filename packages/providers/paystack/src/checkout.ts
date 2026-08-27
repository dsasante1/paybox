import type { Payment } from '@paybox/shared';
import { formatAmount } from '@paybox/shared';
import { TEST_CARDS, TEST_MOBILE_NUMBERS } from '@paybox/simulator';

/**
 * The hosted checkout page (spec §45).
 *
 * Paystack's `initialize` returns an `authorization_url` that the developer
 * redirects the payer to. Emulating initialize without emulating the page it
 * points at would leave the most-used integration path untestable, so the
 * emulator serves its own -- unmistakably local, with the test instruments
 * listed right on it so nobody has to go looking them up.
 */
export function renderCheckoutPage(options: {
  payment: Payment;
  accessCode: string;
  basePath: string;
  error?: string | null;
}): string {
  const { payment, accessCode, basePath } = options;
  const amount = formatAmount(payment.amount, payment.currency);
  const action = `${basePath}/checkout/${accessCode}/pay`;

  const cardRows = TEST_CARDS.map(
    (c) =>
      `<tr><td><code>${c.number}</code></td><td>${c.brand}</td><td>${escapeHtml(c.description)}</td></tr>`,
  ).join('');
  const momoRows = TEST_MOBILE_NUMBERS.map(
    (m) =>
      `<tr><td><code>${m.number}</code></td><td>${m.network}</td><td>${escapeHtml(m.description)}</td></tr>`,
  ).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>paybox checkout — ${escapeHtml(payment.reference)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --fg:#14161a; --card:#fff;
          --muted:#606875; --line:#e3e6ea; --accent:#0b7285; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1115; --fg:#e8eaed; --card:#171a20; --muted:#9aa3ae;
            --line:#272b33; --accent:#38bdf8; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif; }
  .wrap { max-width: 560px; margin: 0 auto; padding: 32px 20px 64px; }
  .banner { background:#fde68a; color:#5c4400; padding:10px 14px; border-radius:8px;
            font-size:13px; font-weight:600; margin-bottom:20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:22px; }
  .amount { font-size:30px; font-weight:700; letter-spacing:-.02em; }
  .ref { color:var(--muted); font-size:13px; margin-top:2px; }
  fieldset { border:0; padding:0; margin:22px 0 0; }
  label { display:block; font-size:13px; font-weight:600; margin:14px 0 6px; }
  input, select { width:100%; padding:10px 12px; border:1px solid var(--line);
                  border-radius:8px; background:var(--bg); color:var(--fg); font:inherit; }
  .tabs { display:flex; gap:8px; margin-top:6px; }
  .tabs button { flex:1; padding:9px; border:1px solid var(--line); border-radius:8px;
                 background:var(--bg); color:var(--fg); font:inherit; cursor:pointer; }
  .tabs button[aria-selected="true"] { border-color:var(--accent); color:var(--accent); font-weight:600; }
  .pay { width:100%; margin-top:22px; padding:13px; border:0; border-radius:8px;
         background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  details { margin-top:26px; }
  summary { cursor:pointer; font-size:13px; color:var(--muted); }
  table { width:100%; border-collapse:collapse; margin-top:12px; font-size:12.5px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:600; }
  code { font:12px ui-monospace,SFMono-Regular,Menlo,monospace; }
  .err { background:#fee2e2; color:#991b1b; padding:10px 14px; border-radius:8px;
         font-size:13px; margin-bottom:16px; }
  .hide { display:none; }
</style></head><body>
<div class="wrap">
  <div class="banner">⚠ paybox emulator — no real money moves here. Test instruments only.</div>
  ${options.error ? `<div class="err">${escapeHtml(options.error)}</div>` : ''}
  <div class="card">
    <div class="amount">${escapeHtml(amount)}</div>
    <div class="ref">Reference ${escapeHtml(payment.reference)}</div>

    <form method="POST" action="${escapeHtml(action)}">
      <div class="tabs" role="tablist">
        <button type="button" role="tab" aria-selected="true"  data-m="mobile_money">Mobile money</button>
        <button type="button" role="tab" aria-selected="false" data-m="card">Card</button>
        <button type="button" role="tab" aria-selected="false" data-m="bank">Bank</button>
      </div>
      <input type="hidden" name="method" id="method" value="mobile_money">

      <fieldset id="pane-mobile_money">
        <label for="phone">Mobile money number</label>
        <input id="phone" name="phone" value="0550000000" autocomplete="off">
        <label for="network">Network</label>
        <select id="network" name="network">
          <option value="mtn">MTN Mobile Money</option>
          <option value="vod">Telecel Cash</option>
          <option value="atl">AirtelTigo Money</option>
        </select>
      </fieldset>

      <fieldset id="pane-card" class="hide">
        <label for="card_number">Card number</label>
        <input id="card_number" name="card_number" value="4000 0000 0000 0000" autocomplete="off">
      </fieldset>

      <fieldset id="pane-bank" class="hide">
        <label for="account">Account number</label>
        <input id="account" name="phone" value="0000000000" autocomplete="off">
      </fieldset>

      <button class="pay" type="submit">Pay ${escapeHtml(amount)}</button>
    </form>

    <details>
      <summary>Test instruments — the last four digits pick the outcome</summary>
      <table><thead><tr><th>Card</th><th>Brand</th><th>Result</th></tr></thead>
        <tbody>${cardRows}</tbody></table>
      <table><thead><tr><th>Mobile number</th><th>Network</th><th>Result</th></tr></thead>
        <tbody>${momoRows}</tbody></table>
    </details>
  </div>
</div>
<script>
  const tabs = document.querySelectorAll('[role=tab]');
  tabs.forEach((tab) => tab.addEventListener('click', () => {
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    const method = tab.dataset.m;
    document.getElementById('method').value = method;
    for (const name of ['mobile_money', 'card', 'bank']) {
      document.getElementById('pane-' + name).classList.toggle('hide', name !== method);
    }
  }));
</script>
</body></html>`;
}

/** Shown after the payer submits, while the emulator settles the payment. */
export function renderCheckoutResult(options: {
  payment: Payment;
  callbackUrl: string | null;
  message: string;
}): string {
  const redirect = options.callbackUrl
    ? `${options.callbackUrl}${options.callbackUrl.includes('?') ? '&' : '?'}reference=${encodeURIComponent(options.payment.reference)}`
    : null;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>paybox — ${escapeHtml(options.payment.status)}</title>
${redirect ? `<meta http-equiv="refresh" content="2;url=${escapeHtml(redirect)}">` : ''}
<style>
 :root{color-scheme:light dark}
 body{margin:0;display:grid;place-items:center;min-height:100vh;
      font:15px/1.6 system-ui,sans-serif;background:#f6f7f9;color:#14161a}
 @media(prefers-color-scheme:dark){body{background:#0f1115;color:#e8eaed}}
 .box{text-align:center;max-width:420px;padding:32px}
 .status{font-size:22px;font-weight:700;margin-bottom:8px}
 .muted{color:#606875;font-size:13.5px}
 a{color:#0b7285}
</style></head><body><div class="box">
  <div class="status">${escapeHtml(options.message)}</div>
  <div class="muted">Reference ${escapeHtml(options.payment.reference)} — status
    <strong>${escapeHtml(options.payment.status)}</strong></div>
  ${redirect ? `<p class="muted">Returning you to the merchant…<br><a href="${escapeHtml(redirect)}">Continue now</a></p>` : '<p class="muted">No callback_url was supplied, so there is nowhere to return to.</p>'}
</div></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
