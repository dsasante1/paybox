import type { Clock, IdFactory, PayboxEvent, Payment, Transfer } from '@paybox/shared';
import type { Storage } from '@paybox/core';
import {
  fixedInterval,
  type FormattedWebhook,
  type FormatterContext,
  type RetryPolicy,
  type SigningContext,
  type WebhookFormatter,
} from '@paybox/webhooks';
import { TINGG_UNUSED_SECRET, tinggSignatureHeaders } from './signature.js';
import { tinggState, type StoredCheckout, type StoredPayout } from './state.js';
import { beepEnvelope, major, serializeNotification, stamp } from './serializers.js';
import {
  TINGG_ACKNOWLEDGEMENT_CODES,
  TINGG_BEEP_AUTH,
  beepStatusDescription,
  isFinalCheckoutStatus,
  toBeepStatus,
} from './status.js';
import { findCountry } from './rails.js';

/**
 * Tingg's IPN retry ladder.
 *
 * The published behaviour is "retries every 30sec within 24 hours of the
 * transaction" (docs.tingg.africa/docs/callback, read 2026-09-20) -- a flat
 * interval bounded by elapsed time, which is 2,880 attempts.
 *
 * paybox runs the same interval and **caps the count at 20**. This is a
 * deliberate, documented divergence, not an oversight: 2,880 delivery rows per
 * unacknowledged webhook would make `paybox time advance 24h` unusable and
 * bury the delivery log, while the property a developer is actually testing --
 * that an unacknowledged IPN comes back, at a fixed interval, until it is
 * acknowledged -- is fully visible in twenty. docs/tingg.md states the real
 * figure beside the emulated one so nobody calibrates against the wrong number.
 */
export const TINGG_RETRY_INTERVAL_MS = 30_000;
export const TINGG_MAX_ATTEMPTS = 20;
/** What Tingg itself would do, for the record. */
export const TINGG_REAL_RETRY_WINDOW_HOURS = 24;
export const TINGG_REAL_MAX_ATTEMPTS = 2_880;

export const TINGG_RETRY: RetryPolicy = {
  enabled: true,
  maxAttempts: TINGG_MAX_ATTEMPTS,
  backoff: fixedInterval(TINGG_RETRY_INTERVAL_MS),
};

/**
 * The delivery labels.
 *
 * Tingg's callback body carries **no event name** -- there is no `event`,
 * `type` or `x-event` anywhere in it. These two strings exist purely so the
 * delivery log, the dashboard and endpoint filters have something to key on,
 * and neither appears on the wire. docs/tingg.md says so, because a developer
 * who saw `checkout.payment` in the dashboard could otherwise reasonably
 * expect to find it in the payload.
 */
export const TINGG_CHECKOUT_EVENT = 'checkout.payment';
export const TINGG_PAYOUT_EVENT = 'payout.status';

/**
 * Register an endpoint for a per-request callback URL.
 *
 * Tingg has no dashboard-configured webhook address: `callback_url` arrives on
 * the checkout payload and `extraData.callbackUrl` on a payout packet, so the
 * set of subscribers is discovered as requests come in rather than declared up
 * front. The adapter records each one as it sees it, and the formatter names it
 * with `FormattedWebhook.deliverTo` so one checkout's IPN cannot be fanned out
 * to another's address.
 *
 * The endpoint's `secret` is never used -- Tingg signs nothing (see
 * signature.ts) -- but the column is not nullable and six other providers need
 * it, so it carries a value that says what it is.
 */
