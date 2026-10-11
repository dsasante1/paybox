import type { Payment } from '@paybox/shared';
import { escapeHtml, formatAmount, renderHostedPage } from '@paybox/shared';
import type { Corridor } from './fees.js';
import { toDecimal } from './money.js';
import { corridorOf } from './serializers.js';
import type { StoredCheckout } from './state.js';
import { paymentStatusOf, type CheckoutStatus } from './status.js';

/**
 * Bachs' hosted checkout, as paybox serves it.
 *
 * Bachs is checkout-first: a merchant creates a session and sends the payer
 * to `checkout_url`, and there is no documented server-to-server way to
 * charge mobile money or a bank transfer. Emulating the session API without
 * the page it points at would leave the only integration Bachs documents
 * untestable end to end.
 *
 * Cards are steered by Bachs' published sandbox numbers. Every other rail
 * uses **test controls**, which Bachs mentions ("use the test controls on the
 * sandbox checkout page to make the payment succeed, fail, or arrive
 * underpaid") without describing; the ones here are paybox's and say so.
 */

// Kept here rather than imported from routes-checkout.ts, which imports this
// module; the corridor list is the one in that file's CORRIDORS.
const LABELS: Record<Corridor, string> = {
  USD_CARD: 'Card (USD)',
  NGN_CARD: 'Card (NGN)',
  NGN_BANK_TRANSFER: 'Bank transfer (NGN)',
  MOMO_GHS: 'Mobile money (Ghana)',
  MOMO_KES: 'Mobile money (Kenya)',
  MOMO_TZS: 'Mobile money (Tanzania)',
  MOMO_UGX: 'Mobile money (Uganda)',
  MOMO_XAF: 'Mobile money (Central Africa)',
  MOMO_XOF: 'Mobile money (West Africa)',
  MOMO_RWF: 'Mobile money (Rwanda)',
  MOMO_MWK: 'Mobile money (Malawi)',
  MOMO_ZMW: 'Mobile money (Zambia)',
  CRYPTO: 'Crypto',
};

const ASSETS = ['USDT_TRC20', 'USDT_BEP20', 'USDT_ERC20', 'USDT_SOL', 'USDC_BEP20', 'ETH_ETH', 'SOL_SOL', 'BNB_BEP20'];

function form(action: string, inner: string): string {
  return `<form method="POST" action="${escapeHtml(action)}">${inner}</form>`;
}

function controls(action: string, buttons: Array<[string, string]>): string {
  return `<div class="muted"><strong>paybox test control</strong> — Bachs' sandbox has controls
  here that it does not document; these are paybox's.</div>
  ${buttons
    .map(([value, label]) =>
      form(action, `<input type="hidden" name="action" value="${escapeHtml(value)}"><button class="pay" type="submit">${escapeHtml(label)}</button>`),
    )
    .join('')}`;
}

const EVERY: Record<string, string> = { day: 'day', week: 'week', month: 'month', year: 'year' };

function cadence(cycle: { interval: string; frequency: number }): string {
  const unit = EVERY[cycle.interval] ?? cycle.interval;
  return cycle.frequency === 1 ? unit : `${cycle.frequency} ${unit}s`;
}

function heading(checkout: StoredCheckout, payment: Payment | null): string {
  if (checkout.mode === 'setup') return 'Save a card';
  const recurring = checkout.recurring;
  if (recurring) {
    const price = `${formatAmount(recurring.unitAmount * recurring.quantity, recurring.currency)} every ${cadence(recurring.cycle)}`;
    return recurring.trial ? `Free for ${cadence(recurring.trial)}, then ${price}` : price;
  }
  if (payment) return formatAmount(payment.amount, payment.currency);
  if (checkout.amount === null) return `Pay what you want (${checkout.currency})`;
  return formatAmount(checkout.amount, checkout.currency);
}

