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

/**
 * The step-up page a SetupIntent's `next_action` redirects to (spec §45).
 *
 * A card that requires authentication parks the setup at `requires_action`
 * and hands back a `redirect_to_url`. Advertising that URL without serving
 * anything at it would be worse than omitting `next_action` entirely, so the
 * emulator serves the confirmation the customer would see -- and, because the
 * point is to exercise both branches, the refusal beside it.
 *
 * No money is involved: this authorises *storing* the instrument.
 */
export function renderSetupAuthenticationPage(options: {
  setupId: string;
  basePath: string;
  last4: string | null;
  error?: string | null;
}): string {
  const action = `${options.basePath}/setup/${options.setupId}/complete`;
  const card = options.last4 ? `card ending ${options.last4}` : 'this card';

  return renderHostedPage({
    title: 'paybox — confirm your card',
    ...(options.error ? { error: options.error } : {}),
    body: `<div class="card">
    <div class="amount">Confirm your card</div>
    <div class="ref">Saving ${escapeHtml(card)} for future payments. No charge will be made now.</div>

    <form method="POST" action="${escapeHtml(action)}">
      <button class="pay" type="submit" name="outcome" value="approve">Confirm</button>
    </form>
    <form method="POST" action="${escapeHtml(action)}">
      <button class="pay secondary" type="submit" name="outcome" value="reject">Cancel</button>
    </form>
  </div>`,
  });
}

/** Shown once the customer answers the step-up. */
export function renderSetupResult(options: {
  approved: boolean;
  redirectUrl: string | null;
}): string {
  return renderHostedResult({
    title: 'paybox — card setup',
    heading: options.approved ? 'Card saved' : 'Setup cancelled',
    message: options.approved
      ? 'Your card has been stored for future payments.'
      : 'The card was not saved.',
    redirectUrl: options.redirectUrl,
  });
}
