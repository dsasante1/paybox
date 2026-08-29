import type { Payment } from '@paybox/shared';
import {
  escapeHtml,
  formatAmount,
  renderHostedPage,
  renderHostedResult,
} from '@paybox/shared';
import { FLUTTERWAVE_PUBLISHED_CARDS } from './instruments.js';

/**
 * Flutterwave Standard's hosted page (spec §45).
 *
 * `POST /v3/payments` returns a `data.link` the merchant redirects the payer
 * to. Emulating the call without the page it points at would leave
 * Flutterwave's most-used integration untestable, so the emulator serves its
 * own.
 *
 * The document, styling and §29 banner come from the shared hosted-page shell,
 * so this page cannot drift from Paystack's and Stripe's on the safety notice.
 */
export function renderFlutterwaveCheckout(options: {
  payment: Payment;
  txRef: string;
  basePath: string;
  title: string;
  error?: string | null;
}): string {
  const amount = formatAmount(options.payment.amount, options.payment.currency);
  const action = `${options.basePath}/checkout/${encodeURIComponent(options.txRef)}/pay`;

  const rows = FLUTTERWAVE_PUBLISHED_CARDS.map(
    (card) =>
      `<tr><td><code>${formatNumber(card.digits)}</code></td><td>${escapeHtml(
        card.description.replace(/^Flutterwave test card: /, ''),
      )}</td></tr>`,
  ).join('');

  return renderHostedPage({
    title: `paybox — ${options.title}`,
    ...(options.error ? { error: options.error } : {}),
    body: `<div class="card">
    <div class="amount">${escapeHtml(amount)}</div>
    <div class="ref">${escapeHtml(options.title)} — ${escapeHtml(options.txRef)}</div>

    <form method="POST" action="${escapeHtml(action)}">
      <label for="card_number">Card number</label>
      <input id="card_number" name="card_number" value="5531 8866 5214 2950" autocomplete="off">
      <label for="exp_month">Expiry month</label>
      <input id="exp_month" name="exp_month" value="09" autocomplete="off">
      <label for="exp_year">Expiry year</label>
      <input id="exp_year" name="exp_year" value="32" autocomplete="off">
      <button class="pay" type="submit">Pay ${escapeHtml(amount)}</button>
    </form>

    <details>
      <summary>Flutterwave test cards</summary>
      <table><thead><tr><th>Card</th><th>Outcome</th></tr></thead>
        <tbody>${rows}</tbody></table>
    </details>
  </div>`,
  });
}

/**
 * Shown once the payer submits.
 *
 * Flutterwave appends `tx_ref`, `transaction_id` and `status` to the
 * merchant's `redirect_url` as query parameters, so the emulator does too --
 * an integration that reads them back has to find them here.
 */
export function renderFlutterwaveResult(options: {
  payment: Payment;
  redirectUrl: string | null;
  message: string;
}): string {
  return renderHostedResult({
    title: 'paybox — payment submitted',
    heading: formatAmount(options.payment.amount, options.payment.currency),
    message: options.message,
    redirectUrl: options.redirectUrl,
  });
}

function formatNumber(digits: string): string {
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ').trim();
}
