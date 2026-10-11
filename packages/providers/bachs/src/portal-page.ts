import { escapeHtml, formatAmount, renderHostedPage } from '@paybox/shared';
import type { StoredSubscription } from './state.js';
import type { BachsSubscriptionStatus } from './status.js';

/**
 * Bachs' customer portal, as paybox serves it. The real one is at
 * `portal.bachs.io/s/<token>`; this is the same idea at
 * `/bachs/portal/s/<token>`, offering what Bachs' default portal settings
 * offer (routes-portal.ts lists them).
 */

export interface PortalSubscription {
  stored: StoredSubscription;
  status: BachsSubscriptionStatus;
  /** Set to end at the close of the period. */
  ending: boolean;
  productName: string;
}

export interface PortalInvoice {
  id: string;
  status: string;
  amount: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  attempts: number;
}

export interface PortalCard {
  id: string;
  brand: string;
  last4: string;
  expiry: string;
  isDefault: boolean;
}

function form(action: string, inner: string): string {
  return `<form method="POST" action="${escapeHtml(action)}">${inner}</form>`;
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function subscriptionBlock(base: string, entry: PortalSubscription): string {
  const { stored, status } = entry;
  const action = `${base}/subscriptions/${encodeURIComponent(stored.id)}`;
  const price = `${formatAmount(stored.unitAmount * stored.quantity, stored.currency)} every ${
    stored.cycle.frequency === 1 ? stored.cycle.interval : `${stored.cycle.frequency} ${stored.cycle.interval}s`
  }`;
  const lines = [
    `<div class="amount">${escapeHtml(entry.productName)}</div>`,
    `<div class="muted">${escapeHtml(price)} — <strong>${escapeHtml(status)}</strong></div>`,
    `<div class="muted">Current period ${escapeHtml(day(stored.periodStart))} to ${escapeHtml(day(stored.periodEnd))}</div>`,
  ];
  if (status === 'canceled') {
    lines.push('<div class="muted">This subscription has ended.</div>');
  } else if (entry.ending) {
    lines.push(`<div class="msg">Ends on ${escapeHtml(day(stored.periodEnd))}.</div>`);
    lines.push(form(`${action}/resume`, '<button class="pay" type="submit">Keep my subscription</button>'));
  } else {
    lines.push(form(`${action}/cancel`, '<button class="pay" type="submit">Cancel at the end of the period</button>'));
  }
  if (status === 'past_due' || status === 'unpaid') {
    lines.push(
      form(
        `${action}/pay`,
        `<div class="err">A payment is overdue. Pay it with a card to restore the subscription.</div>
         <label for="card_number_${escapeHtml(stored.id)}">Card number</label>
         <input id="card_number_${escapeHtml(stored.id)}" name="card_number" value="4242424242424242" autocomplete="off">
         <label>Expiry month</label><input name="exp_month" placeholder="12">
         <label>Expiry year</label><input name="exp_year" placeholder="five years on">
         <button class="pay" type="submit">Pay now</button>`,
      ),
    );
  }
  return `<div class="card">${lines.join('\n')}</div>`;
}

export function renderPortalPage(options: {
  basePath: string;
  email: string;
  subscriptions: PortalSubscription[];
  invoices: PortalInvoice[];
  cards: PortalCard[];
  message: string | null;
  error: string | null;
}): string {
  const subscriptions =
    options.subscriptions.length > 0
      ? options.subscriptions.map((entry) => subscriptionBlock(options.basePath, entry)).join('\n')
      : '<div class="card"><div class="muted">No subscriptions.</div></div>';
  const invoices =
    options.invoices.length > 0
      ? options.invoices
          .map(
            (invoice) =>
              `<div class="muted"><code>${escapeHtml(invoice.id)}</code> — ${escapeHtml(day(invoice.periodStart))} to ${escapeHtml(
                day(invoice.periodEnd),
              )} — ${escapeHtml(formatAmount(invoice.amount, invoice.currency))} — ${escapeHtml(invoice.status)} (${invoice.attempts} attempt${
                invoice.attempts === 1 ? '' : 's'
              })</div>`,
          )
          .join('')
      : '<div class="muted">No invoices.</div>';
  const cards =
    options.cards.length > 0
      ? options.cards
          .map(
            (card) =>
              `<div class="muted">${escapeHtml(card.brand)} •••• ${escapeHtml(card.last4)} — expires ${escapeHtml(card.expiry)}${
                card.isDefault ? ' — default' : ''
              }</div>`,
          )
          .join('')
      : '<div class="muted">No saved cards.</div>';
  return renderHostedPage({
    title: 'paybox — Bachs customer portal',
    ...(options.error ? { error: options.error } : {}),
    body: `<div class="card"><div class="ref">${escapeHtml(options.email)}</div>
    ${options.message ? `<div class="msg">${escapeHtml(options.message)}</div>` : ''}</div>
    ${subscriptions}
    <div class="card"><div class="amount">Invoices</div>${invoices}</div>
    <div class="card"><div class="amount">Cards</div>${cards}</div>`,
  });
}

/** "An expired session shows an expiry page." */
export function renderPortalExpired(): string {
  return renderHostedPage({
    title: 'paybox — Bachs customer portal',
    body: `<div class="card"><div class="amount">This link has expired</div>
    <div class="muted">Portal sessions are short-lived. Ask for a new link.</div></div>`,
  });
}