export function renderCheckoutPage(options: {
  checkout: StoredCheckout;
  payment: Payment | null;
  basePath: string;
  error: string | null;
}): string {
  const { checkout, payment } = options;
  const base = `${options.basePath}/c/${encodeURIComponent(checkout.token)}`;
  const parts: string[] = [];
  const lines = checkout.lines
    .map(
      (line) =>
        `<div class="muted">${escapeHtml(line.productName)} × ${line.quantity}${
          line.priceType === 'custom' ? '' : ` — ${escapeHtml(formatAmount(line.unitAmount * line.quantity, line.currency))}`
        }</div>`,
    )
    .join('');

  if (!checkout.customerDetails) {
    parts.push(
      form(
        `${base}/identify`,
        `<label for="email">Email</label><input id="email" name="email" type="email" required>
         <label for="name">Name</label><input id="name" name="name">
         <button class="pay" type="submit">Continue</button>`,
      ),
    );
  } else if (checkout.amount === null) {
    const bounds = [
      checkout.minimum !== null ? `at least ${toDecimal(checkout.minimum, checkout.currency)}` : null,
      checkout.maximum !== null ? `at most ${toDecimal(checkout.maximum, checkout.currency)}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    parts.push(
      form(
        `${base}/amount`,
        `<label for="amount">Amount (${escapeHtml(checkout.currency)})${bounds ? ` — ${escapeHtml(bounds)}` : ''}</label>
         <input id="amount" name="amount" value="${escapeHtml(checkout.preset !== null ? toDecimal(checkout.preset, checkout.currency) : '')}">
         <button class="pay" type="submit">Continue</button>`,
      ),
    );
  } else if (checkout.mode === 'setup' || (checkout.recurring?.trial && !payment)) {
    parts.push(saveForm(checkout, `${base}/pay`));
  } else if (checkout.amount === 0 && !payment) {
    parts.push(form(`${base}/complete`, `<button class="pay" type="submit">Complete order</button>`));
  } else if (payment && ['pending', 'requires_action', 'processing'].includes(payment.status)) {
    parts.push(attemptView(payment, `${base}/simulate`));
  } else {
    if (payment?.status === 'failed') {
      parts.push(`<div class="err">${escapeHtml(payment.failureMessage ?? 'The payment failed.')} You can try again.</div>`);
    }
    parts.push(methodForm(checkout, payment, `${base}/pay`));
  }

  return renderHostedPage({
    title: 'paybox — Bachs checkout',
    ...(options.error ? { error: options.error } : {}),
    body: `<div class="card">
    <div class="amount">${escapeHtml(heading(checkout, payment))}</div>
    <div class="ref">${escapeHtml(checkout.reference ?? checkout.id)}</div>
    ${lines}
    ${parts.join('\n')}
    ${checkout.cancelUrl ? `<p class="muted"><a href="${escapeHtml(checkout.cancelUrl)}">Cancel and return</a></p>` : ''}
  </div>`,
  });
}

function methodForm(checkout: StoredCheckout, payment: Payment | null, action: string): string {
  const corridors = checkout.corridors.filter((corridor) => !payment || corridorCurrency(corridor) === payment.currency);
  const options = corridors
    .map((corridor) => `<option value="${corridor}">${escapeHtml(LABELS[corridor])}</option>`)
    .join('');
  const assets = ASSETS.map((asset) => `<option value="${asset}">${asset}</option>`).join('');
  return form(
    action,
    `<label for="corridor">Payment method</label><select id="corridor" name="corridor">${options}</select>
     <label for="card_number">Card number (cards)</label><input id="card_number" name="card_number" value="4242424242424242" autocomplete="off">
     ${expiryFields()}
     <label for="phone_number">Mobile money number (mobile money)</label><input id="phone_number" name="phone_number" value="+233241234567">
     <label for="provider">Network (mobile money)</label><input id="provider" name="provider" value="MTN">
     <label for="asset">Asset (crypto)</label><select id="asset" name="asset">${assets}</select>
     <button class="pay" type="submit">Pay</button>
     <p class="muted">Cards follow Bachs' sandbox numbers: <code>4000000000000002</code> declined,
     <code>4000000000009995</code> insufficient funds, <code>4000000000000069</code> expired,
     <code>4000000000000119</code> processing error; any other number succeeds about a second
     later${saving(checkout) ? `, and <code>4000000000000341</code> is saved and then declined by
     every later charge` : ''}. Other methods wait for a paybox test control. See docs/bachs.md.</p>`,
  );
}

function saving(checkout: StoredCheckout): boolean {
  return checkout.mode === 'subscription' || checkout.mode === 'setup' || checkout.savePaymentMethod === true;
}

function expiryFields(): string {
  // Left blank, the card is good for years from the virtual date.
  return `<label for="exp_month">Expiry month</label><input id="exp_month" name="exp_month" placeholder="12">
     <label for="exp_year">Expiry year</label><input id="exp_year" name="exp_year" placeholder="five years on">`;
}

/** A card collected without a charge: a trial's, or a `setup` checkout's. */
function saveForm(checkout: StoredCheckout, action: string): string {
  const label = checkout.mode === 'setup' ? 'Save card' : 'Start trial';
  return form(
    action,
    `<input type="hidden" name="corridor" value="USD_CARD">
     <label for="card_number">Card number</label><input id="card_number" name="card_number" value="4242424242424242" autocomplete="off">
     ${expiryFields()}
     <p class="muted">Nothing is charged now; the card is saved${
       checkout.mode === 'subscription' ? ' and billed when the trial ends' : ''
     }. <code>4000000000000341</code> saves and is then declined by every later charge;
     <code>4000000000000002</code> and the other refusal numbers are not saved.</p>
     <button class="pay" type="submit">${label}</button>`,
  );
}

function corridorCurrency(corridor: Corridor): string {
  if (corridor === 'CRYPTO' || corridor === 'USD_CARD') return 'USD';
  if (corridor === 'NGN_CARD' || corridor === 'NGN_BANK_TRANSFER') return 'NGN';
  return corridor.slice(5);
}

function attemptView(payment: Payment, action: string): string {
  const corridor = corridorOf(payment);
  const details = payment.paymentMethodDetails;
  const status = paymentStatusOf(payment);
  if (status === 'underpaid') {
    return `<div class="msg">Received ${escapeHtml(formatAmount(Number(details.amount_paid ?? 0), payment.currency))} of
      ${escapeHtml(formatAmount(payment.amount, payment.currency))}.</div>
      ${controls(action, [
        ['send_rest', 'Payer sends the rest'],
        ['accept_underpayment', 'Merchant accepts the underpayment'],
      ])}`;
  }
  if (payment.status === 'processing') {
    return `<div class="msg">Processing. A sandbox payment finalizes on its own about a second
      after it is made — advance paybox's clock to see it settle.</div>`;
  }
  if (corridor === 'NGN_BANK_TRANSFER') {
    const account = (details.virtual_account ?? {}) as Record<string, unknown>;
    return `<div class="msg">Transfer ${escapeHtml(formatAmount(payment.amount, payment.currency))} to
      account <strong>${escapeHtml(String(account.account_number ?? ''))}</strong> at
      ${escapeHtml(String(account.bank_name ?? ''))}.</div>
      ${controls(action, [
        ['succeed', 'Transfer received'],
        ['short_transfer', 'Transfer arrives short'],
        ['fail', 'Transfer fails'],
      ])}`;
  }
  if (corridor === 'CRYPTO') {
    return `<div class="msg">Send ${escapeHtml(String(details.asset ?? ''))} to
      <code>${escapeHtml(String(details.address ?? ''))}</code>.</div>
      ${controls(action, [
        ['succeed', 'Payment arrives'],
        ['underpaid', 'Arrives underpaid'],
        ['overpaid', 'Arrives overpaid'],
        ['fail', 'Payment fails'],
      ])}`;
  }
  return `<div class="msg">Approve the prompt sent to ${escapeHtml(String(details.phone_number ?? ''))}.</div>
    ${controls(action, [
      ['succeed', 'Payer approves'],
      ['fail', 'Payer declines'],
    ])}`;
}

export function renderCheckoutResult(options: {
  checkout: StoredCheckout;
  payment: Payment | null;
  status: CheckoutStatus;
  basePath: string;
  redirectUrl: string | null;
}): string {
  const { checkout, payment, status } = options;
  const message =
    status === 'completed'
      ? payment
        ? 'Payment received.'
        : checkout.mode === 'setup'
          ? 'Card saved.'
          : checkout.mode === 'subscription'
            ? 'Trial started. Nothing was charged.'
            : 'Order complete. Nothing was due.'
      : status === 'expired'
        ? 'This checkout has expired.'
        : 'This checkout was cancelled.';
  const late =
    status === 'expired' && payment && corridorOf(payment) === 'NGN_BANK_TRANSFER'
      ? controls(`${options.basePath}/c/${encodeURIComponent(checkout.token)}/simulate`, [
          ['late_transfer', 'Transfer arrives late (completes the expired checkout)'],
        ])
      : '';
  const redirect = options.redirectUrl;
  return renderHostedPage({
    title: 'paybox — Bachs checkout',
    body: `<div class="card">
    <div class="amount">${escapeHtml(heading(checkout, payment))}</div>
    <div class="msg">${escapeHtml(message)}</div>
    ${late}
    ${
      redirect
        ? `<div class="muted">Continue to <a href="${escapeHtml(redirect)}">${escapeHtml(redirect)}</a></div>`
        : '<div class="muted">No return URL was configured for this checkout.</div>'
    }
  </div>`,
  });
}