export async function ensureCallbackEndpoint(
  storage: Storage,
  deps: { ids: IdFactory; clock: Clock },
  url: string,
): Promise<void> {
  const existing = await storage.webhooks.listEndpoints();
  if (existing.some((endpoint) => endpoint.provider === 'tingg' && endpoint.url === url)) return;

  const now = deps.clock.nowISO();
  await storage.webhooks.createEndpoint({
    id: deps.ids.next('whe'),
    provider: 'tingg',
    url,
    secret: TINGG_UNUSED_SECRET,
    enabled: true,
    // Empty means every event for this provider. Tingg has no event names to
    // filter on in the first place.
    eventTypes: [],
    description: 'Registered from a Tingg callback_url',
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Canonical event -> Tingg IPN.
 *
 * Three things make this formatter unlike the other seven.
 *
 * **It signs nothing.** See signature.ts for why, at length.
 *
 * **It targets one URL per resource**, because Tingg takes its callback
 * address on the request rather than from a dashboard.
 *
 * **A 2xx is not an acknowledgement.** Tingg reads a code out of the response
 * *body* and keeps re-posting until it sees one. That is what
 * `interpretResponse` below implements, and it is the single most valuable
 * thing this adapter offers: an integration that answers a bare `200 OK`
 * looks correct against every other provider here and gets re-posted for
 * twenty-four hours in production.
 */
export class TinggWebhookFormatter implements WebhookFormatter {
  readonly provider = 'tingg' as const;

  /** Nothing is signed, so there is nothing to re-sign per attempt. */
  readonly resignsPerAttempt = false;

  readonly retry = TINGG_RETRY;

  async format(
    event: PayboxEvent,
    context: FormatterContext,
  ): Promise<FormattedWebhook | FormattedWebhook[] | null> {
    const { storage } = context;
    const state = tinggState(storage, () => event.createdAt);

    if (event.resourceType === 'payment') {
      const payment = await storage.payments.byId(event.resourceId);
      if (!payment || payment.provider !== this.provider) return null;
      const checkout = await state.checkouts.get(payment.reference);
      if (!checkout) return null;
      return this.#checkoutNotification(payment, checkout);
    }

    if (event.resourceType === 'transfer') {
      const transfer = await storage.transfers.byId(event.resourceId);
      if (!transfer || transfer.provider !== this.provider) return null;
      const payout = await state.payouts.get(transfer.reference);
      if (!payout) return null;
      return this.#payoutCallback(transfer, payout);
    }

    return null;
  }

  /**
   * Tingg posts an IPN when a payment is **made**, not while one is pending.
   *
   * Its documentation describes the callback as carrying a payment: "When a
   * full payment is made, a JSON request is sent to the merchant's callback
   * URL". There is no documented pending notification, so paybox sends none --
   * the same rule that keeps `charge.failed` out of the Paystack adapter.
   */
  #checkoutNotification(payment: Payment, checkout: StoredCheckout): FormattedWebhook | null {
    if (!isFinalCheckoutStatus(payment.status)) return null;
    if (!checkout.callbackUrl) return null;

    const country = findCountry(checkout.countryCode);
    return {
      eventType: TINGG_CHECKOUT_EVENT,
      deliverTo: checkout.callbackUrl,
      body: serializeNotification(checkout, payment, {
        countryAbbrv: country?.alpha2 ?? checkout.countryCode,
        requestDate: stamp(checkout.createdAt),
      }),
    };
  }

  /**
   * The payout callback.
   *
   * Only a settled payout produces one. `postPayment` answers `139` --
   * "pending acknowledgement" -- and the documentation is explicit that 139 is
   * the only code that triggers a callback at all, so the callback *is* the
   * final status arriving. A queued payout therefore gets no webhook here,
   * which is also why the BEEP `queryPaymentStatus` function exists.
   *
   * The body carries the merchant's own credentials back, because Tingg's
   * payout callback does. See signature.ts.
   */
  #payoutCallback(transfer: Transfer, payout: StoredPayout): FormattedWebhook | null {
    if (!['successful', 'failed', 'reversed'].includes(transfer.status)) return null;
    if (!payout.callbackUrl) return null;

    const code = toBeepStatus(transfer.status);
    return {
      eventType: TINGG_PAYOUT_EVENT,
      deliverTo: payout.callbackUrl,
      body: beepEnvelope(
        { code: TINGG_BEEP_AUTH.SUCCESS, description: 'Authentication was successful' },
        [
          {
            statusCode: code,
            statusDescription: beepStatusDescription(code),
            payerTransactionID: payout.payerTransactionId,
            beepTransactionID: payout.beepTransactionId,
            MSISDN: payout.msisdn,
            accountNumber: payout.accountNumber,
            amount: major(payout.amount),
            currencyCode: payout.currencyCode,
            payerClientCode: payout.serviceCode,
            receiptNumber: transfer.status === 'successful' ? payout.beepTransactionId : '',
            receiverNarration: payout.narration,
            datePaymentReceived: stamp(transfer.updatedAt),
          },
        ],
      ),
    };
  }

  sign(rawBody: string, secret: string, context: SigningContext): Record<string, string> {
    return tinggSignatureHeaders(rawBody, secret, context);
  }

  /**
   * Whether the subscriber acknowledged the IPN.
   *
   * Tingg does not accept an HTTP status as an answer. It requires a body
   * carrying one of three codes -- 183 accepted, 180 rejected, 188 received
   * and will be acknowledged later -- and re-posts every thirty seconds for
   * twenty-four hours until it sees one. All three *stop* the retries; 180 is
   * a rejection of the payment, not of the delivery.
   *
   * Both spellings are accepted because Tingg's own two products use different
   * ones: the checkout IPN wants `status_code`, and the payout callback wants
   * `statusCode` inside `results`. A merchant serving both endpoints from one
   * handler will send whichever its documentation told it to.
   */
  interpretResponse(result: { status: number | null; body: string | null }): 'delivered' | 'retry' {
    const code = acknowledgementCode(result.body);
    if (code === null) return 'retry';
    return (TINGG_ACKNOWLEDGEMENT_CODES as readonly number[]).includes(code)
      ? 'delivered'
      : 'retry';
  }
}

/**
 * Dig the acknowledgement code out of whatever the subscriber sent back.
 *
 * Exported because the acknowledgement contract is the thing developers come
 * to this adapter to test, and a helper they can unit-test against is worth
 * more than a private method.
 */
export function acknowledgementCode(body: string | null): number | null {
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Tingg cannot read a non-JSON acknowledgement either, and an HTML error
    // page returned with a 200 is a real and common way for this to fail.
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const direct = record.status_code ?? record.statusCode;
  const fromDirect = asCode(direct);
  if (fromDirect !== null) return fromDirect;

  // The payout acknowledgement nests it one level down, in `results`.
  const results = record.results;
  if (Array.isArray(results) && results.length > 0) {
    const first = results[0];
    if (typeof first === 'object' && first !== null) {
      const nested = (first as Record<string, unknown>).statusCode ??
        (first as Record<string, unknown>).status_code;
      return asCode(nested);
    }
  }
  return null;
}

function asCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // Tingg's own IPN documentation types the response `status_code` as a
  // *string*, so "183" has to be accepted as readily as 183.
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}
