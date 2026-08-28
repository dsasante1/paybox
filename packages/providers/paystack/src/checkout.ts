import type { Payment } from '@paybox/shared';
import {
  escapeHtml,
  formatAmount,
  renderHostedPage,
  renderHostedResult,
} from '@paybox/shared';
import { TEST_CARDS, TEST_MOBILE_NUMBERS } from '@paybox/simulator';

/**
 * The hosted checkout page (spec §45).
 *
 * Paystack's `initialize` returns an `authorization_url` that the developer
 * redirects the payer to. Emulating initialize without emulating the page it
 * points at would leave the most-used integration path untestable, so the
 * emulator serves its own -- unmistakably local, with the test instruments
 * listed right on it so nobody has to go looking them up.
 *
 * The document, styling and §29 banner come from the shared hosted-page shell;
 * only the payment fields below are Paystack's, because only they differ.
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

  return renderHostedPage({
    title: `paybox checkout — ${payment.reference}`,
    ...(options.error ? { error: options.error } : {}),
    body: `<div class="card">
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
      <summary>Test instruments</summary>
      <table><thead><tr><th>Card</th><th>Brand</th><th>Outcome</th></tr></thead>
        <tbody>${cardRows}</tbody></table>
      <table><thead><tr><th>Mobile money</th><th>Network</th><th>Outcome</th></tr></thead>
        <tbody>${momoRows}</tbody></table>
    </details>
  </div>`,
    script: `
  document.querySelectorAll('[data-m]').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var method = tab.getAttribute('data-m');
      document.getElementById('method').value = method;
      document.querySelectorAll('[data-m]').forEach(function (t) {
        t.setAttribute('aria-selected', String(t === tab));
      });
      ['mobile_money', 'card', 'bank'].forEach(function (m) {
        document.getElementById('pane-' + m).classList.toggle('hide', m !== method);
      });
    });
  });`,
  });
}

/** Shown after the payer submits the form. */
export function renderCheckoutResult(options: {
  payment: Payment;
  callbackUrl: string | null;
  message: string;
}): string {
  return renderHostedResult({
    title: `paybox — ${options.payment.reference}`,
    heading: formatAmount(options.payment.amount, options.payment.currency),
    message: options.message,
    redirectUrl: options.callbackUrl,
  });
}
