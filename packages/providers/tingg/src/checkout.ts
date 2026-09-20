import { formatAmount } from '@paybox/shared';
import type { StoredCheckout } from './state.js';
import { optionLabel } from './rails.js';

/**
 * The hosted checkout page.
 *
 * Express checkout redirects a payer to a page Tingg hosts; this is paybox's
 * stand-in for it, and it is **emulator surface, not Tingg surface** -- the
 * real page lives on a Tingg domain with a URL shape paybox has no business
 * imitating. coverage.ts marks both its routes emulator-only for that reason.
 *
 * It drives the same `charge` path the Custom Checkout API does, rather than
 * being a second implementation beside it. A payer paying through this page
 * and a merchant posting `checkout-charge` produce the same events, the same
 * IPN and the same delivery ladder, which is the difference between an
 * emulator and a mock (spec §46).
 *
 * Self-contained HTML with no external assets, like the dashboard: `npm
 * install -g` must not need a build step, and the page has to work offline.
 */
export function renderTinggCheckout(
  checkout: StoredCheckout,
  options: { amountMinor: number; action: string; message?: string },
): string {
  const name = escape(`${checkout.customerFirstName} ${checkout.customerLastName}`.trim());
  const amount = escape(formatAmount(options.amountMinor, checkout.currencyCode));
  const description = escape(checkout.requestDescription ?? checkout.accountNumber);
  const msisdn = escape(checkout.msisdn);
  const option = escape(optionLabel(checkout.paymentOptionCode));

  return page(
    `Pay ${amount}`,
    `
    <div class="card">
      <p class="eyebrow">Tingg Checkout &middot; paybox emulator</p>
      <h1>${amount}</h1>
      <p class="muted">${description}</p>
      <dl>
        <dt>Payer</dt><dd>${name}</dd>
        <dt>Reference</dt><dd>${escape(checkout.merchantTransactionId)}</dd>
        <dt>Service</dt><dd>${escape(checkout.serviceCode)}</dd>
      </dl>
      ${options.message ? `<p class="notice">${escape(options.message)}</p>` : ''}
      <form method="post" action="${escape(options.action)}">
        <label for="msisdn">Mobile number</label>
        <input id="msisdn" name="msisdn" value="${msisdn}" inputmode="numeric" />
        <label for="payment_option_code">Payment option</label>
        <input id="payment_option_code" name="payment_option_code"
               value="${escape(checkout.paymentOptionCode ?? '')}" placeholder="${option}" />
        <button type="submit">Pay ${amount}</button>
      </form>
      <p class="fine">
        The outcome is chosen by the mobile number, the same way every other
        adapter here chooses one &mdash; see <code>docs/test-instruments.md</code>.
        No money moves and nothing leaves this machine.
      </p>
    </div>`,
  );
}

/** Where a payer lands after paying, before the redirect fires. */
export function renderTinggResult(
  checkout: StoredCheckout,
  options: { heading: string; detail: string; redirectTo: string | null },
): string {
  return page(
    options.heading,
    `
    <div class="card">
      <p class="eyebrow">Tingg Checkout &middot; paybox emulator</p>
      <h1>${escape(options.heading)}</h1>
      <p class="muted">${escape(options.detail)}</p>
      <dl>
        <dt>Reference</dt><dd>${escape(checkout.merchantTransactionId)}</dd>
        <dt>Checkout request</dt><dd>${escape(checkout.checkoutRequestId)}</dd>
      </dl>
      ${
        options.redirectTo
          ? `<p><a class="button" href="${escape(options.redirectTo)}">Continue</a></p>`
          : ''
      }
    </div>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;
         background:#0f1115; color:#e6e8ec; padding:24px; }
  .card { width:min(420px,100%); background:#171a21; border:1px solid #262b36;
          border-radius:14px; padding:28px; }
  .eyebrow { margin:0 0 18px; font-size:12px; letter-spacing:.08em;
             text-transform:uppercase; color:#8b94a7; }
  h1 { margin:0 0 4px; font-size:30px; letter-spacing:-.02em; }
  .muted { margin:0 0 20px; color:#8b94a7; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:6px 16px;
       margin:0 0 20px; font-size:13px; }
  dt { color:#8b94a7; } dd { margin:0; text-align:right; }
  label { display:block; margin:14px 0 6px; font-size:13px; color:#8b94a7; }
  input { width:100%; box-sizing:border-box; padding:10px 12px; border-radius:8px;
          border:1px solid #2d3340; background:#0f1115; color:inherit; font:inherit; }
  button, .button { display:block; width:100%; box-sizing:border-box; margin-top:20px;
           padding:12px; border:0; border-radius:8px; background:#3b82f6; color:#fff;
           font:inherit; font-weight:600; cursor:pointer; text-align:center;
           text-decoration:none; }
  .notice { padding:10px 12px; border-radius:8px; background:#2a2118;
            border:1px solid #4a3a20; color:#f0c674; font-size:13px; }
  .fine { margin:18px 0 0; font-size:12px; color:#6b7385; }
  code { background:#0f1115; padding:1px 4px; border-radius:4px; }
</style></head><body>${body}</body></html>`;
}

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
