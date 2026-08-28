import type { Payment } from '@paybox/shared';
import {
  escapeHtml,
  formatAmount,
  renderHostedPage,
  renderHostedResult,
} from '@paybox/shared';
import { STRIPE_PUBLISHED_CARDS } from './instruments.js';

/**
 * Stripe's hosted Checkout page (spec §45).
 *
 * A Checkout Session returns a `url` that the developer redirects the payer
 * to. Emulating the session without the page it points at would leave the
 * most-used Stripe integration untestable, so the emulator serves its own.
 *
 * Card-only, because Stripe Checkout in `mode: payment` with no other payment
 * method types configured is card-only, and inventing a wallet button that
 * cannot work would be worse than omitting it.
 *
 * The document, styling and §29 banner come from the shared hosted-page shell.
 */
export function renderCheckoutPage(options: {
  payment: Payment;
  sessionId: string;
  basePath: string;
  productName: string;
  error?: string | null;
}): string {
  const { payment, sessionId, basePath, productName } = options;
  const amount = formatAmount(payment.amount, payment.currency);
  const action = `${basePath}/checkout/${sessionId}/pay`;

  const rows = STRIPE_PUBLISHED_CARDS.map(
    (card) =>
      `<tr><td><code>${formatCardNumber(card.digits)}</code></td><td>${escapeHtml(
        card.description.replace(/^Stripe test card: /, ''),
      )}</td></tr>`,
  ).join('');

  return renderHostedPage({
    title: `paybox — ${productName}`,
    ...(options.error ? { error: options.error } : {}),
    body: `<div class="card">
    <div class="amount">${escapeHtml(amount)}</div>
    <div class="ref">${escapeHtml(productName)}</div>

    <form method="POST" action="${escapeHtml(action)}">
      <label for="card_number">Card number</label>
      <input id="card_number" name="card_number" value="4242 4242 4242 4242" autocomplete="off">
      <label for="exp_month">Expiry month</label>
      <input id="exp_month" name="exp_month" value="12" autocomplete="off">
      <label for="exp_year">Expiry year</label>
      <input id="exp_year" name="exp_year" value="2034" autocomplete="off">
      <button class="pay" type="submit">Pay ${escapeHtml(amount)}</button>
    </form>

    <details>
      <summary>Stripe test cards</summary>
      <table><thead><tr><th>Card</th><th>Outcome</th></tr></thead>
        <tbody>${rows}</tbody></table>
    </details>
  </div>`,
  });
}

/** Shown once the payer submits, before the redirect to success_url. */
export function renderCheckoutResult(options: {
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

function formatCardNumber(digits: string): string {
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ').trim();
}
