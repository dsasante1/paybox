import type { Payment } from '@paybox/shared';
import { escapeHtml, formatAmount, renderHostedPage, renderHostedResult } from '@paybox/shared';

/**
 * Kora's hosted checkout page (spec §45).
 *
 * `POST /charges/initialize` returns a `checkout_url` the merchant redirects
 * the payer to. Emulating the call without the page it points at would leave
 * Kora's most-used integration untestable, so the emulator serves its own.
 *
 * The document, styling and §29 banner come from the shared hosted-page shell,
 * so this page cannot drift from the other providers' on the safety notice.
 */
export function renderKoraCheckout(options: {
  payment: Payment;
  reference: string;
  basePath: string;
  error?: string | null;
}): string {
  const amount = formatAmount(options.payment.amount, options.payment.currency);
  const action = `${options.basePath}/checkout/${encodeURIComponent(options.reference)}/pay`;

  return renderHostedPage({
    title: 'paybox — Kora checkout',
    ...(options.error ? { error: options.error } : {}),
    body: `<div class="card">
    <div class="amount">${escapeHtml(amount)}</div>
    <div class="ref">${escapeHtml(options.reference)}</div>

    <form method="POST" action="${escapeHtml(action)}">
      <label for="card_number">Card number</label>
      <input id="card_number" name="card_number" value="5060 6666 6666 6666 666" autocomplete="off">
      <label for="exp_month">Expiry month</label>
      <input id="exp_month" name="exp_month" value="09" autocomplete="off">
      <label for="exp_year">Expiry year</label>
      <input id="exp_year" name="exp_year" value="32" autocomplete="off">
      <button class="pay" type="submit">Pay ${escapeHtml(amount)}</button>
    </form>

    <p class="muted">Test instruments follow paybox's shared last-four convention:
    <code>…0000</code> succeeds, <code>…0001</code> is declined,
    <code>…0002</code> has insufficient funds. See docs/kora.md.</p>
  </div>`,
  });
}

export function renderKoraResult(options: {
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
