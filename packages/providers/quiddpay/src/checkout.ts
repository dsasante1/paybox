import type { Payment } from '@paybox/shared';
import { escapeHtml, formatAmount, renderHostedPage, renderHostedResult } from '@paybox/shared';
import { CHECKOUT_OPERATORS } from './rails.js';

/**
 * Quid Payments' hosted checkout page (spec §45).
 *
 * This one is not optional in the way the other adapters' pages are. Quid's
 * entire documented integration is "create a session, redirect the payer to
 * `checkout_url`, wait for a webhook" — the guide says a merchant backend
 * "does not start payment-method calls" at all. Emulating the session API
 * without serving the page it points at would leave the only integration Quid
 * documents untestable end to end.
 *
 * The page drives the same public attempt endpoints the real hosted checkout
 * calls, so what a developer watches here is the flow their payer takes.
 *
 * The document, styling and §29 banner come from the shared hosted-page shell,
 * so this page cannot drift from the other providers' on the safety notice.
 */
export function renderQuiddpayCheckout(options: {
  payment: Payment;
  reference: string;
  basePath: string;
  error?: string | null;
}): string {
  const amount = formatAmount(options.payment.amount, options.payment.currency);
  const action = `${options.basePath}/checkout/${encodeURIComponent(options.reference)}/pay`;
  const operators = CHECKOUT_OPERATORS.map(
    (operator) => `<option value="${escapeHtml(operator)}">${escapeHtml(operator)}</option>`,
  ).join('');
  const invoice = options.payment.metadata.invoice_ref;

  return renderHostedPage({
    title: 'paybox — Quid Payments checkout',
    ...(options.error ? { error: options.error } : {}),
    body: `<div class="card">
    <div class="amount">${escapeHtml(amount)}</div>
    <div class="ref">${escapeHtml(typeof invoice === 'string' ? invoice : options.reference)}</div>

    <form method="POST" action="${escapeHtml(action)}">
      <label for="rail">Payment method</label>
      <select id="rail" name="rail">
        <option value="momo">Mobile Money</option>
        <option value="bank_transfer">Bank transfer</option>
        <option value="cash">Cash deposit</option>
      </select>
      <label for="operator">Network</label>
      <select id="operator" name="operator">${operators}</select>
      <label for="phone">Mobile number</label>
      <input id="phone" name="phone" value="0550000000" autocomplete="off">
      <button class="pay" type="submit">Pay ${escapeHtml(amount)}</button>
    </form>

    <p class="muted">Quid Payments does not accept cards, so the outcome is selected by
    the <strong>mobile number</strong> instead. paybox's shared last-four convention
    applies: <code>…0000</code> succeeds, <code>…0001</code> is declined,
    <code>…0002</code> has insufficient funds. Bank transfer and cash deposit stay
    pending until they are confirmed. See docs/quiddpay.md.</p>
  </div>`,
  });
}

export function renderQuiddpayResult(options: {
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
